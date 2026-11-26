'use strict';

/* ---------------------------------------------------------------------------
 * Quali tabelle tocca DAVVERO uno statement SQL.
 *
 * Estrae TUTTI i nomi di tabella citati in uno statement e pretende che ognuno
 * rientri nello scope. Vale solo per i principal con uno scope attivo sulla
 * connessione.
 *
 * PROPRIETÀ TENUTE PER COSTRUZIONE
 *  1. Nel dubbio si RIFIUTA, non si passa (funzioni tabella, commenti
 *     eseguibili /*! ... *\/, forme non riconducibili a nomi di tabella).
 *  2. Gli identificatori quotati ("user-secrets", `123_tab`) restano token
 *     atomici e non vengono mai spezzati su trattini o cifre iniziali.
 *  3. Le CTE (`WITH x AS (…)`) hanno visibilità limitata al proprio blocco di
 *     parentesi e SOLO DOPO la dichiarazione (mai in query esterne precedenti),
 *     e un riferimento qualificato (`db.x`) non è mai trattato come CTE locale.
 *  4. Le tabelle derivate `FROM (SELECT …) x, altra` e le espressioni
 *     parentesizzate `FROM (segreti)` vengono attraversate completamente.
 * ------------------------------------------------------------------------- */

const { matchesAny } = require('./capabilities');

const INIZIO_ID = /[A-Za-z_À-ÿ]/;
const CORPO_ID = /[A-Za-z0-9_$À-ÿ]/;

function leggiParteId(s, i) {
  const c = s[i];
  if (c === '"' || c === '`' || c === '[') {
    const close = c === '[' ? ']' : c;
    let inner = '';
    i++;
    while (i < s.length) {
      if (s[i] === close) {
        if (s[i + 1] === close) { inner += close; i += 2; continue; }
        i++;
        return { parte: inner, next: i, quotato: true };
      }
      inner += s[i];
      i++;
    }
    return { parte: inner, next: i, quotato: true, nonChiuso: true };
  }
  if (INIZIO_ID.test(c || '')) {
    let j = i;
    while (j < s.length && CORPO_ID.test(s[j])) j++;
    return { parte: s.slice(i, j), next: j, quotato: false };
  }
  return null;
}

/**
 * Tokenizza l'SQL grezzo scartando commenti e stringhe letterali ma conservando
 * ogni identificatore quotato come segmento atomico (anche con `-`, spazi o
 * cifre iniziali) e segnalando commenti eseguibili MySQL/MariaDB.
 */
function tokenizza(sql) {
  const s = String(sql == null ? '' : sql);
  const out = [];
  let executableComment = false;
  let i = 0;

  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];

    if (/\s/.test(c)) { i++; continue; }

    // Commenti
    if (c === '-' && next === '-') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '#' && next !== '>' && next !== '-') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      if (s[i + 2] === '!' || /^M!/i.test(s.slice(i + 2, i + 4))) {
        executableComment = true;
      }
      i += 2;
      let depth = 1;
      while (i < s.length && depth > 0) {
        if (s[i] === '/' && s[i + 1] === '*') { depth++; i += 2; }
        else if (s[i] === '*' && s[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      continue;
    }

    // Dollar-quoting PostgreSQL: $$ … $$ o $tag$ … $tag$
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const end = s.indexOf(tag, i + tag.length);
        i = end < 0 ? s.length : end + tag.length;
        out.push({ tipo: 'altro' });
        continue;
      }
    }

    // Stringhe letterali
    if (c === "'") {
      const prev = s[i - 1];
      const prima = s[i - 2];
      const pgEscape = (prev === 'E' || prev === 'e') && (prima === undefined || !/[A-Za-z0-9_$]/.test(prima));
      i++;
      while (i < s.length) {
        if (pgEscape && s[i] === '\\') { i += 2; continue; }
        if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      out.push({ tipo: 'altro' });
      continue;
    }

    // Identificatori (nudi o quotati, anche qualificati con `.`)
    const primaParte = leggiParteId(s, i);
    if (primaParte) {
      const parti = [primaParte.parte];
      let quotato = primaParte.quotato;
      i = primaParte.next;
      for (;;) {
        let k = i;
        while (k < s.length && /\s/.test(s[k])) k++;
        if (s[k] !== '.') break;
        k++;
        while (k < s.length && /\s/.test(s[k])) k++;
        if (s[k] === '*') { parti.push('*'); i = k + 1; continue; }
        const p = leggiParteId(s, k);
        if (!p) break;
        parti.push(p.parte);
        quotato = quotato || p.quotato;
        i = p.next;
      }
      out.push({ tipo: 'id', valore: parti.join('.'), parti, quotato });
      continue;
    }

    if (c === '(' || c === ')' || c === ',' || c === ';') {
      out.push({ tipo: c });
      i++;
      continue;
    }
    out.push({ tipo: 'altro' });
    i++;
  }

  return { tokens: out, executableComment };
}

// Parole che introducono un nome di tabella. `on` è deliberatamente FUORI:
// in `JOIN b ON a.x = b.y` seguirebbe una colonna qualificata (CREATE INDEX … ON
// è gestito a parte). `update` gestisce anche liste separate da virgole (MySQL).
const INTRODUCE_UNA = new Set(['join', 'into', 'table', 'truncate']);
const INTRODUCE_LISTA = new Set(['from', 'update']);
const SALTA = new Set(['only', 'lateral', 'low_priority', 'high_priority', 'delayed', 'ignore', 'quick']);
const FINE_LISTA = new Set([
  'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'straight_join',
  'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'intersect',
  'except', 'set', 'into', 'returning', 'window', 'for', 'on', 'using', 'as',
  'fetch', 'qualify', 'values',
]);
const FINE_USING_DATI = new Set(['where', 'returning', 'when', 'on', 'order', 'limit']);
const NON_TABELLE = new Set(['select', 'values', 'dual', 'table', 'unnest', 'lateral', 'only', 'exists']);
const INIZIO_SUBQUERY = new Set(['select', 'with', 'values', 'table']);

function eNomeTabella(tok) {
  if (!tok || tok.tipo !== 'id') return false;
  if (tok.quotato) return true;
  const base = tok.valore.toLowerCase();
  return !NON_TABELLE.has(base) && !FINE_LISTA.has(base);
}

/** Trova l'indice della `)` corrispondente alla `(` in `startIdx`, o -1. */
function trovaChiusura(tok, startIdx) {
  let depth = 0;
  for (let k = startIdx; k < tok.length; k++) {
    if (tok[k].tipo === '(') depth++;
    else if (tok[k].tipo === ')') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * Estrae i riferimenti a tabella di uno statement rispettando lo scope reale
 * delle CTE (per profondità di parentesi e ordine di dichiarazione).
 * @returns {{ tabelle: Array<{nome: string, db: string|null, tabella: string}>, nonAnalizzabile: string|null }}
 */
function tabelleCitate(sql) {
  const { tokens: tok, executableComment } = tokenizza(sql);
  const tabelle = [];
  let nonAnalizzabile = executableComment ? 'commenti SQL eseguibili' : null;
  let statementConUsingDati = false;
  let inizioStatement = true;

  // Scope delle CTE per profondità di parentesi: ctePerLivello.get(depth) = Set di nomi.
  const ctePerLivello = new Map();
  let depth = 0;

  const aggiungiCte = (d, nome) => {
    let set = ctePerLivello.get(d);
    if (!set) { set = new Set(); ctePerLivello.set(d, set); }
    set.add(String(nome).toLowerCase());
  };
  const eCteVisibile = (nome) => {
    const key = String(nome).toLowerCase();
    for (let d = depth; d >= 0; d--) {
      const set = ctePerLivello.get(d);
      if (set && set.has(key)) return true;
    }
    return false;
  };
  const pulisciLivelliSopra = (d) => {
    for (const k of [...ctePerLivello.keys()]) {
      if (k > d) ctePerLivello.delete(k);
    }
  };

  // Quando incontriamo `WITH`, registriamo i nomi delle CTE definite in quel
  // blocco PRIMA che venga scandita la query principale allo stesso livello
  // (e anche visibili al proprio corpo per `WITH RECURSIVE`), ma MAI prima
  // del token `WITH` né fuori dal suo livello di parentesi `depth`.
  const registraCteDelWith = (withIdx, withDepth) => {
    let k = withIdx + 1;
    if (tok[k] && tok[k].tipo === 'id' && !tok[k].quotato && tok[k].valore.toLowerCase() === 'recursive') k++;
    for (;;) {
      if (!tok[k] || tok[k].tipo !== 'id') break;
      const nomeCte = tok[k].valore;
      k++;
      // Lista opzionale di colonne: `WITH x(a, b) AS (...)`
      if (tok[k] && tok[k].tipo === '(') {
        const fineCols = trovaChiusura(tok, k);
        if (fineCols < 0) break;
        k = fineCols + 1;
      }
      if (!tok[k] || tok[k].tipo !== 'id' || tok[k].quotato || tok[k].valore.toLowerCase() !== 'as') break;
      k++;
      // Modificatori opzionali PG: `[NOT] MATERIALIZED`
      if (tok[k] && tok[k].tipo === 'id' && !tok[k].quotato && tok[k].valore.toLowerCase() === 'not') k++;
      if (tok[k] && tok[k].tipo === 'id' && !tok[k].quotato && tok[k].valore.toLowerCase() === 'materialized') k++;
      if (!tok[k] || tok[k].tipo !== '(') break;
      aggiungiCte(withDepth, nomeCte);
      const fineCorpo = trovaChiusura(tok, k);
      if (fineCorpo < 0) break;
      k = fineCorpo + 1;
      if (tok[k] && tok[k].tipo === ',') { k++; continue; }
      break;
    }
  };

  const registra = (tokNome) => {
    const parti = tokNome.parti || tokNome.valore.split('.');
    const tabella = parti[parti.length - 1];
    const db = parti.length > 1 ? parti[parti.length - 2] : null;
    // Un riferimento qualificato (db.tabella) non è mai una CTE locale.
    if (db == null && eCteVisibile(tabella)) return;
    tabelle.push({ nome: tokNome.valore, db, tabella });
  };

  // Analizza il primo nome (ed eventuali ulteriori tabelle separate da `,` allo
  // stesso livello) dopo `FROM` o `UPDATE`. Ritorna il nuovo indice `i` solo se
  // non ci sono parentesi che richiedono al loop principale di entrarvi.
  const analizzaListaTabelle = (startJ, isUpdate) => {
    let j = startJ;
    for (;;) {
      while (j < tok.length && tok[j].tipo === 'id' && !tok[j].quotato && SALTA.has(tok[j].valore.toLowerCase())) j++;
      if (!tok[j]) break;
      if (tok[j].tipo === '(') {
        const fine = trovaChiusura(tok, j);
        // Controlla se dentro `(...)` c'è una subquery o una tabella/join parentesizzata.
        let inner = j + 1;
        while (tok[inner] && tok[inner].tipo === '(') inner++;
        const primaParola = tok[inner] && tok[inner].tipo === 'id' && !tok[inner].quotato
          ? tok[inner].valore.toLowerCase() : '';
        if (tok[inner] && !INIZIO_SUBQUERY.has(primaParola) && eNomeTabella(tok[inner])) {
          // Es. `FROM (segreti)` o `FROM (a JOIN segreti ON ...)`: registra subito
          // il primo nome (eventuali JOIN interni saranno visti dal ciclo esterno).
          if (tok[inner + 1] && tok[inner + 1].tipo === '(') {
            nonAnalizzabile = nonAnalizzabile || `la funzione tabella "${tok[inner].valore}"`;
          } else {
            registra(tok[inner]);
          }
        }
        if (fine < 0) break;
        // Salta la `(...)` e l'eventuale alias per raggiungere un'eventuale `, tabella2`
        // dopo la tabella derivata (il contenuto interno sarà comunque scandito dal loop principale!).
        j = fine + 1;
        while (tok[j] && tok[j].tipo !== ',' && !(tok[j].tipo === 'id' && !tok[j].quotato && FINE_LISTA.has(tok[j].valore.toLowerCase()))) {
          if (tok[j].tipo === '(' || tok[j].tipo === ')' || tok[j].tipo === ';') break;
          j++;
        }
        if (tok[j] && tok[j].tipo === ',') { j++; continue; }
        break;
      }
      if (!eNomeTabella(tok[j])) break;
      if (!isUpdate && tok[j + 1] && tok[j + 1].tipo === '(') {
        nonAnalizzabile = nonAnalizzabile || `la funzione tabella "${tok[j].valore}"`;
        break;
      }
      registra(tok[j]);
      j++;
      while (tok[j] && tok[j].tipo !== ',' && !(tok[j].tipo === 'id' && !tok[j].quotato && FINE_LISTA.has(tok[j].valore.toLowerCase()))) {
        if (tok[j].tipo === '(' || tok[j].tipo === ')' || tok[j].tipo === ';') break;
        j++;
      }
      if (tok[j] && tok[j].tipo === ',') { j++; continue; }
      break;
    }
  };

  const testa = tok.slice(0, 4).filter((t) => t.tipo === 'id').map((t) => t.valore.toLowerCase()).join(' ');
  const indiceConOn = /^(create (unique )?index|drop index|alter index|reindex)/.test(testa);

  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (t.tipo === '(') { depth++; continue; }
    if (t.tipo === ')') {
      depth = Math.max(0, depth - 1);
      pulisciLivelliSopra(depth);
      continue;
    }
    if (t.tipo === ';') {
      statementConUsingDati = false;
      inizioStatement = true;
      ctePerLivello.clear();
      depth = 0;
      continue;
    }
    if (t.tipo !== 'id') { inizioStatement = false; continue; }
    if (t.quotato) { inizioStatement = false; continue; }

    const parola = t.valore.toLowerCase();
    const eraInizio = inizioStatement;
    inizioStatement = false;

    if (parola === 'with') {
      registraCteDelWith(i, depth);
      continue;
    }

    if (eraInizio && (parola === 'describe' || parola === 'desc')) {
      const next = tok[i + 1];
      if (eNomeTabella(next)) { registra(next); i++; }
      else if (next) nonAnalizzabile = nonAnalizzabile || 'il bersaglio di DESCRIBE';
      continue;
    }

    if (parola === 'insert') {
      // MySQL ammette `INSERT [LOW_PRIORITY|DELAYED|HIGH_PRIORITY] [IGNORE] tbl ...` senza `INTO`.
      let j = i + 1;
      while (j < tok.length && tok[j].tipo === 'id' && !tok[j].quotato && SALTA.has(tok[j].valore.toLowerCase())) j++;
      if (tok[j] && tok[j].tipo === 'id' && !tok[j].quotato && tok[j].valore.toLowerCase() === 'into') {
        continue; // verrà gestito dal ramo `into`
      }
      if (eNomeTabella(tok[j])) { registra(tok[j]); i = j; }
      continue;
    }

    if (parola === 'delete' || parola === 'merge') statementConUsingDati = true;
    if (statementConUsingDati && FINE_USING_DATI.has(parola)) {
      statementConUsingDati = false;
    }

    if (parola === 'using' && statementConUsingDati) {
      statementConUsingDati = false;
      let j = i + 1;
      while (j < tok.length && tok[j].tipo === 'id' && !tok[j].quotato && SALTA.has(tok[j].valore.toLowerCase())) j++;
      if (tok[j] && tok[j].tipo === '(') continue;
      if (!eNomeTabella(tok[j])) {
        nonAnalizzabile = nonAnalizzabile || 'il bersaglio di USING non è un nome di tabella';
        continue;
      }
      if (tok[j + 1] && tok[j + 1].tipo === '(') {
        nonAnalizzabile = nonAnalizzabile || `la funzione tabella "${tok[j].valore}" in USING`;
        continue;
      }
      registra(tok[j]);
      j++;
      for (;;) {
        while (tok[j] && tok[j].tipo !== ','
          && !(tok[j].tipo === 'id' && !tok[j].quotato && FINE_LISTA.has(tok[j].valore.toLowerCase()))) j++;
        if (!tok[j] || tok[j].tipo !== ',') break;
        j++;
        while (j < tok.length && tok[j].tipo === 'id' && !tok[j].quotato && SALTA.has(tok[j].valore.toLowerCase())) j++;
        if (!eNomeTabella(tok[j])) {
          nonAnalizzabile = nonAnalizzabile || 'un elemento della lista USING non è un nome di tabella';
          break;
        }
        if (tok[j + 1] && tok[j + 1].tipo === '(') {
          nonAnalizzabile = nonAnalizzabile || `la funzione tabella "${tok[j].valore}" in USING`;
          break;
        }
        registra(tok[j]);
        j++;
      }
      i = Math.max(i, j - 1);
      continue;
    }

    if (indiceConOn && parola === 'on') {
      let j = i + 1;
      while (j < tok.length && tok[j].tipo === 'id' && !tok[j].quotato && SALTA.has(tok[j].valore.toLowerCase())) j++;
      if (eNomeTabella(tok[j])) registra(tok[j]);
      else nonAnalizzabile = nonAnalizzabile || 'il bersaglio di ON non è un nome di tabella';
      i = j;
      continue;
    }

    if (INTRODUCE_UNA.has(parola)) {
      let j = i + 1;
      while (j < tok.length && tok[j].tipo === 'id' && !tok[j].quotato && SALTA.has(tok[j].valore.toLowerCase())) j++;
      if (tok[j] && tok[j].tipo === '(') {
        // Es. `JOIN (segreti)` o `JOIN (a JOIN b ...)`: se dentro non c'è una subquery,
        // registra la prima tabella parentesizzata.
        let inner = j + 1;
        while (tok[inner] && tok[inner].tipo === '(') inner++;
        const primaParola = tok[inner] && tok[inner].tipo === 'id' && !tok[inner].quotato
          ? tok[inner].valore.toLowerCase() : '';
        if (tok[inner] && !INIZIO_SUBQUERY.has(primaParola) && eNomeTabella(tok[inner])) {
          registra(tok[inner]);
        }
        continue;
      }
      if (!eNomeTabella(tok[j])) continue;
      registra(tok[j]);
      i = j;
      continue;
    }

    if (INTRODUCE_LISTA.has(parola)) {
      analizzaListaTabelle(i + 1, parola === 'update');
      continue;
    }
  }

  return { tabelle, nonAnalizzabile };
}

/**
 * Pretende che ogni tabella citata rientri nello scope del principal.
 * Da chiamare SOLO quando uno scope è attivo (vedi guardStrategy).
 *
 * @param {string} sql testo SQL grezzo (payload.pipeline)
 * @param {{databases?: string[], collections?: string[]}} scope
 * @param {string|null} dbCorrente database/schema aperto, per i nomi non qualificati
 */
function assertTabelleNelloScope(sql, scope, dbCorrente) {
  const testo = String(sql == null ? '' : sql).trim();
  if (!testo || !scope) return;

  const rifiuta = (motivo) => {
    throw new Error(
      `Query non consentita: ${motivo}. Il tuo utente ha un ambito limitato a specifici ` +
      'database e tabelle, e su SQL libero l\'ambito viene verificato sui nomi citati nella query. ' +
      'Cosa fare: limita la query alle tabelle del tuo ambito, oppure chiedi all\'amministratore ' +
      'un accesso senza limiti di ambito.'
    );
  };

  const { tabelle, nonAnalizzabile } = tabelleCitate(testo);
  if (nonAnalizzabile) rifiuta(`non è possibile verificare l'ambito di ${nonAnalizzabile}`);

  for (const rif of tabelle) {
    if (!matchesAny(scope.collections, rif.tabella)) {
      rifiuta(`la tabella "${rif.nome}" è fuori dal tuo ambito`);
    }
    const db = rif.db || dbCorrente;
    if (db != null && !matchesAny(scope.databases, db)) {
      rifiuta(`il database/schema "${db}" di "${rif.nome}" è fuori dal tuo ambito`);
    }
  }
}

module.exports = { tabelleCitate, assertTabelleNelloScope };

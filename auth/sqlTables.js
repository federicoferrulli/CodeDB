'use strict';

/* ---------------------------------------------------------------------------
 * Quali tabelle tocca DAVVERO uno statement SQL.
 *
 * Sull'SQL Raw lo scope dei permessi era applicato a un bersaglio DEDOTTO: una
 * regex sul primo `FROM` del testo (server.js) e, quando non trovava nulla, il
 * `coll` scelto dal CLIENT. Quel valore diventava l'argomento su cui il Proxy
 * confrontava lo scope, ma la stringa SQL veniva poi eseguita verbatim — le
 * strategie SQL ignorano l'argomento `coll` e usano `db` solo per una `USE`.
 * Da lì due uscite dal perimetro, entrambe con una sola richiesta:
 *
 *   SELECT * FROM ordini JOIN utenti ON 1=1     → il primo FROM è "ordini"
 *   UPDATE utenti SET ruolo = 'admin'           → nessun FROM: vince il client
 *
 * `assertScopedClauses` (auth/sqlClause.js) non copriva il caso: ispeziona
 * `filter` e `sort` della griglia, non il testo di SQL Raw.
 *
 * Qui si estraggono TUTTI i nomi di tabella citati e si pretende che ognuno
 * rientri nello scope. Vale la stessa regola di sqlClause.js: si applica **solo
 * ai principal con uno scope attivo** sulla connessione, quindi owner e
 * sottoutenti senza scope non perdono nulla di ciò che fanno oggi.
 *
 * DUE PROPRIETÀ TENUTE PER COSTRUZIONE
 *  1. Nel dubbio si RIFIUTA, non si passa. Una forma che l'analizzatore non sa
 *     ricondurre a un nome (funzione tabella, `EXECUTE` di testo costruito) è
 *     un rifiuto con un messaggio che dice cosa fare, non un permesso implicito.
 *  2. Un nome dichiarato NELLA query non è una tabella: le CTE (`WITH x AS (…)`)
 *     e le tabelle derivate sono alias locali. Ammetterli non apre nulla —
 *     quello che c'è DENTRO la CTE viene analizzato comunque, perché la scansione
 *     è lineare su tutto il testo.
 *
 * Resta un filtro sintattico, non una barriera assoluta: la protezione solida è
 * aprire le connessioni dei sottoutenti con un utente DBMS a privilegi ridotti,
 * e il messaggio d'errore lo dice invece di limitarsi a negare.
 * ------------------------------------------------------------------------- */

const { stripSqlNoise } = require('../db/sqlText');
const { matchesAny } = require('./capabilities');

const INIZIO_ID = /[A-Za-z_À-￿]/;
const CORPO_ID = /[A-Za-z0-9_$À-￿]/;

/**
 * Tokenizza il testo già ripulito da commenti e stringhe.
 * Gli identificatori qualificati (`db.schema.tabella`) restano un token solo:
 * separarli perderebbe proprio l'informazione che serve allo scope.
 */
function tokenizza(testo) {
  const s = String(testo);
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (INIZIO_ID.test(c)) {
      let j = i;
      while (j < s.length && CORPO_ID.test(s[j])) j++;
      let nome = s.slice(i, j);
      i = j;
      // Parti qualificate: il punto può avere spazi attorno.
      for (;;) {
        let k = i;
        while (k < s.length && /\s/.test(s[k])) k++;
        if (s[k] !== '.') break;
        k++;
        while (k < s.length && /\s/.test(s[k])) k++;
        if (s[k] === '*') { nome += '.*'; i = k + 1; continue; }
        if (!INIZIO_ID.test(s[k] || '')) break;
        let m = k;
        while (m < s.length && CORPO_ID.test(s[m])) m++;
        nome += `.${s.slice(k, m)}`;
        i = m;
      }
      out.push({ tipo: 'id', valore: nome });
      continue;
    }
    if (c === '(' || c === ')' || c === ',' || c === ';') { out.push({ tipo: c }); i++; continue; }
    out.push({ tipo: 'altro' });
    i++;
  }
  return out;
}

// Parole che introducono un nome di tabella. `on` è deliberatamente FUORI:
// in `JOIN b ON a.x = b.y` seguirebbe una colonna qualificata, che verrebbe
// scambiata per una tabella (il caso CREATE INDEX … ON è gestito a parte).
const INTRODUCE_UNA = new Set(['join', 'into', 'update', 'table', 'truncate']);
// Dopo FROM può esserci una LISTA separata da virgole: `FROM a, b`.
const INTRODUCE_LISTA = 'from';
// Modificatori che stanno fra la keyword e il nome.
const SALTA = new Set(['only', 'lateral']);
// Parole che chiudono l'elenco delle tabelle di un FROM.
const FINE_LISTA = new Set([
  'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'straight_join',
  'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'intersect',
  'except', 'set', 'into', 'returning', 'window', 'for', 'on', 'using', 'as',
  'fetch', 'qualify',
]);
const FINE_USING_DATI = new Set(['where', 'returning', 'when', 'on', 'order', 'limit']);
// Nomi che compaiono dopo un introduttore ma non sono tabelle.
const NON_TABELLE = new Set(['select', 'values', 'dual', 'table', 'unnest', 'lateral', 'only', 'exists']);

/**
 * Nomi dichiarati dentro la query stessa: CTE (`WITH x AS (…)`, `, y AS (…)`) e
 * alias di tabelle derivate. Riconosciuti dalla forma `identificatore AS (`.
 * Ammetterli è corretto, non una scorciatoia: si riferiscono a un risultato
 * calcolato nella query, e il contenuto della CTE è analizzato lo stesso.
 */
function nomiLocali(tok) {
  const locali = new Set();
  for (let i = 0; i + 2 < tok.length; i++) {
    if (tok[i].tipo !== 'id') continue;
    if (tok[i + 1].tipo !== 'id' || tok[i + 1].valore.toLowerCase() !== 'as') continue;
    if (tok[i + 2].tipo !== '(') continue;
    locali.add(tok[i].valore.toLowerCase());
  }
  return locali;
}

/** Il token è un identificatore utilizzabile come nome di tabella? */
function eNomeTabella(tok) {
  if (!tok || tok.tipo !== 'id') return false;
  const base = tok.valore.toLowerCase();
  return !NON_TABELLE.has(base) && !FINE_LISTA.has(base);
}

/**
 * Estrae i riferimenti a tabella di uno statement.
 * @returns {{ tabelle: Array<{nome: string, db: string|null, tabella: string}>, nonAnalizzabile: string|null }}
 */
function tabelleCitate(sql) {
  const tok = tokenizza(stripSqlNoise(sql, { keepIdentifiers: true }));
  const locali = nomiLocali(tok);
  const tabelle = [];
  let nonAnalizzabile = null;
  // PostgreSQL DELETE e SQL standard MERGE introducono ulteriori sorgenti con
  // USING. Non va confuso con `JOIN ... USING (colonna)`, dove USING è seguito
  // da una parentesi e NON nomina una tabella.
  let statementConUsingDati = false;

  const registra = (tokNome, permettiListaColonne) => {
    const nome = tokNome.valore;
    if (locali.has(nome.toLowerCase())) return;
    const parti = nome.split('.');
    const tabella = parti[parti.length - 1];
    const db = parti.length > 1 ? parti[parti.length - 2] : null;
    tabelle.push({ nome, db, tabella });
    return permettiListaColonne;
  };

  // `CREATE [UNIQUE] INDEX … ON tabella (…)`: qui `ON` introduce una tabella,
  // al contrario di quanto fa in una JOIN. Si tratta a parte invece di
  // aggiungere `on` agli introduttori, che romperebbe ogni JOIN.
  const testa = tok.slice(0, 4).filter((t) => t.tipo === 'id').map((t) => t.valore.toLowerCase()).join(' ');
  const indiceConOn = /^(create (unique )?index|drop index|alter index|reindex)/.test(testa);

  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (t.tipo === ';') { statementConUsingDati = false; continue; }
    if (t.tipo !== 'id') continue;
    const parola = t.valore.toLowerCase();

    if (parola === 'delete' || parola === 'merge') statementConUsingDati = true;
    if (statementConUsingDati && FINE_USING_DATI.has(parola)) {
      statementConUsingDati = false;
    }

    if (parola === 'using' && statementConUsingDati) {
      // Una sola clausola USING introduce le sorgenti; gli eventuali USING
      // successivi appartengono ai JOIN contenuti nella clausola stessa.
      statementConUsingDati = false;
      let j = i + 1;
      while (j < tok.length && tok[j].tipo === 'id' && SALTA.has(tok[j].valore.toLowerCase())) j++;
      // JOIN ... USING (colonna) e sorgenti derivate `USING (SELECT ...)`:
      // nessun nome immediato. La SELECT interna verrà comunque scandita.
      if (tok[j] && tok[j].tipo === '(') continue;
      if (!eNomeTabella(tok[j])) {
        nonAnalizzabile = nonAnalizzabile || 'il bersaglio di USING non è un nome di tabella';
        continue;
      }
      // `USING funzione_tabella(...)`: il risultato può leggere qualunque
      // oggetto e non ha un nome confrontabile con lo scope.
      if (tok[j + 1] && tok[j + 1].tipo === '(') {
        nonAnalizzabile = nonAnalizzabile || `la funzione tabella "${tok[j].valore}" in USING`;
        continue;
      }
      registra(tok[j]);
      j++;
      // DELETE ... USING ammette una lista separata da virgole. MERGE ne usa
      // una sola, ma lo stesso ciclo è conservativo e copre entrambi.
      for (;;) {
        while (tok[j] && tok[j].tipo !== ','
          && !(tok[j].tipo === 'id' && FINE_LISTA.has(tok[j].valore.toLowerCase()))) j++;
        if (!tok[j] || tok[j].tipo !== ',') break;
        j++;
        while (j < tok.length && tok[j].tipo === 'id' && SALTA.has(tok[j].valore.toLowerCase())) j++;
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
      while (j < tok.length && tok[j].tipo === 'id' && SALTA.has(tok[j].valore.toLowerCase())) j++;
      if (eNomeTabella(tok[j])) registra(tok[j]);
      else nonAnalizzabile = nonAnalizzabile || 'il bersaglio di ON non è un nome di tabella';
      i = j;
      continue;
    }

    if (INTRODUCE_UNA.has(parola)) {
      // `INSERT INTO t (col, …)` e `CREATE TABLE t (…)`: qui la parentesi dopo
      // il nome è l'elenco delle colonne, non una chiamata di funzione.
      let j = i + 1;
      while (j < tok.length && tok[j].tipo === 'id' && SALTA.has(tok[j].valore.toLowerCase())) j++;
      if (tok[j] && tok[j].tipo === '(') continue;      // sotto-query o elenco
      if (!eNomeTabella(tok[j])) continue;              // `INTO @var`, `TRUNCATE TABLE …`
      registra(tok[j]);
      i = j;
      continue;
    }

    if (parola === INTRODUCE_LISTA) {
      let j = i + 1;
      for (;;) {
        while (j < tok.length && tok[j].tipo === 'id' && SALTA.has(tok[j].valore.toLowerCase())) j++;
        if (!tok[j]) break;
        if (tok[j].tipo === '(') break;                 // tabella derivata: la si analizza dall'interno
        if (!eNomeTabella(tok[j])) break;
        // Un nome seguito da `(` dopo FROM è una FUNZIONE TABELLA
        // (`FROM generate_series(…)`): non se ne può verificare lo scope.
        if (tok[j + 1] && tok[j + 1].tipo === '(') {
          nonAnalizzabile = nonAnalizzabile || `la funzione tabella "${tok[j].valore}"`;
          break;
        }
        registra(tok[j]);
        j++;
        // Salta l'alias e arriva alla virgola successiva, se la lista continua.
        while (tok[j] && tok[j].tipo !== ',' && !(tok[j].tipo === 'id' && FINE_LISTA.has(tok[j].valore.toLowerCase()))) {
          if (tok[j].tipo === '(' || tok[j].tipo === ')' || tok[j].tipo === ';') break;
          j++;
        }
        if (tok[j] && tok[j].tipo === ',') { j++; continue; }
        break;
      }
      i = j - 1 > i ? j - 1 : i;
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
    // Nome qualificato: anche il database/schema indicato deve rientrare.
    // Un nome NON qualificato si risolve nel database aperto, che il Proxy ha
    // già confrontato con lo scope.
    const db = rif.db || dbCorrente;
    if (db != null && !matchesAny(scope.databases, db)) {
      rifiuta(`il database/schema "${db}" di "${rif.nome}" è fuori dal tuo ambito`);
    }
  }
}

module.exports = { tabelleCitate, assertTabelleNelloScope };

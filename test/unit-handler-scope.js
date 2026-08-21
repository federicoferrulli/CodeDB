'use strict';

/* ---------------------------------------------------------------------------
 * `sess` o `session`? — controllo statico sugli handler socket (CDB-A70).
 *
 * In `server.js` la sessione di un tab ha DUE nomi a seconda dell'handler:
 * `sess` in `delegate`, `collection:watch`, `db:sessions`, `backup:*`, e
 * `session` in `query:execute`, `script:*`. È una convenienza storica innocua
 * finché si scrive il nome giusto — e infatti in `script:execute` era finito
 * `sess.dbType` dentro un handler che dichiara `session`: in 'use strict' un
 * ReferenceError, cioè l'INTERO runner di script morto a ogni invocazione, con
 * il testo grezzo dell'errore JavaScript mostrato all'utente.
 *
 * È vissuto senza che nulla lo segnalasse perché quel percorso non ha alcun
 * test: `test/e2e-script-runner.js` richiede un MongoDB, e le suite unitarie
 * provano `ScriptRunner` (che non conosce le sessioni) ma non il gestore che lo
 * avvia. Riprodurre il difetto davvero richiederebbe un socket, una sessione DB
 * viva e un database: lo stesso motivo per cui `unit-scritture-bersaglio.js` è
 * un controllo STATICO, ed è la strada presa anche qui.
 *
 * COSA VERIFICA: per ogni handler registrato con `safeOn('evento', …)`, se il
 * corpo usa `sess` o `session`, quel nome dev'essere legato nello stesso corpo
 * (dichiarazione o parametro). Non è un'analisi di scope completa — è il
 * controesempio esatto, e il costo di sbagliarsi è una funzionalità morta.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SORGENTE = path.join(__dirname, '..', 'server.js');
const testo = fs.readFileSync(SORGENTE, 'utf8');

/**
 * Indice della graffa che chiude quella aperta in `apertura`, saltando
 * stringhe, template literal, commenti e literal di espressione regolare — che
 * in `server.js` contengono graffe in abbondanza (`{ ok: false }` nei messaggi,
 * `/riga \d+/`, i template dei log).
 */
function fineBlocco(s, apertura) {
  let profondita = 0;
  let precedenteSignificativo = '';
  for (let i = apertura; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];

    if (c === '/' && next === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }

    if (c === "'" || c === '"' || c === '`') {
      const chiusura = c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === chiusura) break;
        // Interpolazione `${…}`: può contenere graffe e altre stringhe, ma per
        // il conteggio basta attraversarla come testo — le sue graffe sono
        // bilanciate fra loro.
        i++;
      }
      precedenteSignificativo = chiusura;
      continue;
    }

    // Literal di espressione regolare: `/` è divisione quando segue un valore,
    // apertura di regex quando segue un operatore o una parentesi.
    if (c === '/' && !')]}'.includes(precedenteSignificativo) && !/[A-Za-z0-9_$]/.test(precedenteSignificativo)) {
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '[') { while (i < s.length && s[i] !== ']') { if (s[i] === '\\') i++; i++; } }
        if (s[i] === '/') break;
        if (s[i] === '\n') break; // non era una regex: divisione
        i++;
      }
      precedenteSignificativo = '/';
      continue;
    }

    if (c === '{') profondita++;
    if (c === '}') {
      profondita--;
      if (profondita === 0) return i;
    }
    if (!/\s/.test(c)) precedenteSignificativo = c;
  }
  return -1;
}

/**
 * Handler registrati su una delle giunture: nome dell'evento e corpo.
 *
 * Sono le tre famiglie di ADR-0001 — evento sui dati (`delegate`), evento
 * amministrativo (`amministrativo`), operazione lunga (`operazioneLunga`) —
 * più la via generica (`safeOn`), che resta per i pochi eventi che non
 * appartengono a nessuna delle tre.
 *
 * Riconoscerne una sola lascerebbe scoperta la maggior parte degli handler
 * senza che nulla lo dica, ed è esattamente quello che è successo mentre le
 * famiglie prendevano la loro giuntura: il conteggio è crollato da 44 a 18. Se
 * ne sono accorte le due asserzioni qui sotto — «troppo pochi» e la presenza di
 * `script:execute`, che è l'handler in cui il difetto originale è vissuto.
 * Vale la pena notarlo: sono guardie messe contro il marcire del test stesso, e
 * hanno fatto esattamente il loro lavoro.
 */
function handlerSocket(s) {
  const out = [];
  const re = /\b(?:safeOn|delegate|amministrativo|operazioneLunga)\(\s*['"]([^'"]+)['"]\s*,/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const apertura = s.indexOf('{', m.index + m[0].length);
    if (apertura < 0) continue;
    const fine = fineBlocco(s, apertura);
    if (fine < 0) continue;
    out.push({ evento: m[1], corpo: s.slice(apertura, fine + 1), riga: s.slice(0, m.index).split('\n').length });
  }
  return out;
}

const NOMI = ['sess', 'session'];

const usato = (corpo, nome) => new RegExp(`\\b${nome}\\s*(\\.|\\[|\\))`).test(corpo);
const legato = (corpo, nome) => new RegExp(
  // dichiarazione, assegnazione, oppure parametro di una funzione/arrow
  `(\\b(const|let|var)\\s+${nome}\\b)`
  + `|(\\b${nome}\\s*=[^=])`
  + `|(\\(\\s*[^)]*\\b${nome}\\b[^)]*\\)\\s*=>)`
  + `|(function\\s*[A-Za-z0-9_$]*\\s*\\([^)]*\\b${nome}\\b)`
).test(corpo);

{
  const handlers = handlerSocket(testo);
  // Se il riconoscimento si rompe (refactor del file), il test deve fallire
  // rumorosamente invece di passare per non aver trovato nulla da controllare.
  assert.ok(handlers.length >= 20,
    `Handler socket riconosciuti: ${handlers.length}. Troppo pochi: il riconoscimento è da aggiornare.`);
  assert.ok(handlers.some((h) => h.evento === 'script:execute'),
    'handler script:execute non riconosciuto: il controllo non starebbe guardando il punto che lo ha motivato');

  const rotti = [];
  for (const h of handlers) {
    for (const nome of NOMI) {
      if (usato(h.corpo, nome) && !legato(h.corpo, nome)) {
        rotti.push(`${h.evento} (server.js:${h.riga}) usa "${nome}" senza dichiararlo`);
      }
    }
  }
  assert.deepStrictEqual(rotti, [],
    'Handler che leggono una sessione con il nome sbagliato:\n  ' + rotti.join('\n  '));
  console.log(`  OK   ${handlers.length} handler socket: nessuno legge una sessione non dichiarata (CDB-A70)`);
}

// Controprova: il controllo deve saper FALLIRE. Senza, passerebbe anche se le
// espressioni regolari smettessero di riconoscere qualcosa — che è esattamente
// il modo in cui un test statico marcisce senza dare segno.
{
  const finto = `{
    const tabId = normTabId(payload.tabId);
    const session = sessions.get(tabId);
    const dialetto = { backslashEscape: (sess.dbType || '') === 'mysql' };
  }`;
  assert.ok(usato(finto, 'sess'), 'il difetto reale di CDB-A70 deve risultare "usato"');
  assert.ok(!legato(finto, 'sess'), 'il difetto reale di CDB-A70 deve risultare "non legato"');
  assert.ok(legato(finto, 'session'), '"session" è dichiarata: deve risultare legata');
  console.log('  OK   Il controllo riconosce il difetto originale (controprova)');
}

console.log('\nTutti i test sugli handler socket superati!');

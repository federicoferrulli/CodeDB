'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari del trasporto del frontend (public/js/trasporto.js).
 *
 * Tre comportamenti che nessun chiamante deve rifare, e che finora nessun test
 * proteggeva — il modulo si limitava a raccontarli nei commenti:
 *
 *  1. la riconnessione automatica, e **solo** per le connessioni salvate;
 *  2. l'annullamento quando il tab d'origine viene chiuso, compreso il caso in
 *     cui era già chiuso alla partenza;
 *  3. la marcatura dell'origine (`_tab`, `_state`), che permette a una risposta
 *     di sapere se il suo tab è ancora quello attivo.
 *
 * Nei commenti del modulo sono registrati tre difetti già corretti, e nessuno
 * dei tre aveva un test che ne impedisse il ritorno: il `tabId` indefinito che
 * cancellava quello iniettato, il tab orfano, e la funzione fire-and-forget
 * che si chiamava `notify` — nome indistinguibile da una notifica all'utente,
 * al punto che in graph3d.js era stata usata per una trentina di messaggi che
 * quindi non comparivano mai, mentre il testo italiano finiva sul socket come
 * NOME DI EVENTO. Ognuno ha ora la sua prova.
 *
 * Nessun server: il socket è finto (`test/socket-finto.js`), installato con
 * `impostaSocket` — il punto d'innesto che esiste perché il socket non viene
 * più aperto al caricamento del modulo.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { SocketFinto } = require('./socket-finto');

let falliti = 0;
async function prova(nome, fn) {
  try {
    await fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err.message}`);
  }
}

// Il trasporto ascolta `codedb:tab-closed` su `window`. Fuori dal browser basta
// un EventTarget: non si sta provando il DOM, si sta provando chi lo usa.
function preparaFinestra() {
  if (typeof globalThis.window === 'undefined') globalThis.window = new EventTarget();
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = { querySelector: () => null };
  }
}

const modulo = (nome) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', nome)).href;

module.exports = (async () => {
  preparaFinestra();

  const { impostaSocket } = await import(modulo('socket.js'));
  const trasporto = await import(modulo('trasporto.js'));
  const tabsMod = await import(modulo('tabs.js'));
  const { emit, emitFireAndForget, isForActiveTab } = trasporto;
  const { tabs, createTab, closeTab, switchTab } = tabsMod;

  console.log('  --- Trasporto del frontend (public/js/trasporto.js) ---');

  /** Ambiente pulito: nessun tab, socket finto nuovo. */
  function scena() {
    for (const t of [...tabs.list]) { tabs.list.length = 0; void t; }
    tabs.activeId = null;
    const finto = new SocketFinto();
    impostaSocket(finto);
    return finto;
  }

  function apriTab(opts = {}) {
    const tab = createTab({ id: opts.id, connName: opts.connName });
    if (opts.connCfg) tab.connCfg = opts.connCfg;
    tabs.activeId = tab.id;
    return tab;
  }

  /* --- Il tab della richiesta --------------------------------------------- */

  await prova('la richiesta porta il tabId del tab attivo', async () => {
    const finto = scena();
    const tab = apriTab();
    finto.rispondiA('db:list', { ok: true, databases: ['app'] });
    const res = await emit('db:list', {});
    assert.strictEqual(finto.ultimoPayload('db:list').tabId, tab.id);
    assert.deepStrictEqual(res.databases, ['app']);
  });

  await prova('DIFETTO 1 — un tabId esplicito ma indefinito non cancella quello iniettato', async () => {
    // Diverse modali passano `tabId` esplicito ma `undefined` quando non hanno
    // un contesto (insert.js con `insertContext = null`). Con lo spread del
    // payload messo per ULTIMO quell'undefined sovrascriveva il tabId
    // iniettato, il server ripiegava sulla sessione "default" e rispondeva
    // «Nessuna connessione attiva al database.».
    const finto = scena();
    const tab = apriTab();
    finto.rispondiA('collection:find', { ok: true, docs: [] });
    await emit('collection:find', { tabId: undefined, db: 'app', coll: 'utenti' });
    assert.strictEqual(finto.ultimoPayload('collection:find').tabId, tab.id,
      'il tabId iniettato deve sopravvivere all\'undefined del chiamante');
  });

  await prova('un tabId esplicito e VALIDO ha invece la precedenza', async () => {
    // Split view e modali con contesto esplicito: `_tab`/`_state` devono
    // descrivere il tab realmente interrogato.
    const finto = scena();
    const primo = apriTab();
    const secondo = apriTab();
    switchTab(primo.id);
    finto.rispondiA('collection:find', { ok: true, docs: [] });
    const res = await emit('collection:find', { tabId: secondo.id });
    assert.strictEqual(finto.ultimoPayload('collection:find').tabId, secondo.id);
    assert.strictEqual(res._tab, secondo, 'la risposta descrive il tab interrogato');
    assert.strictEqual(res._state, secondo.state);
  });

  await prova('la risposta porta origine e stato, e sa se il tab è ancora attivo', async () => {
    const finto = scena();
    const a = apriTab();
    const b = apriTab();
    switchTab(a.id);
    finto.rispondiA('collection:find', { ok: true, docs: [1] });
    const res = await emit('collection:find', {});
    assert.strictEqual(res._tab, a);
    assert.strictEqual(res._state, a.state, 'lo stato è quello del tab, non il Proxy globale');
    assert.strictEqual(isForActiveTab(res), true);
    switchTab(b.id);
    assert.strictEqual(isForActiveTab(res), false,
      'cambiando tab la risposta non riguarda più ciò che si guarda');
  });

  /* --- DIFETTO 2: il tab orfano ------------------------------------------- */

  await prova('DIFETTO 2 — tab già chiuso alla partenza: errore attribuito all\'origine', async () => {
    // Se il chiamante porta il tabId di un tab già chiuso, l'errore non deve
    // comparire nel workspace di un'ALTRA connessione: `isForActiveTab` deve
    // risultare falso, e per questo l'origine viene conservata in un sentinella.
    const finto = scena();
    apriTab();
    await assert.rejects(
      () => emit('collection:find', { tabId: 'tab-mai-esistito' }),
      (err) => {
        assert.strictEqual(err.code, 'TAB_CLOSED');
        assert.ok(err._tab && err._tab.orphan, 'l\'origine orfana va conservata');
        assert.strictEqual(err._tab.id, 'tab-mai-esistito');
        assert.strictEqual(isForActiveTab(err), false,
          'l\'errore non deve essere mostrato nel workspace di un altro tab');
        return true;
      }
    );
    assert.strictEqual(finto.con('collection:find').length, 0,
      'una richiesta per un tab inesistente non deve nemmeno partire');
  });

  await prova('tab chiuso MENTRE la richiesta è in volo: annullata', async () => {
    const finto = scena();
    const tab = apriTab();
    finto.sospendi('collection:find');
    const inVolo = emit('collection:find', {});
    closeTab(tab.id);
    await assert.rejects(inVolo, (err) => {
      assert.strictEqual(err.name, 'AbortError');
      assert.strictEqual(err.code, 'TAB_CLOSED');
      return true;
    });
  });

  /* --- La riconnessione ---------------------------------------------------- */

  await prova('connessione SALVATA: si riconnette e ritenta', async () => {
    const finto = scena();
    const tab = apriTab({ connName: 'produzione' });
    finto.rispondiA('collection:find', { ok: false, error: 'Nessuna connessione attiva al database.' });
    finto.rispondiA('mongo:connect', { ok: true });
    finto.rispondiA('collection:find', { ok: true, docs: [{ _id: 1 }] });

    const res = await emit('collection:find', { db: 'app', coll: 'utenti' });
    assert.deepStrictEqual(res.docs, [{ _id: 1 }]);
    assert.strictEqual(finto.con('mongo:connect').length, 1, 'una sola riapertura');
    assert.strictEqual(finto.ultimoPayload('mongo:connect').saved, 'produzione');
    assert.strictEqual(tab.state.connected, true, 'il tab risulta di nuovo connesso');
    const tentativi = finto.con('collection:find');
    assert.strictEqual(tentativi.length, 2, 'la richiesta viene ritentata una volta');
    assert.strictEqual(tentativi[1].payload._reconnected, true,
      'il secondo tentativo si dichiara, altrimenti si riconnetterebbe all\'infinito');
  });

  await prova('connessione NON salvata: nessuna riconnessione', async () => {
    // I segreti non vivono più nel browser: per una connessione estemporanea non
    // c'è nulla con cui riaprirla, e provarci darebbe un errore di
    // autenticazione al posto di quello vero.
    const finto = scena();
    apriTab();
    finto.rispondiA('collection:find', { ok: false, error: 'Nessuna connessione attiva al database.' });
    await assert.rejects(
      () => emit('collection:find', {}),
      /Nessuna connessione attiva/
    );
    assert.strictEqual(finto.con('mongo:connect').length, 0,
      'nessun tentativo di riapertura per una connessione non salvata');
    assert.strictEqual(finto.con('collection:find').length, 1, 'nessun ritentativo');
  });

  await prova('un errore che non è "connessione assente" non fa riconnettere', async () => {
    const finto = scena();
    apriTab({ connName: 'produzione' });
    finto.rispondiA('collection:find', { ok: false, error: 'Tabella inesistente.' });
    await assert.rejects(() => emit('collection:find', {}), /Tabella inesistente/);
    assert.strictEqual(finto.con('mongo:connect').length, 0);
  });

  await prova('riconnessione fallita: si riporta l\'errore ORIGINALE', async () => {
    // Riportare l'errore della riconnessione nasconderebbe la causa vera.
    const finto = scena();
    apriTab({ connName: 'produzione' });
    finto.rispondiA('collection:find', { ok: false, error: 'Nessuna connessione attiva al database.' });
    finto.rispondiA('mongo:connect', { ok: false, error: 'Host irraggiungibile' });
    await assert.rejects(() => emit('collection:find', {}), /Nessuna connessione attiva/);
  });

  await prova('il tab si chiude durante la riconnessione: annullata', async () => {
    const finto = scena();
    const tab = apriTab({ connName: 'produzione' });
    finto.rispondiA('collection:find', { ok: false, error: 'Nessuna connessione attiva al database.' });
    finto.sospendi('mongo:connect');
    const inVolo = emit('collection:find', {});
    // Si aspetta che la prima risposta sia arrivata e la riapertura sia partita.
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(finto.con('mongo:connect').length, 1, 'la riapertura è partita');
    closeTab(tab.id);
    finto.sblocca('mongo:connect', { ok: true });
    await assert.rejects(inVolo, (err) => {
      assert.strictEqual(err.code, 'TAB_CLOSED');
      return true;
    });
    assert.strictEqual(finto.con('collection:find').length, 1,
      'non si ritenta su un tab che non c\'è più');
  });

  /* --- DIFETTO 3: fire-and-forget non è una notifica all'utente ------------ */

  await prova('DIFETTO 3 — emitFireAndForget manda un EVENTO, e non attende risposta', async () => {
    // Si chiamava `notify`, e in graph3d.js era stato usato per ~27 messaggi
    // all'utente: quei messaggi (errori compresi) non comparivano mai, mentre
    // il testo italiano finiva sul socket come NOME DI EVENTO. Il nome nuovo
    // dice cosa fa; questa prova dice che cosa deve continuare a fare.
    const finto = scena();
    const tab = apriTab();
    emitFireAndForget('query:cancel', { runId: 'r1' });
    const inviato = finto.con('query:cancel');
    assert.strictEqual(inviato.length, 1);
    assert.strictEqual(inviato[0].payload.runId, 'r1');
    assert.strictEqual(inviato[0].payload.tabId, tab.id, 'porta il tab attivo');
  });

  await prova('emitFireAndForget: un tabId indefinito non cancella quello iniettato', async () => {
    // Stesso difetto 1, sull'altra funzione.
    const finto = scena();
    const tab = apriTab();
    emitFireAndForget('query:cancel', { tabId: undefined, runId: 'r2' });
    assert.strictEqual(finto.ultimoPayload('query:cancel').tabId, tab.id);
  });

  /* --- Il socket è una dipendenza, non un effetto dell'import ------------- */

  await prova('importare il trasporto non apre alcun socket', async () => {
    // È la condizione che rende possibile tutto questo file: prima
    // `export const socket = io(…)` girava all'import, e `io` esiste solo nella
    // pagina. Se qualcuno rimettesse la creazione al caricamento, questa prova
    // continuerebbe a passare ma il modulo non sarebbe più importabile — motivo
    // per cui la prova vera è che questo file giri affatto.
    impostaSocket(null);
    const socketMod = await import(modulo('socket.js'));
    assert.strictEqual(typeof socketMod.socketReale, 'function');
    assert.strictEqual(typeof socketMod.impostaSocket, 'function');
  });

  impostaSocket(null);
  if (falliti) throw new Error(`${falliti} test del trasporto falliti`);
  console.log('  Tutti i test del trasporto superati.');
})();

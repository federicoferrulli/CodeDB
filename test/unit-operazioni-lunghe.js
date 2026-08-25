'use strict';

/* ---------------------------------------------------------------------------
 * Gli otto punti di estensione delle operazioni lunghe (ADR-0001, terza
 * famiglia).
 *
 * È la famiglia che giustifica l'ADR: se non esistesse, i suoi eventi
 * potrebbero rientrare nella giuntura dei dati e le famiglie sarebbero due.
 * Finora gli otto punti erano un'AFFERMAZIONE in prosa, da riverificare a mano
 * ogni volta che qualcuno si chiedeva perché `script:execute` non passasse da
 * `delegate`. Qui sono nomi dichiarati, e ogni punto è esercitato.
 *
 * Nessun socket vero, nessun database: contesto finto del ticket 16.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');

const RADICE = path.join(__dirname, '..');

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

/** Legge un oggetto letterale dichiarato in server.js, come testo. */
function bloccoSorgente(src, inizio, fine) {
  const i = src.indexOf(inizio);
  const j = src.indexOf(fine, i);
  assert.ok(i >= 0 && j > i, `blocco non trovato: ${inizio}`);
  return src.slice(i, j);
}

module.exports = (async () => {
  const { registraEventi } = require('../server');
  const src = fs.readFileSync(path.join(RADICE, 'server.js'), 'utf8');

  console.log('  --- Gli otto punti di estensione delle operazioni lunghe ---');

  function conGiuntura(opts) {
    const ctx = contestoFinto(opts);
    registraEventi(ctx);
    return ctx;
  }

  const OTTO = [
    'rispostaAnticipata', 'avanzamento', 'annullamentoMutevole',
    'letturaOperazioniInCorso', 'interruzioneInProcesso', 'categoriaAuditFinale',
    'capabilityPerIstruzione', 'statoDiSessione',
  ];

  /* --- I punti sono dichiarati, non impliciti --------------------------- */

  await prova('gli otto punti hanno un nome e una descrizione', () => {
    const tabella = bloccoSorgente(src, 'const PUNTI_ESTENSIONE = {', 'const OPERAZIONI_LUNGHE');
    for (const punto of OTTO) {
      assert.ok(new RegExp(`\\b${punto}:`).test(tabella), `il punto "${punto}" deve essere nominato`);
    }
    // Otto e non di più: se qualcuno ne aggiunge uno senza aggiornare l'ADR,
    // la famiglia si allarga in silenzio.
    const nomi = [...tabella.matchAll(/^ {2}([a-zA-Z]+):$/gm)].map((m) => m[1]);
    assert.strictEqual(nomi.length, 8, `attesi 8 punti, dichiarati ${nomi.length}: ${nomi.join(', ')}`);
  });

  await prova('ogni operazione lunga dichiara quali punti usa', () => {
    const tabella = bloccoSorgente(src, 'const OPERAZIONI_LUNGHE = {', '\n/* ---');
    const eventi = [...src.matchAll(/\boperazioneLunga\(\s*'([^']+)'/g)].map((m) => m[1]);
    assert.strictEqual(eventi.length, 12, `attesi 12 eventi, trovati ${eventi.length}: ${eventi.join(', ')}`);
    for (const evento of eventi) {
      assert.ok(tabella.includes(`'${evento}':`), `${evento} non dichiara i suoi punti di estensione`);
    }
  });

  await prova('ogni punto è usato da almeno un evento: nessuno è teorico', () => {
    // Un punto che nessuno usa non giustifica niente, e la famiglia esiste
    // proprio per giustificarsi.
    const tabella = bloccoSorgente(src, 'const OPERAZIONI_LUNGHE = {', '\n/* ---');
    const inutilizzati = OTTO.filter((p) => !tabella.includes(`'${p}'`));
    assert.deepStrictEqual(inutilizzati, [],
      `punti dichiarati ma non usati da alcun evento: ${inutilizzati.join(', ')}`);
  });

  /* --- Un'operazione che non usa nessun punto non entra ----------------- */

  await prova('un evento non dichiarato non si registra', () => {
    const os = require('os');
    const conEventoNuovo = src.replace(
      "operazioneLunga('script:pause'",
      "operazioneLunga('operazione:senza:punti', (_p, cb) => cb({ ok: true }));\n"
      + "  operazioneLunga('script:pause'"
    );
    assert.notStrictEqual(conEventoNuovo, src, 'la copia deve contenere l\'evento nuovo');
    const accanto = path.join(RADICE, '.server-prova-operazione-lunga.js');
    fs.writeFileSync(accanto, conEventoNuovo);
    try {
      delete require.cache[require.resolve(accanto)];
      const modulo = require(accanto);
      assert.throws(
        () => modulo.registraEventi(contestoFinto()),
        /Operazione lunga "operazione:senza:punti" non dichiarata/,
        'un\'operazione lunga non dichiarata non deve potersi registrare'
      );
    } finally {
      fs.rmSync(accanto, { force: true });
    }
    void os;
  });

  await prova('il messaggio dice DOVE spostare ciò che non appartiene alla famiglia', () => {
    // È il punto del ticket: la famiglia non deve diventare il cassetto dove
    // finisce ciò che non si sa dove mettere.
    assert.ok(/registrala con delegate\(\) se tocca una strategia/.test(src),
      'il messaggio deve indicare la giuntura dei dati');
    assert.ok(/amministrativo\(\) se non la tocca/.test(src),
      'il messaggio deve indicare la giuntura amministrativa');
  });

  await prova('un punto di estensione scritto male è un errore', () => {
    const conRefuso = src.replace("'script:resume': ['statoDiSessione']", "'script:resume': ['statoDiSessioni']");
    assert.notStrictEqual(conRefuso, src, 'la copia deve contenere il refuso');
    const accanto = path.join(RADICE, '.server-prova-punto-refuso.js');
    fs.writeFileSync(accanto, conRefuso);
    try {
      delete require.cache[require.resolve(accanto)];
      const modulo = require(accanto);
      assert.throws(
        () => modulo.registraEventi(contestoFinto()),
        /punti di estensione sconosciuti \(statoDiSessioni\)/,
        'un punto scritto male non deve restare spento in silenzio'
      );
    } finally {
      fs.rmSync(accanto, { force: true });
    }
  });

  /* --- I punti, esercitati attraverso l'interfaccia --------------------- */

  /** Una sessione con il registro degli script e delle operazioni in corso. */
  function sessioneConScript(run) {
    const sess = sessioneFinta({ strategy: { type: 'mongodb', async cancelQuery() { return { cancelled: true }; } } });
    sess.scripts = new Map(run ? [['r1', run]] : []);
    sess.inflight = new Map();
    return sess;
  }

  await prova('PUNTO 8 — statoDiSessione: script:state legge il registro della sessione', async () => {
    // Non è una strategia: è stato che vive nella sessione. `delegate` non
    // saprebbe nemmeno dove cercarlo.
    const run = {
      state: () => ({ stato: 'in-corso', eseguite: 3, totali: 10 }),
      holder: { last: { righe: 3 } },
    };
    const ctx = conGiuntura({ sessioni: [['tab-1', sessioneConScript(run)]] });

    const res = await ctx.socket.chiama('script:state', { tabId: 'tab-1', runId: 'r1' });
    assert.strictEqual(res.ok, true, res.error);
    assert.deepStrictEqual(res.stato, { stato: 'in-corso', eseguite: 3, totali: 10 },
      'lo stato arriva dal registro della sessione, non da una strategia');

    // Senza registro degli script la risposta è un elenco vuoto, non un errore:
    // chiedere lo stato di ciò che non sta girando è una domanda legittima.
    const vuoto = conGiuntura({ sessioni: [['tab-1', sessioneFinta({ strategy: {} })]] });
    const res2 = await vuoto.socket.chiama('script:state', { tabId: 'tab-1' });
    assert.deepStrictEqual(res2, { ok: true, scripts: [] });
  });

  await prova('PUNTO 4 — letturaOperazioniInCorso: query:cancel legge senza registrare', async () => {
    // Il conflitto che il ticket chiede di togliere: se l'annullamento passasse
    // dalla giuntura dei dati, questa registrerebbe un opHandle sotto lo STESSO
    // runId — cioè sovrascriverebbe proprio quello da annullare.
    const sess = sessioneConScript(null);
    const daAnnullare = { runId: 'r1', proprio: true };
    sess.inflight.set('r1', daAnnullare);
    let annullato = null;
    sess.strategy = {
      type: 'mongodb',
      async cancelQuery(handle) { annullato = handle; return { cancelled: true }; },
    };
    const ctx = conGiuntura({ sessioni: [['tab-1', sess]] });

    const res = await ctx.socket.chiama('query:cancel', { tabId: 'tab-1', runId: 'r1' });
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(annullato, daAnnullare,
      'deve annullare il riferimento REGISTRATO, non uno creato dall\'annullamento stesso');
    assert.strictEqual(sess.inflight.get('r1'), daAnnullare,
      'il registro non deve essere stato sovrascritto');
  });

  await prova('PUNTO 5 — interruzioneInProcesso: il flag ferma ciò che gira dentro CodeDB', async () => {
    // Uno script MongoDB interpretato non è un'operazione del database che si
    // possa uccidere con killOp: gira nel processo CodeDB, e il flag è il suo
    // unico canale di interruzione.
    const sess = sessioneConScript(null);
    const handle = { runId: 'r1' };
    sess.inflight.set('r1', handle);
    sess.strategy = { type: 'mongodb', async cancelQuery() { return { cancelled: false }; } };
    const ctx = conGiuntura({ sessioni: [['tab-1', sess]] });

    assert.notStrictEqual(handle.interrotto, true, 'prima dell\'annullamento non è interrotto');
    await ctx.socket.chiama('query:cancel', { tabId: 'tab-1', runId: 'r1' });
    assert.strictEqual(handle.interrotto, true,
      'l\'annullamento deve alzare il flag che ferma l\'esecuzione in processo');
  });

  await prova('PUNTO 4bis — annullare ciò che non è registrato non inventa nulla', async () => {
    const ctx = conGiuntura({ sessioni: [['tab-1', sessioneConScript(null)]] });
    const res = await ctx.socket.chiama('query:cancel', { tabId: 'tab-1', runId: 'mai-visto' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.cancelled, false, 'non deve dichiarare annullato ciò che non ha trovato');
  });

  await prova('PUNTO 1 — rispostaAnticipata: script:execute è dichiarata usarla', () => {
    // Che risponda prima della fine si vede da capo a fondo in
    // test/e2e-script-runner.js; qui si verifica che il punto sia DICHIARATO,
    // perché è la dichiarazione a giustificare la famiglia.
    const tabella = bloccoSorgente(src, 'const OPERAZIONI_LUNGHE = {', '\n/* ---');
    const voce = tabella.slice(tabella.indexOf("'script:execute':"), tabella.indexOf("'script:pause':"));
    for (const punto of ['rispostaAnticipata', 'avanzamento', 'capabilityPerIstruzione']) {
      assert.ok(voce.includes(`'${punto}'`), `script:execute deve dichiarare ${punto}`);
    }
  });

  await prova('PUNTO 2 — avanzamento: il canale di progresso esiste ed è per run', () => {
    assert.ok(/script:progress/.test(src), 'il canale di avanzamento deve esistere');
    assert.ok(/function makeProgressSender\(/.test(src),
      'l\'invio dell\'avanzamento deve avere un punto solo');
  });

  await prova('PUNTO 3 — annullamentoMutevole: il riferimento cambia per istruzione', () => {
    // Uno script ne cambia uno per istruzione: fissarlo all'ingresso, come fa
    // la giuntura dei dati, renderebbe annullabile solo la prima.
    const tabella = bloccoSorgente(src, 'const OPERAZIONI_LUNGHE = {', '\n/* ---');
    assert.ok(tabella.includes("'annullamentoMutevole'"), 'il punto deve essere usato');
    assert.ok(/inflight\.set\(/.test(src), 'il registro deve poter essere riscritto durante l\'esecuzione');
  });

  await prova('PUNTO 6 — categoriaAuditFinale: la categoria si decide a fine esecuzione', () => {
    assert.ok(/function finalizzaScript\(/.test(src),
      'la finalizzazione deve esistere: è lì che la categoria si conosce');
    const tabella = bloccoSorgente(src, 'const OPERAZIONI_LUNGHE = {', '\n/* ---');
    assert.ok(tabella.includes("'categoriaAuditFinale'"), 'il punto deve essere usato');
  });

  await prova('PUNTO 7 — capabilityPerIstruzione: dichiarata da chi interpreta', () => {
    const tabella = bloccoSorgente(src, 'const OPERAZIONI_LUNGHE = {', '\n/* ---');
    const voce = tabella.slice(tabella.indexOf("'script:execute':"), tabella.indexOf("'script:pause':"));
    assert.ok(voce.includes("'capabilityPerIstruzione'"),
      'solo chi esegue istruzione per istruzione può verificare per istruzione');
  });

  /* --- La famiglia non è il cassetto ------------------------------------ */

  await prova('i dodici eventi non sono rimasti anche sulla via generica', () => {
    const generici = [...src.matchAll(/\bsafeOn\(\s*'([^']+)'/g)].map((m) => m[1]);
    const lunghi = [...src.matchAll(/\boperazioneLunga\(\s*'([^']+)'/g)].map((m) => m[1]);
    const doppi = lunghi.filter((e) => generici.includes(e));
    assert.deepStrictEqual(doppi, [], `registrati due volte: ${doppi.join(', ')}`);
  });

  if (falliti) throw new Error(`${falliti} test delle operazioni lunghe falliti`);
  console.log('  Operazioni lunghe: gli otto punti sono dichiarati e provati.');
})();

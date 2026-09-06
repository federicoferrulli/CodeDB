'use strict';
const assert = require('assert');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');
const { politiche, catalogoEventi, giuntura } = require('./server-fixture');
let falliti = 0;
async function prova(nome, fn) {
  try { await fn(); console.log('  OK   ' + nome); }
  catch (err) { falliti++; console.error('  FAIL ' + nome + ': ' + err.message); }
}
module.exports = (async () => {
  const { registraEventi } = require('../server');
  function conGiuntura(opts) { const ctx = contestoFinto(opts); registraEventi(ctx); return ctx; }
  const policy = politiche();
  await prova('otto punti reali, usati da tutte le 14 operazioni lunghe', () => {
    const punti = Object.keys(policy.PUNTI_ESTENSIONE);
    assert.strictEqual(punti.length, 8);
    const eventi = catalogoEventi().filter(e => e.famiglia === 'operazioneLunga');
    assert.strictEqual(eventi.length, 14);
    for (const { evento } of eventi) {
      const usati = policy.OPERAZIONI_LUNGHE[evento];
      assert(usati.length > 0, evento);
      for (const punto of usati) assert(punti.includes(punto), punto);
    }
    for (const punto of punti) assert(Object.values(policy.OPERAZIONI_LUNGHE).some(v => v.includes(punto)), punto);
    for (const punto of ['rispostaAnticipata', 'avanzamento', 'capabilityPerIstruzione', 'categoriaAuditFinale']) {
      assert(policy.OPERAZIONI_LUNGHE['script:execute'].includes(punto), punto);
    }
  });
  await prova('operazioni non dichiarate e refusi nei punti vengono rifiutati', () => {
    let modulo = giuntura([(_ctx, l) => l.operazioneLunga('operazione:senza:punti', () => {})]);
    assert.throws(() => modulo.registraEventi(contestoFinto()), err =>
      /non dichiarata/.test(err.message) && /delegate/.test(err.message) && /amministrativo/.test(err.message));
    const errata = politiche();
    errata.OPERAZIONI_LUNGHE['script:resume'] = ['statoDiSessioni'];
    modulo = giuntura([(_ctx, l) => l.operazioneLunga('script:resume', () => {})], { audit: errata });
    assert.throws(() => modulo.registraEventi(contestoFinto()), /punti di estensione sconosciuti \(statoDiSessioni\)/);
  });
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

  if (falliti) throw new Error(falliti + ' test operazioni lunghe falliti');
})();

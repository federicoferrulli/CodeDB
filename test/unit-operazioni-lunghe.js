'use strict';
const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-run-file-'));
  const server = require('../server/createServer').createServer({ config: { rootDir: dir, desktop: null, env: {
    CODEDB_RBAC: 'off', CODEDB_SCRIPT_RESULTS_DIR: path.join(dir, 'risultati'), CODEDB_UI_AUDIT_FILE: path.join(dir, 'audit.log'),
  } } });
  await prova('il runner esegue le definizioni di vista condizionali dei dump MySQL', async () => {
    const sql = '/*!50001 CREATE VIEW v AS SELECT 1 AS n */';
    const ricevute = [];
    const strategy = { type: 'mysql', async collectionAggregate(_db, _coll, payload) {
      ricevute.push(payload.pipeline);
      return { docs: [], columns: [] };
    } };
    const sess = sessioneFinta({ strategy, dbType: 'mysql' });
    const ctx = contestoFinto({ sessioni: [['sql', sess]] });
    server.registraEventi(ctx);
    const apertura = await ctx.socket.chiama('script:execute', {
      runId: 'vista', tabId: 'sql', db: 'prova', code: '-- intestazione\n' + sql + ';\n/* nota */;',
    });
    assert.equal(apertura.total, 1, apertura.error);
    await sess.scripts.get('vista').completion;
    assert.equal(ricevute.length, 1);
    assert.ok(ricevute[0].includes(sql));
  });
  await prova('i frammenti SQL appartengono alla sessione e solo il testo completo si esegue una volta', async () => {
    const ricevute = [];
    function sessione() {
      return sessioneFinta({ dbType: 'mysql', strategy: { type: 'mysql', async collectionAggregate(_db, _coll, payload) {
        ricevute.push(payload.pipeline);
        return { docs: [], columns: [] };
      } } });
    }
    const a = sessione();
    const ctx = contestoFinto({ sessioni: [['a', a], ['b', sessione()]] });
    server.registraEventi(ctx);
    const invia = (p) => ctx.socket.chiama('script:upload', { tabId: 'a', ...p });
    const { uploadId } = await invia({ action: 'start' });
    assert.ok(uploadId);
    const payload = { runId: 'pezzi', db: 'prova', uploadId, uploadBytes: Buffer.byteLength("SELECT '😀'") };
    assert.equal((await invia({ action: 'append', uploadId, index: 1, chunk: 'errato' })).ok, false);
    assert.equal((await invia({ action: 'append', uploadId, index: 0, chunk: "SELECT '" })).ok, true);
    assert.equal((await ctx.socket.chiama('script:execute', { ...payload, tabId: 'a' })).ok, false);
    assert.equal((await invia({ action: 'append', uploadId, index: 1, chunk: "😀'" })).ok, true);
    assert.equal((await ctx.socket.chiama('script:execute', { ...payload, tabId: 'b' })).ok, false);
    assert.equal((await ctx.socket.chiama('script:execute', { ...payload, tabId: 'a' })).total, 1);
    await a.scripts.get('pezzi').completion;
    assert.deepEqual(ricevute, ["SELECT '😀'"]);
    assert.equal((await ctx.socket.chiama('script:execute', { ...payload, tabId: 'a', runId: 'ripetuto' })).ok, false);
  });
  await prova('query recuperabile: ack perso, nuova attesa e stessa scrittura eseguita una volta', async () => {
    let segnalaPartenza, prosegui;
    const partita = new Promise(resolve => { segnalaPartenza = resolve; });
    const libera = new Promise(resolve => { prosegui = resolve; });
    let esecuzioni = 0;
    const sess = sessioneFinta({ dbType: 'mysql', strategy: { type: 'mysql', async collectionAggregate(_db, _coll, p) {
      esecuzioni++;
      segnalaPartenza();
      await libera;
      if (p.pipeline.includes('errore')) throw new Error('Scrittura rifiutata.');
      return { docs: [{ id: 7 }], columns: ['id'] };
    } } });
    const ctx = contestoFinto({ sessioni: [['a', sess]] });
    server.registraEventi(ctx);
    const payload = { tabId: 'a', runId: 'scrittura', db: 'prova', code: 'INSERT INTO t VALUES (7)', recoverable: true };
    const chiama = (evento, parametri = payload) => ctx.socket.chiama(evento, parametri);
    const avvio = chiama('query:execute');
    await partita;
    const duplicato = chiama('query:execute');
    const stato = chiama('query:state').catch(err => ({ error: err.message }));
    prosegui();
    const [ack, bis, recuperata] = await Promise.all([avvio, duplicato, stato]);
    assert.equal(esecuzioni, 1, 'la stessa scrittura è stata inviata al database due volte');
    assert.deepEqual(ack, bis);
    assert.deepEqual(recuperata, { ...ack, found: true });
    assert.deepEqual(await chiama('query:state'), recuperata, 'il risultato sopravvive alla fine della query');
    await chiama('query:state', { ...payload, received: true });
    assert.deepEqual(await chiama('query:state'), { ok: true, found: false });
    const errata = { ...payload, runId: 'fallita', code: 'INSERT INTO errore VALUES (7)' };
    const errore = await chiama('query:execute', errata);
    assert.equal(errore.ok, false);
    assert.deepEqual(await chiama('query:state', errata), { ...errore, found: true });
  });
  await prova('query singola a frammenti: stessa transazione del tab e un solo INSERT dopo un ack perso', async () => {
    const ricevute = [];
    let aperture = 0;
    const { prendiConnessioneSql, chiudiStrategiaSql } = require('../db/sqlSessione');
    const strategy = { type: 'mysql', disconnect() { return chiudiStrategiaSql(this); },
      async collectionAggregate(_db, _coll, { pipeline }) {
        const lease = await prendiConnessioneSql(this, pipeline, async () => {
          aperture++;
          return { query: async () => {}, destroy() {} };
        });
        ricevute.push({ sql: pipeline, transazione: lease.transazione });
        await lease.termina(true);
        return { docs: [{ conteggio: ricevute.length }] };
      },
    };
    const sess = () => sessioneFinta({ dbType: 'mysql', strategy });
    const ctx = contestoFinto({ sessioni: [['a', sess()], ['b', sess()]] });
    server.registraEventi(ctx);
    const chiama = (evento, p) => ctx.socket.chiama(evento, { tabId: 'a', db: 'prova', ...p });
    assert.equal((await chiama('query:execute', { code: 'BEGIN' })).ok, true);
    const { uploadId } = await chiama('script:upload', { action: 'start', runId: 'singola' });
    const parti = ['INSERT INTO t VALUES (', "'è😀')"];
    const sql = parti.join('');
    const payload = { runId: 'singola', recoverable: true, uploadId, uploadBytes: Buffer.byteLength(sql) };
    const aggiungi = index => chiama('script:upload', { action: 'append', uploadId, index, chunk: parti[index] });
    await aggiungi(0);
    assert.equal((await chiama('query:execute', payload)).ok, false, 'nessuna esecuzione per un testo incompleto');
    await aggiungi(1);
    assert.equal((await chiama('query:execute', { ...payload, tabId: 'b' })).ok, false, 'i frammenti appartengono al tab');
    const esiti = await Promise.all([chiama('query:execute', payload), chiama('query:execute', payload)]);
    for (const esito of esiti) assert.deepEqual(esito.data, [{ conteggio: 2 }], esito.error);
    const recuperata = await chiama('query:state', { runId: 'singola' });
    assert.deepEqual(recuperata.data, esiti[0].data);
    assert.equal((await chiama('query:execute', { code: 'COMMIT' })).ok, true);
    assert.deepEqual(ricevute, [{ sql: 'BEGIN', transazione: false }, { sql, transazione: true }, { sql: 'COMMIT', transazione: true }]);
    assert.equal(aperture, 1);
  });
  await prova('script recuperabile: frammento, avvio e continuazione tollerano un ack perso', async () => {
    const ricevute = [];
    const sess = sessioneFinta({ dbType: 'mysql', strategy: { type: 'mysql', async collectionAggregate(_db, _coll, p) {
      ricevute.push(p.pipeline);
      return { resultSet: true, docs: [{ n: ricevute.length }], columns: ['n'] };
    } } });
    const ctx = contestoFinto({ sessioni: [['a', sess]] });
    server.registraEventi(ctx);
    const chiama = (evento, p) => ctx.socket.chiama(evento, { tabId: 'a', runId: 'uno', ...p });
    const { uploadId } = await chiama('script:upload', { action: 'start' });
    assert.equal((await chiama('script:upload', { action: 'start' })).uploadId, uploadId);
    const pezzo = { action: 'append', index: 0, uploadId, chunk: 'SELECT 1' };
    assert.equal((await chiama('script:upload', pezzo)).bytes, 8);
    assert.equal((await chiama('script:upload', pezzo)).bytes, 8);
    assert.equal((await chiama('script:upload', { ...pezzo, chunk: 'SELECT 2' })).ok, false);
    const primo = { recoverable: true, db: 'prova', uploadId, uploadBytes: 8, keepSqlSession: true };
    assert.equal((await chiama('script:execute', primo)).ok, true);
    assert.equal((await chiama('script:execute', primo)).ok, true);
    await sess.scripts.get('uno').completion;
    const seguito = { recoverable: true, db: 'prova', runId: 'due', previousRunId: 'uno', code: 'SELECT 2' };
    const ack = await Promise.all([chiama('script:execute', seguito), chiama('script:execute', seguito)]);
    assert(ack.every(r => r.ok), JSON.stringify(ack));
    await sess.scripts.get('due').completion;
    for (let i = 3; i <= 8; i++) {
      const runId = String(i);
      await chiama('script:execute', { runId, db: 'prova', code: 'SELECT ' + i });
      await sess.scripts.get(runId).completion;
    }
    const esito = await chiama('script:state', { runId: 'due' });
    assert.equal(esito.stato.status, 'done');
    assert.deepEqual(esito.ultimoRisultato.docs, [{ n: 2 }]);
    assert.equal(esito.risultati.schede.length, 1);
    const scheda = await chiama('script:result', { runId: 'due', pos: 0 });
    assert.deepEqual(scheda.docs, [{ n: 2 }]);
    assert.deepEqual(ricevute, Array.from({ length: 8 }, (_, i) => 'SELECT ' + (i + 1)));
    await chiama('script:state', { runId: 'due', received: true });
  });
  await prova('una ripresa con ack perso rispetta la seconda pausa e un arresto resta consultabile', async () => {
    const ricevute = [];
    const sess = sessioneFinta({ dbType: 'mysql', strategy: { type: 'mysql', async collectionAggregate(_db, _coll, { pipeline }) {
      ricevute.push(pipeline);
      if (pipeline.includes('errore')) throw new Error('Istruzione rifiutata.');
      return { docs: [] };
    } } });
    const ctx = contestoFinto({ sessioni: [['a', sess]] });
    server.registraEventi(ctx);
    const chiama = (evento, p) => ctx.socket.chiama(evento, { tabId: 'a', runId: 'pausa', ...p });
    await chiama('script:execute', { recoverable: true, db: 'prova', code: 'SELECT errore1; SELECT errore2; SELECT 3', stopOnError: true });
    const run = sess.scripts.get('pausa');
    await run.completion;
    assert.equal(run.status, 'paused');
    await chiama('script:resume', { expectedAttempts: 1 });
    await run.completion;
    await chiama('script:resume', { expectedAttempts: 1 });
    await run.completion;
    assert.equal(run.status, 'paused', 'la ricevuta persa non può superare un nuovo errore');
    assert.deepEqual(ricevute, ['SELECT errore1', 'SELECT errore2']);
    const stop = await chiama('script:abort');
    assert.equal(stop.aborted, true);
    assert.deepEqual(await chiama('script:abort'), stop);
    assert.equal((await chiama('script:state')).stato.status, 'aborted');
  });
  await prova('arresto tra due blocchi: un solo rollback anche con ricevute perse o in ritardo', async () => {
    const sql = [];
    let rilasci = 0;
    const conn = { query: async testo => { sql.push(testo); }, destroy: () => { rilasci++; } };
    const strategy = { type: 'mysql', async collectionAggregate(_db, _coll, { pipeline }) {
      const lease = await require('../db/sqlSessione').prendiConnessioneSql(strategy, pipeline, async () => conn);
      try { await lease.conn.query(pipeline); } finally { await lease.termina(true); }
      return { docs: [] };
    } };
    const sess = sessioneFinta({ dbType: 'mysql', strategy });
    const ctx = contestoFinto({ sessioni: [['a', sess]] });
    server.registraEventi(ctx);
    const chiama = (evento, p) => ctx.socket.chiama(evento, { tabId: 'a', runId: 'transazione', ...p });
    await chiama('script:execute', { recoverable: true, db: 'prova', code: 'BEGIN', keepSqlSession: true });
    const run = sess.scripts.get('transazione');
    await run.completion;
    const ricevutaFine = { received: true, status: 'done' };
    await chiama('script:state', ricevutaFine);
    const arresta = () => chiama('script:abort', { recoverable: true });
    const [a, b] = await Promise.all([arresta(), arresta()]);
    assert.deepEqual(a, { ok: true, aborted: true, transazioneAnnullata: true });
    assert.deepEqual(b, a);
    await chiama('script:state', ricevutaFine);
    assert.equal(run.attendeRicevuta, true, 'una conferma del done precedente non conferma il rollback');
    const { stato } = await chiama('script:state');
    assert.equal(stato.status, 'aborted');
    assert.equal(stato.transazioneAnnullata, true);
    assert.deepEqual(sql, ['BEGIN', 'ROLLBACK']);
    assert.equal(rilasci, 1);
    await chiama('script:state', { received: true, status: 'aborted' });
    assert.equal(run.attendeRicevuta, false);
  });
  await prova('il guasto del runner resta leggibile dopo la perdita del push terminale', async () => {
    let prosegui;
    const attesa = new Promise(resolve => { prosegui = resolve; });
    const sess = sessioneFinta({ dbType: 'mysql', strategy: { type: 'mysql', async collectionAggregate() {
      await attesa;
      return { docs: [] };
    } } });
    const ctx = contestoFinto({ sessioni: [['a', sess]] });
    server.registraEventi(ctx);
    const chiama = (evento, p) => ctx.socket.chiama(evento, { tabId: 'a', runId: 'guasto', ...p });
    await chiama('script:execute', { recoverable: true, db: 'prova', code: 'SELECT 1' });
    const run = sess.scripts.get('guasto');
    run._record = () => { throw new Error('Guasto simulato al resoconto'); };
    prosegui();
    await run.completion;
    const { stato } = await chiama('script:state');
    assert.equal(stato.status, 'aborted');
    assert.equal(stato.errore, 'Guasto simulato al resoconto');
  });
  await server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  await prova('otto punti reali, usati da tutte le 22 operazioni lunghe', () => {
    const punti = Object.keys(policy.PUNTI_ESTENSIONE);
    assert.strictEqual(punti.length, 8);
    const eventi = catalogoEventi().filter(e => e.famiglia === 'operazioneLunga');
    assert.strictEqual(eventi.length, 22);
    for (const action of ['state', 'reset', 'closeStream', 'answer']) {
      assert(eventi.some(e => e.evento === `mongosh:${action}`));
    }
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

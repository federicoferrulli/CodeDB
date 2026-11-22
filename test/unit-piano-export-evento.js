'use strict';

// I due eventi che collegano i moduli del piano al resto dell'applicazione,
// provati con il contesto finto e i moduli VERI: una strategia finta al posto
// del database, nient'altro di finto.
//
// Ciò che conta qui non è che rispondano, ma che rispondano passando dai
// moduli giusti: il catalogo dal catalogo reale (mai le euristiche UML), il
// piano firmato, il database di sistema rifiutato lato SERVER — dove prima il
// controllo viveva solo nel browser, quindi chi parlava direttamente col
// socket poteva chiedere `mysql` o `pg_catalog`.

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');
const { verificaImpronta } = require('../db/exportPlan');

// Un pool MySQL finto che risponde alle query del catalogo e a nient'altro:
// una query non prevista fa fallire il test dicendo QUALE, invece di tornare
// una lista vuota che si leggerebbe come «il database non ha tabelle».
function poolMySqlFinto() {
  const risposte = [
    // L'ordine conta: `TABLE_TYPE` distingue le tabelle dalle view, e una regex
    // sulla sola `information_schema.TABLES` risponderebbe alle due domande con
    // la stessa lista — cioè il catalogo prenderebbe le tabelle per view.
    [/TABLE_TYPE = 'VIEW'/i, []],
    [/FROM information_schema\.TABLES/i, [
      { name: 'clienti', rows_approx: 10 },
      { name: 'ordini', rows_approx: 40 },
    ]],
    [/FROM information_schema\.KEY_COLUMN_USAGE/i, [
      { src: 'ordini', col: 'cliente_id', ref_schema: 'negozio', ref: 'clienti' },
    ]],
  ];
  return {
    async getConnection() {
      return {
        async query(sql) {
          for (const [re, righe] of risposte) if (re.test(sql)) return [righe];
          return [[]];
        },
        release() {},
      };
    },
  };
}

const strategiaFinta = {
  type: 'mysql',
  pool: poolMySqlFinto(),
};

async function verificaCopiaDiretta(registraEventi, driver) {
  const strategia = () => ({ type: 'mongodb', client: { db: () => ({
    listCollections: () => ({ toArray: async () => [{ name: 'persone', type: 'collection', options: {} }] }),
    collection: () => ({ estimatedDocumentCount: async () => 3 }), command: async () => ({ ok: 1 }),
  }) } });
  const sorgente = sessioneFinta({ tabId: 'a', connName: 'origine', strategy: strategia() });
  const arrivo = sessioneFinta({ tabId: 'b', connName: 'arrivo', strategy: strategia() });
  const ctx = contestoFinto({ sessioni: [['a', sorgente], ['b', arrivo]] });
  registraEventi(ctx);
  const preview = (target = { tabId: 'b', db: 'copia' }, extra = {}) => ctx.socket.chiama('database:export:plan', {
    tabId: 'a', db: 'origine', formato: 'mongosh', destinazioneMongo: target, ...extra,
  });
  const esegui = (plan, extra = {}) => ctx.socket.chiama('database:export:execute', { tabId: 'a', planHash: plan.fingerprint, ...extra });
  for (const target of [null, { tabId: 'a', db: 'Origine' }, { tabId: 'b', db: 'admin' }, { tabId: 'b', db: 'local' },
    { tabId: 'b', db: 'Config' }, { tabId: 'assente', db: 'copia' }, { db: 'copia' }, { tabId: 'b', db: ' ' }]) {
    assert.strictEqual((await preview(target)).ok, false);
  }
  assert.strictEqual((await preview(undefined, { formato: 'codedb-json' })).ok, false);
  const root = ctx.principal;
  const limitato = { id: root.id, ownerId: root.ownerId, grants: [{ connName: 'origine', capabilities: ['read'] },
    { connName: 'arrivo', capabilities: ['manage'], scope: { databases: ['copia'], collections: ['*'] } }] };
  ctx.principal = limitato;
  assert.match((await preview()).error, /Permesso negato/);
  ctx.principal = root;
  const primo = await preview(), secondo = await preview();
  assert.strictEqual(primo.ok, true, primo.error);
  assert.deepStrictEqual(primo.plan.destinazioneMongo, { tabId: 'b', connection: 'arrivo', db: 'copia' });
  assert.deepStrictEqual(primo.plan.destinazione, { kind: 'mongodb' });
  assert.strictEqual(primo.plan.verifica.artefatto, false);
  assert.strictEqual(primo.plan.verifica.dati, 'esiti-scrittura');
  assert.ok(!Object.hasOwn(primo.plan, 'compressione'));
  verificaImpronta(primo.plan);
  assert.notStrictEqual(primo.plan.fingerprint, secondo.plan.fingerprint);
  assert.strictEqual((await esegui(primo.plan)).ok, false);
  assert.strictEqual((await esegui(secondo.plan, { dbDestinazione: 'altro' })).ok, false);
  assert.strictEqual((await ctx.socket.chiama('database:export:start', { tabId: 'a', fingerprint: secondo.plan.fingerprint })).ok, false);
  ctx.principal = limitato;
  assert.match((await esegui(secondo.plan)).error, /Permesso negato/);
  ctx.principal = root;
  ctx.sessions.set('b', { ...arrivo });
  assert.match((await esegui(secondo.plan)).error, /sessione.*cambiata/i);
  ctx.sessions.set('b', arrivo);

  let chiamate = 0;
  const parziale = { inseriti: 2 };
  let avvia, sblocca;
  const avviata = new Promise(r => { avvia = r; });
  const rilascio = new Promise(r => { sblocca = r; });
  driver.esegui = async opts => {
    chiamate++;
    assert.strictEqual(opts.sorgente, sorgente.strategy);
    assert.strictEqual(opts.destinazione, arrivo.strategy);
    assert.strictEqual(opts.dbDestinazione, 'copia');
    assert.strictEqual(sorgente.operationLeases, 1);
    assert.strictEqual(arrivo.operationLeases, 1);
    await opts.onProgress({ rows: 2, collection: 'persone', risultato: parziale });
    avvia(); await rilascio;
    try { opts.check(); } catch (err) { err.risultato = parziale; throw err; }
    return parziale;
  };
  const esito = esegui(secondo.plan);
  await avviata;
  assert.deepStrictEqual(ctx.socket.ultimoInviato('database:export:progress').args[0].risultato, parziale);
  assert.strictEqual((await esegui(secondo.plan)).ok, false, 'due conferme concorrenti non ripetono la copia');
  const nuova = await preview();
  assert.match((await esegui(nuova.plan)).error, /già in corso/);
  await ctx.socket.chiama('mongo:disconnect', { tabId: 'b' });
  sblocca();
  const interrotta = await esito;
  assert.strictEqual(interrotta.ok, false);
  assert.deepStrictEqual(interrotta.risultato, parziale);
  assert.strictEqual(arrivo.closed, true);
  assert.strictEqual(sorgente.operationLeases, 0);
  assert.strictEqual(arrivo.operationLeases, 0);
  assert.strictEqual(chiamate, 1);
  const sostituta = sessioneFinta({ tabId: 'b', connName: 'arrivo', strategy: strategia() });
  ctx.sessions.set('b', sostituta);
  const ultimo = (await preview()).plan;
  driver.esegui = async () => ({ inseriti: 3 });
  assert.deepStrictEqual(await esegui(ultimo), { ok: true, risultato: { inseriti: 3 } });
  assert.strictEqual((await esegui(ultimo)).ok, false, 'la conferma completata resta consumata');
  const storico = await ctx.socket.chiama('audit:list', { event: 'database:export:execute', db: 'copia' });
  const parzialeRegistrato = storico.entries.find(e => e.fingerprint === secondo.plan.fingerprint);
  assert.strictEqual(parzialeRegistrato.status, 'error');
  assert.deepStrictEqual(parzialeRegistrato.risultato, parziale);
  assert.deepStrictEqual(storico.entries.find(e => e.fingerprint === ultimo.fingerprint).risultato, { inseriti: 3 });
  console.log('  OK   copia diretta: bersaglio firmato, autorizzazioni, lease, avanzamento, esito parziale e protezione dai replay');
}

module.exports = (async () => {
  const { registraEventi } = require('../server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-evento-copia-'));
  const driver = {};
  const server = require('../server').createServer({ config: { rootDir: dir, env: {
    CODEDB_RBAC: 'off', CODEDB_UI_AUDIT_FILE: path.join(dir, 'audit.log'),
  } }, dependencies: { eseguiExportMongo: options => driver.esegui(options) } });
  try { await verificaCopiaDiretta(server.registraEventi, driver); }
  finally { await server.stop(); fs.rmSync(dir, { recursive: true, force: true }); }

  {
    const principal = { id: 'limitato', ownerId: 'tenant', root: false, owner: false,
      grants: [{ connName: 'locale', capabilities: ['read'], scope: { databases: ['negozio'], collections: ['clienti'] } }] };
    let letto = false;
    const strategy = { type: 'mysql', pool: { getConnection() { letto = true; throw new Error('Non deve leggere il catalogo'); } } };
    const scoped = contestoFinto({ principal, sessioni: [['tab-1', sessioneFinta({ strategy, dbType: 'mysql', connName: 'locale', principal })]] });
    registraEventi(scoped);
    const res = await scoped.socket.chiama('database:export:plan', { tabId: 'tab-1', db: 'negozio' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(letto, false, 'lo scope si controlla prima di accedere al driver nativo');
    console.log('  OK   RBAC: catalogo non esposto a grant limitati');
  }

  const ctx = contestoFinto({
    sessioni: [['tab-1', sessioneFinta({ strategy: strategiaFinta, dbType: 'mysql', connName: 'locale' })]],
  });
  registraEventi(ctx);

  /* --- Il piano di export ---------------------------------------------------- */

  {
    const res = await ctx.socket.chiama('database:export:plan', { tabId: 'tab-1', db: 'negozio' });
    assert.strictEqual(res.ok, true, res.error);
    const plan = res.plan;
    assert.strictEqual(plan.kind, 'export-database');
    assert.deepStrictEqual(plan.destinazione, { kind: 'server' });
    assert.strictEqual(plan.verifica.artefatto, true);
    assert.strictEqual(plan.verifica.dati, 'conteggi');
    assert.strictEqual(plan.compressione, false);
    assert.strictEqual(plan.limiteByte ?? null, null, 'il piano di export non eredita il limite dell’import');
    assert.strictEqual(plan.sourceDb, 'negozio');
    assert.strictEqual(plan.connection, 'locale', 'la connessione è quella della SESSIONE, non del payload');
    // Firmato: anteprima ed esecuzione guardano lo stesso oggetto o l'esecuzione
    // rifiuta. Senza impronta non è un contratto.
    assert(plan.fingerprint, 'il piano è firmato');
    verificaImpronta(plan);
    assert.deepStrictEqual(
      plan.oggetti.map((o) => o.id).sort(),
      ['tabella:clienti', 'tabella:ordini'],
    );
    // Il catalogo viaggia accanto al piano: il wizard deve poter mostrare anche
    // ciò che il piano esclude.
    assert.deepStrictEqual(res.catalogo.map((o) => o.id).sort(), ['tabella:clienti', 'tabella:ordini']);
    // Il backend si guarda, non si presume: qui i tool nativi non ci sono.
    assert(res.motore && res.motore.backend, 'il motore è dichiarato');
    console.log('  OK   piano di export firmato, dal catalogo reale, con la connessione della sessione');
  }

  /* --- Solo struttura -------------------------------------------------------- */

  {
    const richiesta = { tabId: 'tab-1', db: 'negozio', formato: 'sql' };
    const normale = await ctx.socket.chiama('database:export:plan', richiesta);
    const opzioniSql = { righe: 'replace', tabelle: 'ricrea' };
    const res = await ctx.socket.chiama('database:export:plan', { ...richiesta, opzioniSql });
    assert.strictEqual(res.ok, true, res.error);
    assert.deepStrictEqual(res.plan.opzioniSql, opzioniSql);
    const superata = await ctx.socket.chiama('database:export:start', { ...richiesta, fingerprint: normale.plan.fingerprint });
    assert.strictEqual(superata.ok, false);
    assert.match(superata.error, /piano.*cambiato/i);
  }

  {
    const res = await ctx.socket.chiama('database:export:plan', {
      tabId: 'tab-1', db: 'negozio', modalita: 'solo-struttura',
    });
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.plan.contaRighe, false, 'solo struttura non scorre i dati, e lo DICHIARA');
    assert(res.plan.oggetti.every((o) => !o.dati));
    console.log('  OK   la modalità cambia il piano, non solo l etichetta');
  }

  /* --- Database di sistema, lato server -------------------------------------- */

  {
    const res = await ctx.socket.chiama('database:export:plan', { tabId: 'tab-1', db: 'mysql' });
    assert.strictEqual(res.ok, false, 'un database di sistema non produce un piano');
    assert.match(res.error || '', /sistema/i);
    console.log('  OK   il database di sistema è rifiutato dal server, non dal browser');
  }

  /* --- La selezione di import ------------------------------------------------ */

  {
    const open = await ctx.socket.chiama('database:import:upload:start', { tabId: 'tab-1', format: 'sql' });
    const payload = { tabId: 'tab-1', uploadId: open.uploadId, targetDb: 'copia' };
    const chunk = await ctx.socket.chiama('database:import:upload:chunk', {
      ...payload, index: 0, chunk: 'CREATE VIEW riepilogo AS SELECT 1 AS n;',
    });
    assert.strictEqual(chunk.ok, true, chunk.error);
    const finish = await ctx.socket.chiama('database:import:upload:finish', payload);
    assert.strictEqual(finish.ok, true, finish.error);
    assert.deepStrictEqual(finish.artifact.views, ['riepilogo']);
    const preview = await ctx.socket.chiama('database:import:start', { ...payload, previewOnly: true });
    assert.deepStrictEqual(preview.plan.views, ['riepilogo']);
    const result = await ctx.socket.chiama('database:import:selezione', payload);
    assert.strictEqual(result.ok, true, result.error);
    assert.deepStrictEqual(result.selezione.voci.map(v => [v.id, v.struttura, v.dati]), [['vista:riepilogo', true, false]]);
    await ctx.socket.chiama('database:import:upload:cancel', payload);
  }

  {
    const artifact = {
      formato: 'codedb-database', versione: 1, dbType: 'mysql', db: 'negozio',
      collections: [
        { name: 'clienti', ddl: 'CREATE TABLE clienti (id INT PRIMARY KEY)', docs: [{ id: 1 }], identity: { kind: 'primary-key', columns: ['id'] } },
        { name: 'ordini', ddl: 'CREATE TABLE ordini (id INT PRIMARY KEY)', docs: [], identity: null },
      ],
    };
    const res = await ctx.socket.chiama('database:import:selezione', {
      tabId: 'tab-1', artifact, targetDb: 'copia',
    });
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.selezione.kind, 'selezione-import');
    assert(res.selezione.fingerprint, 'anche la selezione è un contratto firmato');
    assert.strictEqual(res.selezione.targetDb, 'copia');
    const ordini = res.selezione.voci.find((v) => v.nome === 'ordini');
    assert.strictEqual(ordini.dati, false, 'una collection senza documenti non dichiara dati');

    // Fondere senza identità stabile non è un merge: è un accoda che non lo
    // dice, con duplicati a ogni riesecuzione. Va rifiutato PRIMA di scrivere.
    const rifiutata = await ctx.socket.chiama('database:import:selezione', {
      tabId: 'tab-1', artifact, targetDb: 'copia',
      selezione: { 'tabella:ordini': { struttura: true, politica: 'fondi' } },
    });
    assert.strictEqual(rifiutata.ok, false);
    assert.match(rifiutata.error || '', /identit/i);

    // Un nome scritto male non si salta in silenzio: sarebbe un import
    // incompleto che si dichiara completo.
    const inventata = await ctx.socket.chiama('database:import:selezione', {
      tabId: 'tab-1', artifact, targetDb: 'copia',
      selezione: { 'tabella:inesistente': { struttura: true } },
    });
    assert.strictEqual(inventata.ok, false);
    console.log('  OK   selezione di import firmata, politiche impossibili rifiutate prima di scrivere');
  }

  console.log('  OK   Eventi del piano di export e della selezione di import passed');
})().catch((err) => {
  console.error('  FAIL Eventi del piano di export:', err.stack || err);
  process.exitCode = 1;
});

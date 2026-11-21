'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { MongoClient } = require('mongodb');
const { puliziaImport } = require('../db/importCleanup');

async function verifica(tipo, strategy) {
  const nome = 'prova__codedb_staging_' + randomBytes(5).toString('hex');
  const crea = () => tipo === 'mongodb'
    ? strategy.client.db(nome).createCollection('righe')
    : strategy.createDatabase(nome);
  const esiste = async () => (await strategy.listDatabases()).some(db => db.name === nome);
  let proprietario = false;
  try {
    assert(!await esiste());
    await crea(); proprietario = true;
    const opzioni = { strategy, type: tipo, connName: 'prova' };
    const esito = { status: 'completato', staging: { retained: true, db: nome } };
    const [prima] = await puliziaImport(opzioni).inventarioPulizia(esito);
    await puliziaImport(opzioni).eliminaRisorsa(prima);
    assert(!await esiste());
    await puliziaImport(opzioni).eliminaRisorsa(prima);
    await crea();
    await assert.rejects(puliziaImport(opzioni).eliminaRisorsa(prima), /sostituito/);
    assert(await esiste());
    console.log('OK pulizia idempotente e database omonimo protetto su ' + tipo);
  } finally { if (proprietario && await esiste()) await strategy.dropDatabase(nome); }
}

async function verificaRiavvio(strategy, storico = false) {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-pulizia-'));
  const db = 'audit_' + randomBytes(8).toString('hex');
  const recoveryRoot = path.join(root, 'recupero');
  let creata = false;
  let stagingFixture = null;
  try {
    assert(!(await strategy.listDatabases()).some(d => d.name === db));
    await strategy.client.db(db).createCollection('voci'); creata = true;
    await strategy.client.db(db).collection('voci').insertOne({ _id: 1, valore: 'prima' });
    const diario = require('../db/diarioOperazioni').creaDiario({ radicePer: o => path.join(root, o) });
    const registro = () => require('../db/importOperations').createImportOperationRegistry({ diario });
    const adapter = () => require('../db/importArtifactAdapter').createImportArtifactAdapter({
      strategy, dbType: 'mongodb', connName: 'prova', recoveryRoot });
    const plan = require('../db/importPlan').creaPianoImport({ connection: 'prova', expectedDbType: 'mongodb', targetDb: db, drop: true,
      artifact: { formato: 'codedb-database', versione: 1, dbType: 'mongodb', db: 'origine',
        collections: [{ name: 'voci', docs: [{ _id: 2, valore: 'dopo' }] }] } });
    const prima = registro();
    const iniziale = adapter();
    if (storico) delete iniziale.inventarioPulizia;
    const { operationId } = prima.start({ plan, adapter: iniziale, ownerId: 'tenant', actorId: 'utente' });
    await prima.wait(operationId); await prima.close();
    const voce = diario.leggi({ ownerId: 'tenant', operationId });
    assert.equal(voce.status, 'completato', JSON.stringify(voce));
    if (voce.staging?.retained && voce.staging.db.startsWith(db + '__codedb_staging_')) stagingFixture = voce.staging.db;
    if (storico) {
      delete voce.risorse;
      delete voce.errorePulizia;
      fs.writeFileSync(path.join(root, 'tenant', operationId + '.json'), JSON.stringify(voce));
      const gruppi = fs.readdirSync(recoveryRoot).map(g => path.join(recoveryRoot,g));
      const copie = gruppi.flatMap(g => fs.readdirSync(g, {withFileTypes:true})
        .filter(e => e.isDirectory()).map(e => path.join(g,e.name)));
      assert.equal(copie.length, 2);
      const dopo = registro();
      assert.equal(dopo.get(operationId,'tenant','utente').errorePulizia, null);
      await assert.rejects(dopo.cleanup(operationId,'tenant',adapter(),'utente'), /database tecnico.*verifica/i);
      assert(copie.every(p => fs.existsSync(path.join(p,'manifest.json'))));
      assert(await strategy.client.db(voce.staging.db).collection('voci').findOne());
      // Dopo la verifica manuale, rimuoviamo esclusivamente lo staging di questa fixture.
      assert(voce.staging.db.startsWith(db + '__codedb_staging_'));
      await strategy.dropDatabase(voce.staging.db);
      const manifest = path.join(copie[0], 'manifest.json');
      const originale = fs.readFileSync(manifest);
      const alterato = JSON.parse(originale);
      alterato.connection = 'altra-connessione';
      fs.writeFileSync(manifest, JSON.stringify(alterato));
      await assert.rejects(dopo.cleanup(operationId,'tenant',adapter(),'utente'), /appartenenza|appartiene/i);
      assert(copie.every(p=>fs.existsSync(p)));
      fs.writeFileSync(manifest, originale);
      let n = 0;
      const interrotto = adapter();
      const elimina = interrotto.eliminaRisorsa;
      interrotto.eliminaRisorsa = async r => {
        if (++n === 2) throw new Error('Interruzione della fixture');
        await elimina(r);
      };
      await assert.rejects(dopo.cleanup(operationId,'tenant',interrotto,'utente'), /Interruzione/);
      const residue = diario.leggi({ownerId:'tenant',operationId}).risorse;
      assert.equal(residue.length,1);
      const inatteso = path.join(recoveryRoot,residue[0].relativo,'documento-estraneo.txt');
      fs.writeFileSync(inatteso,'appartiene a un altro processo');
      await assert.rejects(registro().cleanup(operationId,'tenant',adapter(),'utente'),/contenuto.*cambiato/i);
      assert(fs.existsSync(inatteso));
      fs.unlinkSync(inatteso);
      assert((await registro().cleanup(operationId,'tenant',adapter(),'utente')).cleanupAt);
      assert((await registro().cleanup(operationId,'tenant',adapter(),'utente')).cleanupAt);
      assert(copie.every(p=>!fs.existsSync(p)));
      assert.equal((await strategy.client.db(db).collection('voci').findOne()).valore,'dopo');
      console.log('OK diario storico: staging senza marcatore protetto, copie verificate e ripresa dopo interruzione');
      return;
    }
    assert(Array.isArray(voce.risorse) && voce.risorse.some(r => r.tipo === 'file') && voce.risorse.some(r => r.tipo === 'database'));
    const dopo = registro();
    assert((await dopo.cleanup(operationId, 'tenant', adapter(), 'utente')).cleanupAt);
    assert((await registro().cleanup(operationId, 'tenant', adapter(), 'utente')).cleanupAt);
    for (const r of voce.risorse) {
      if (r.tipo === 'file') assert(!fs.existsSync(path.join(recoveryRoot, r.relativo)));
      if (r.tipo === 'database') assert(!(await strategy.listDatabases()).some(d => d.name === r.nome));
    }
    assert.equal((await strategy.client.db(db).collection('voci').findOne()).valore, 'dopo');
    console.log('OK import MongoDB completo, riapertura del diario, rimozione di entrambe le copie su disco e dello staging');
  } finally {
    if (stagingFixture && (await strategy.listDatabases()).some(item => item.name === stagingFixture)) await strategy.dropDatabase(stagingFixture);
    if (creata) await strategy.dropDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function verificaLargeObjectStorico(pg) {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(),'codedb-pulizia-lo-'));
  const nome = 'audit_' + randomBytes(8).toString('hex');
  const cleaner = puliziaImport({ strategy:pg, type:'postgresql', recoveryRoot, connName:'prova' });
  const { rows:[{ oid }] } = await pg.pool.query('SELECT lo_from_bytea(0,$1) AS oid',[Buffer.from('integro')]);
  let creato = true;
  try {
    const voce = { connection:'prova',targetDb:nome,status:'ripristinato_dopo_errore',
      staging:{ db:nome+'__codedb_staging_'+randomBytes(5).toString('hex'), largeObjects:[oid] } };
    await assert.rejects(cleaner.inventarioStorico(voce), /Large Object.*ancora presenti/);
    assert.equal((await pg.pool.query('SELECT lo_get($1) AS dati',[oid])).rows[0].dati.toString(),'integro');
    await pg.pool.query('SELECT lo_unlink($1)',[oid]); creato=false;
    assert.deepEqual(await cleaner.inventarioStorico(voce),[]);
    console.log('OK Large Object storico conservato fino a verifica e rimozione esplicita');
  } finally {
    if(creato) await pg.pool.query('SELECT lo_unlink($1)',[oid]);
    fs.rmSync(recoveryRoot,{recursive:true,force:true});
  }
}

(async () => {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1', 'La prova richiede database di laboratorio dedicati.');
  const mongo = new (require('../db/MongoDbStrategy'))();
  const mysql = new (require('../db/MySqlStrategy'))();
  const pg = new (require('../db/PostgreSqlStrategy'))();
  mongo.client = new MongoClient(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017');
  try {
    await mongo.client.connect();
    await verifica('mongodb', mongo);
    await verificaRiavvio(mongo);
    await verificaRiavvio(mongo, true);
    await mysql.connect({ host: '127.0.0.1', port: Number(process.env.MYSQL_PORT) || 3306,
      username: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD || '' });
    await verifica('mysql', mysql);
    await pg.connect({ host: '127.0.0.1', port: Number(process.env.PG_PORT) || 5432,
      username: process.env.PG_USER || 'postgres', password: process.env.PG_PASSWORD || '', database: 'postgres' });
    await verifica('postgresql', pg);
    await verificaLargeObjectStorico(pg);
  } finally {
    await Promise.all([mongo.disconnect(), mysql.disconnect(), pg.disconnect()]);
  }
})().catch(err => { console.error(err); process.exitCode = 1; });

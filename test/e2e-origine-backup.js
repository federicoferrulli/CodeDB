'use strict';

// Impostare CODEDB_E2E_MONGO_URI su un MongoDB di prova in replica set.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Mongo = require('../db/MongoDbStrategy');
const { makePrincipal } = require('../auth/principal');
const { creaFlussoConferma } = require('../mcp/conferma');
const { registraStrumentiArtefatti } = require('../mcp/strumenti-artefatti');

async function run() {
  const uri = process.env.CODEDB_E2E_MONGO_URI;
  if (!uri) throw new Error('Imposta CODEDB_E2E_MONGO_URI.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-provenienza-'));
  const root = path.join(tmp, 'backup');
  const config = require('../server/configurazione').configurazione({ rootDir: tmp, env: {
    CODEDB_RBAC: 'on', CODEDB_CONNECTIONS_FILE: path.join(tmp, 'connections.ini'), CODEDB_CONNECTIONS_DIR: path.join(tmp, 'conns'),
  } });
  const vault = require('../server/vault').createModule({ config, errori: {}, dependencies: {} });
  const owner = makePrincipal({ _id: 'tenant', ownerId: 'tenant', type: 'owner' });
  let principal = owner;
  const id = crypto.randomBytes(8).toString('hex');
  const db = 'e2e_fonte_' + id, target = 'e2e_dest_' + id;
  const strategia = new Mongo(), propri = [];
  const salvata = vault.identificaOrigine({ dbType: 'mongodb', connectionMode: 'uri', uri });
  vault.saveConnections({ fonte: salvata }, owner.ownerId);
  const sess = { strategy: strategia, dbType: 'mongodb', name: 'fonte', backupOriginId: salvata.backupOriginId };
  const deps = { loadConnections: vault.loadConnections, connectionsFileFor: vault.connectionsFileFor, confirmQuota: { reserve: () => ({}), release() {} } };
  const session = { id, pendingWrites: new Map() }, sessionPrincipal = () => principal;
  const tools = new Map();
  registraStrumentiArtefatti({ tool: (name, _, fn) => tools.set(name, fn), session, deps, env: {}, audit() {},
    confirmFlow: creaFlussoConferma({ session, deps, sessionPrincipal }), backupRootOf: () => root, sessionPrincipal,
    requireDbSession: key => key === 'fonte' ? sess : { ...sess, name: 'dest' }, refreshWritesAllowed: () => true });
  const chiama = async (name, args) => JSON.parse((await tools.get(name)(args)).content[0].text);
  const utente = (source, databases, collections) => makePrincipal({ _id: 'sub', ownerId: owner.ownerId, type: 'subuser' }, [
    { connName: 'dest', capabilities: ['manage', 'read'], scope: null },
    { connName: source, capabilities: ['read'], scope: { databases, collections } },
  ]);
  const ui = new Map(), ctx = { get principal() { return principal; }, sessions: new Map([['tab', { ...sess, connName: 'dest' }]]) };
  const identita = require('../server/identita').createModule({ config, trasporto: { app: { post() {} }, io: { use() {} } }, dependencies: {}, audit: {}, errori: {} });
  const operazioni = { backupRootOf: () => root,
    resolveBackupPath: (_p, value) => require('../backup/lib/policy').resolveBackupPath(value, root) };
  require('../server/eventi-backup').createModule({ lock: { normTabId: () => 'tab' }, identita, config, vault, operazioni })(ctx, { safeOn: (name, f) => ui.set(name, f) });
  const eventiVault = new Map();
  require('../server/eventi-vault').createModule({ config, vault, identita: { ...identita, async revocaAccessiConnessione() {} } })(ctx, {
    amministrativo: (name, f) => eventiVault.set(name, f),
  });
  try {
    await strategia.connect({ uri });
    for (const [name, coll] of [[db, 'visibile'], [target, 'sentinella']]) {
      await strategia.createDatabase(name, coll); propri.push(name);
    }
    const source = strategia.client.db(db);
    await source.collection('visibile').insertOne({ _id: 1, valore: 'uno' });
    await source.collection('riservata').insertOne({ _id: 2, valore: 'due' });
    const backup = type => chiama('backup_database', { connection_id: 'fonte', db, type, no_compress: true });
    const full = await backup('full');
    await source.collection('visibile').updateOne({ _id: 1 }, { $set: { valore: 'tre' } });
    const delta = await backup('incremental');
    const chiavi = { group: delta.group, backup_id: delta.backup_id };
    const args = { ...chiavi, connection_id: 'dest', target_db: target, collections: 'visibile' };
    principal = makePrincipal({ _id: 'tenant', ownerId: 'tenant', type: 'owner' }, [], ['dest']);
    assert.deepEqual((await chiama('list_backups', {})).groups, {});
    let catalogo;
    await ui.get('backup:list')({}, res => { catalogo = res.groups; });
    assert.deepEqual(catalogo, {});
    const uiArgs = { group: delta.group, backupId: delta.backup_id, collections: ['visibile'] };
    await assert.rejects(ui.get('backup:restore')(uiArgs, () => {}), /Permesso/);
    await assert.rejects(ui.get('backup:verify')(uiArgs, () => {}), /Permesso/);
    await assert.rejects(chiama('verify_backup', chiavi), /Permesso/);
    await assert.rejects(chiama('restore_backup', args), /Permesso/);
    principal = utente('fonte', [db], ['visibile']);
    assert.deepEqual((await chiama('list_backups', {})).groups, {});
    await assert.rejects(chiama('restore_backup', { ...args, collections: 'riservata' }), /Permesso/);
    await assert.rejects(chiama('restore_backup', { ...args, collections: ' , ' }), /Permesso/);
    const anteprima = await chiama('restore_backup', args);
    assert.equal(anteprima.requires_confirmation, true);
    principal = utente('fonte', ['altro_db'], ['visibile']);
    await assert.rejects(chiama('restore_backup', { ...args, confirm_token: anteprima.confirm_token }), /Permesso/);
    assert.equal(await strategia.client.db(target).collection('visibile').countDocuments(), 0);
    principal = utente('fonte', [db], ['visibile']);
    const ripristino = await chiama('restore_backup', { ...args, confirm_token: anteprima.confirm_token });
    assert.equal(ripristino.executed, true, JSON.stringify(ripristino));
    assert.equal((await strategia.client.db(target).collection('visibile').findOne({ _id: 1 })).valore, 'tre');
    assert.equal(await strategia.client.db(target).collection('riservata').countDocuments(), 0);
    principal = utente('fonte', [db], ['*']);
    assert.equal((await chiama('list_backups', {})).groups[delta.group].length, 2);
    assert.equal((await chiama('verify_backup', chiavi)).valid, true);
    const file = path.join(root, full.group, full.backup_id, 'manifest.json');
    const originale = fs.readFileSync(file, 'utf8');
    const storico = JSON.parse(originale);
    const indici = path.join(path.dirname(file), storico.files.find(f => f.collection === 'riservata' && f.kind === 'indexes').path);
    const datiIndici = fs.readFileSync(indici);
    fs.writeFileSync(indici, '{}');
    try {
      principal = utente('fonte', [db], ['visibile']);
      await assert.rejects(chiama('restore_backup', args),
        err => err.message.includes('Verifica del backup fallita') && !err.message.includes('riservata'));
      principal = utente('fonte', [db], ['*']);
      await assert.rejects(chiama('restore_backup', args), /indici MongoDB di "riservata"/);
    } finally { fs.writeFileSync(indici, datiIndici); }
    storico.notes = ['modifica del manifest dopo la firma'];
    fs.writeFileSync(file, JSON.stringify(storico));
    await assert.rejects(chiama('restore_backup', args), /Permesso/);
    principal = owner;
    await assert.rejects(chiama('verify_backup', chiavi), /Permesso/);
    await assert.rejects(ui.get('backup:restore')(uiArgs, () => {}), /Permesso/);
    principal = utente('fonte', [db], ['*']);
    delete storico.origine;
    fs.writeFileSync(file, JSON.stringify(storico));
    await assert.rejects(chiama('restore_backup', args), /Permesso/);
    principal = owner;
    assert.equal((await chiama('verify_backup', { group: full.group, backup_id: full.backup_id })).valid, true);
    fs.writeFileSync(file, originale);
    const origine = require('../backup/lib/origine');
    const confMigrata = path.join(tmp, 'migrata.ini');
    const vaultMigrato = { connectionsFileFor: () => confMigrata };
    assert.throws(() => origine.verificaOrigine(owner, path.dirname(file), null, root, vaultMigrato), /Permesso/);
    fs.copyFileSync(vault.connectionsFileFor(owner.ownerId) + '.backup-signing-key', confMigrata + '.backup-signing-key');
    origine.verificaOrigine(owner, path.dirname(file), null, root, vaultMigrato);
    await eventiVault.get('connections:save')({ oldName: 'fonte', name: 'rinominata', cfg: {} }, () => {});
    await eventiVault.get('connections:save')({ name: 'fonte', cfg: { ...salvata } }, () => {});
    principal = utente('fonte', [db], ['*']);
    await assert.rejects(chiama('restore_backup', args), /Permesso/);
    principal = utente('rinominata', [db], ['*']);
    assert.equal((await chiama('verify_backup', chiavi)).valid, true);
    console.log('OK backup: catalogo, scope, controllo di tutti i layer, firma, conferma, restore selettivo, rinomina e riuso del nome.');
  } finally {
    try { for (const name of propri) await strategia.dropDatabase(name); }
    finally {
      await strategia.disconnect();
      assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
      assert.match(path.basename(tmp), /^codedb-provenienza-/);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}
run().catch(err => { console.error(err); process.exitCode = 1; });

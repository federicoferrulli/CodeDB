'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');
const PostgreSql = require('../db/PostgreSqlStrategy');
const { makePrincipal } = require('../auth/principal');
const { creaFlussoConferma } = require('../mcp/conferma');
const { registraStrumentiArtefatti } = require('../mcp/strumenti-artefatti');

async function run() {
  if (!process.env.E2E_PG_PORT) throw new Error('Imposta E2E_PG_PORT sulla porta PostgreSQL di prova.');
  const accesso = { host: process.env.E2E_PG_HOST || '127.0.0.1', port: Number(process.env.E2E_PG_PORT),
    user: process.env.E2E_PG_USER || 'postgres', password: process.env.E2E_PG_PASSWORD || '' };
  const admin = new Client({ ...accesso, database: 'postgres' });
  const database = 'e2e_origine_' + crypto.randomBytes(10).toString('hex');
  const strategy = new PostgreSql();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-origine-pg-'));
  const root = path.join(tmp, 'backup');
  let creato = false;
  try {
    await admin.connect();
    await admin.query('CREATE DATABASE "' + database + '"');
    creato = true;
    await strategy.connect({ ...accesso, username: accesso.user, database });
    const q = sql => strategy.pool.query(sql);
    await q('CREATE SCHEMA sorgente');
    await q('CREATE TABLE sorgente.visibile (id integer PRIMARY KEY)');
    await q('INSERT INTO sorgente.visibile VALUES (71)');
    await q('CREATE TABLE sorgente.privata (id integer PRIMARY KEY, file_oid oid)');
    const config = require('../server/configurazione').configurazione({ rootDir: tmp, env: {
      CODEDB_RBAC: 'on', CODEDB_CONNECTIONS_FILE: path.join(tmp, 'connections.ini'), CODEDB_CONNECTIONS_DIR: path.join(tmp, 'conns'),
    } });
    const vault = require('../server/vault').createModule({ config, errori: {}, dependencies: {} });
    const owner = makePrincipal({ _id: 'tenant', ownerId: 'tenant', type: 'owner' });
    const salvata = vault.identificaOrigine({ dbType: 'postgres', host: accesso.host, port: String(accesso.port), database });
    vault.saveConnections({ fonte: salvata }, owner.ownerId);
    const sess = { strategy, dbType: 'postgresql', name: 'fonte', backupOriginId: salvata.backupOriginId };
    const dest = { ...sess, name: 'dest', connName: 'dest' };
    let principal = owner;
    const lettore = scope => makePrincipal({ _id: 'sub', ownerId: 'tenant', type: 'subuser' }, [
      { connName: 'fonte', capabilities: ['read'], scope },
      { connName: 'dest', capabilities: ['manage', 'read'], scope: null },
    ]);
    const tabella = lettore({ databases: ['sorgente'], collections: ['visibile'] });
    const schema = lettore({ databases: ['sorgente'], collections: ['*'] });
    const databaseIntero = lettore(null);
    const session = { id: 'test', pendingWrites: new Map() }, sessionPrincipal = () => principal;
    const deps = { ...vault, confirmQuota: { reserve: () => ({}), release() {} } };
    const tools = new Map(), ui = new Map();
    registraStrumentiArtefatti({ tool: (name, _, fn) => tools.set(name, fn), session, deps, env: {}, audit() {},
      confirmFlow: creaFlussoConferma({ session, deps, sessionPrincipal }), backupRootOf: () => root, sessionPrincipal,
      requireDbSession: id => id === 'fonte' ? sess : dest, refreshWritesAllowed: () => true });
    const chiama = async (name, args) => JSON.parse((await tools.get(name)(args)).content[0].text);
    const ctx = { get principal() { return principal; }, sessions: new Map([['tab', dest]]) };
    const identita = require('../server/identita').createModule({ config, trasporto: { app: { post() {} }, io: { use() {} } }, dependencies: {}, audit: {}, errori: {} });
    const operazioni = { backupRootOf: () => root, resolveBackupPath: (_, value) => require('../backup/lib/policy').resolveBackupPath(value, root) };
    require('../server/eventi-backup').createModule({ lock: { normTabId: () => 'tab' }, identita, config, vault, operazioni,
      audit: { auditWrite() {} }, errori: { errMsg: err => err.message } })(ctx, { safeOn: (name, fn) => ui.set(name, fn) });
    const eventiVault = new Map();
    require('../server/eventi-vault').createModule({ config, identita, vault })(ctx, {
      amministrativo: (name, fn) => eventiVault.set(name, fn),
    });
    const modificaFonte = async cfg => {
      principal = owner;
      await eventiVault.get('connections:save')({ oldName: 'fonte', name: 'fonte', cfg }, ack => assert.equal(ack.ok, true));
    };
    const backup = async () => {
      principal = owner;
      const { group, backup_id } = await chiama('backup_database', { connection_id: 'fonte', db: 'sorgente', type: 'full', no_compress: true });
      return { connection_id: 'dest', group, backup_id, collections: 'visibile', target_db: 'destinazione' };
    };
    const negato = async (args, utente) => {
      principal = utente;
      await assert.rejects(chiama('restore_backup', args), /Permesso di lettura/);
      await assert.rejects(ui.get('backup:restore')({ group: args.group, backupId: args.backup_id,
        collections: ['visibile'], targetDb: args.target_db }, () => {}), /Permesso di lettura/);
    };

    // Una tabella senza dipendenze globali resta ripristinabile con il solo grant sulla tabella.
    const semplice = await backup();
    const chiavi = { group: semplice.group, backup_id: semplice.backup_id };
    const verificaComeLettore = async () => {
      principal = databaseIntero;
      const catalogo = await chiama('list_backups', {});
      assert.equal(catalogo.groups[chiavi.group]?.length, 1, 'Il lettore deve vedere il backup firmato della connessione');
      assert.equal((await chiama('verify_backup', chiavi)).valid, true);
    };
    await verificaComeLettore();
    await modificaFonte({ dbType: 'postgresql' });
    await verificaComeLettore();
    principal = tabella;
    const preview = await chiama('restore_backup', semplice);
    assert.equal(preview.requires_confirmation, true);
    assert.equal((await chiama('restore_backup', { ...semplice, confirm_token: preview.confirm_token })).executed, true);
    assert.deepEqual((await q('SELECT id FROM destinazione.visibile')).rows, [{ id: 71 }]);
    assert.equal((await q("SELECT to_regclass('destinazione.privata') AS nome")).rows[0].nome, null);

    // Anche i file esclusi vengono verificati. Il dettaglio del file guasto arriva
    // al client solo se il suo grant permette la verifica della sorgente completa.
    const dir = path.join(root, semplice.group, semplice.backup_id);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const privato = manifest.files.find(f => f.kind === 'data' && f.collection === 'privata').path;
    const file = path.join(dir, privato), dati = fs.readFileSync(file);
    fs.appendFileSync(file, '\n');
    try {
      for (const utente of [tabella, schema, owner]) {
        principal = utente;
        const controlla = msg => utente === tabella
          ? msg.includes('Verifica del backup fallita') && !msg.includes(privato)
          : msg.includes(privato);
        const token = (await chiama('restore_backup', semplice)).confirm_token;
        await assert.rejects(chiama('restore_backup', { ...semplice, confirm_token: token }), err => controlla(err.message));
        let esito;
        await ui.get('backup:restore')({ group: semplice.group, backupId: semplice.backup_id,
          collections: ['visibile'], targetDb: semplice.target_db }, ack => { esito = ack; });
        assert.equal(esito.ok, false);
        assert.ok(controlla(esito.error), esito.error);
      }
    } finally { fs.writeFileSync(file, dati); }

    // Tipo e routine estranei alla selezione richiedono ciascuno il grant di schema.
    for (const [crea, elimina, target] of [
      ["CREATE TYPE sorgente.colore AS ENUM ('rosso')", 'DROP TYPE sorgente.colore', 'ripristino_tipo'],
      ['CREATE FUNCTION sorgente.riservata() RETURNS int LANGUAGE sql AS $$SELECT 42$$', 'DROP FUNCTION sorgente.riservata()', 'ripristino_routine'],
    ]) {
      await q(crea);
      const conOggetti = await backup();
      conOggetti.target_db = target;
      await negato(conOggetti, tabella);
      principal = schema;
      const autorizzato = await chiama('restore_backup', conOggetti);
      assert.equal(autorizzato.requires_confirmation, true);
      principal = tabella;
      await assert.rejects(chiama('restore_backup', { ...conOggetti, confirm_token: autorizzato.confirm_token }), /Permesso di lettura/);
      principal = schema;
      const ripristino = await chiama('restore_backup', { ...conOggetti, confirm_token: autorizzato.confirm_token });
      assert.equal(ripristino.executed, true, JSON.stringify(ripristino));
      assert.deepEqual((await q('SELECT id FROM ' + target + '.visibile')).rows, [{ id: 71 }]);
      await q(elimina);
    }
    // L'OID del file compare soltanto nella tabella privata. I Large Object sono
    // globali al database fisico e un grant su uno schema non copre i loro byte.
    await q("INSERT INTO sorgente.privata VALUES (1, lo_from_bytea(0, convert_to('contenuto', 'UTF8')))");
    const conBinario = await backup();
    await negato(conBinario, tabella);
    await negato(conBinario, schema);
    principal = databaseIntero;
    assert.equal((await chiama('restore_backup', conBinario)).requires_confirmation, true);
    await modificaFonte({ database: database + '_diverso' });
    principal = databaseIntero;
    assert.deepEqual((await chiama('list_backups', {})).groups, {});
    await assert.rejects(chiama('verify_backup', chiavi), /Permesso di lettura/);
    console.log('OK PostgreSQL: ripristino selettivo, controlli UI/MCP, schema, conferma e Large Object del database fisico.');
  } finally {
    try { await strategy.disconnect(); }
    finally {
      try { if (creato) await admin.query('DROP DATABASE "' + database + '"'); }
      finally {
        await admin.end();
        assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
        assert.match(path.basename(tmp), /^codedb-origine-pg-/);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
}
run().catch(err => { console.error(err); process.exitCode = 1; });

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { utils } = require('ssh2');
const { ROOT_PRINCIPAL, makePrincipal } = require('../auth/principal');
const { configurazione } = require('../server/configurazione');
const { contestoFinto } = require('./contesto-finto');

module.exports = (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-ssh-config-'));
  const config = configurazione({ desktop: null, env: {
    CODEDB_RBAC: 'on', CODEDB_VAULT_ADMINS: 'admin-fixture@localhost',
    CODEDB_OWNER_EMAIL: '', GUI_MONGO_PASSPHRASE: 'vault-solo-di-prova',
    CODEDB_CONNECTIONS_FILE: path.join(root, 'connections.ini'),
    CODEDB_CONNECTIONS_DIR: path.join(root, 'tenants'),
    CODEDB_BACKUPS_DIR: path.join(root, 'backups'), CODEDB_SCRIPT_RESULTS_DIR: path.join(root, 'results'),
    CODEDB_UI_AUDIT_FILE: path.join(root, 'ui.log'), CODEDB_MCP_AUDIT_FILE: path.join(root, 'mcp.log'),
  } });
  const errori = require('../server/errori').createModule({});
  const dependencies = { DbFactory: require('../db/DbFactory') };
  const creaVault = () => require('../server/vault').createModule({ config, errori, dependencies });
  const vault = creaVault();
  const ownerA = makePrincipal({ _id: 'owner-a', type: 'owner', email: 'tenant-a@localhost' });
  const ownerB = makePrincipal({ _id: 'owner-b', type: 'owner', email: 'tenant-b@localhost' });
  const admin = makePrincipal({ _id: 'admin-fixture', type: 'owner', email: 'admin-fixture@localhost' });
  const child = makePrincipal({ _id: 'child-a', ownerId: 'owner-a', type: 'subuser' });
  const identita = require('../server/identita').createModule({
    config, errori, dependencies, audit: {},
    trasporto: { app: require('express')(), io: { use() {}, sockets: { sockets: new Map() } } },
  });
  const revocations = [];
  const registra = require('../server/eventi-vault').createModule({ config, vault, identita: {
    ...identita,
    // Il control plane non serve: si conserva la revoca richiesta, senza aprire un database.
    async revocaAccessiConnessione(...args) { revocations.push(args); return { deleted: 0, subjectIds: [] }; },
  } });
  function client(principal) {
    const handlers = new Map();
    registra(contestoFinto({ principal }), { amministrativo(event, handler) { handlers.set(event, handler); } });
    return async (event, payload = {}) => {
      let result;
      try { await handlers.get(event)(payload, value => { result = value; }); }
      catch (error) { return { ok: false, error: error.message, code: error.code }; }
      assert(result, `L’evento ${event} deve rispondere`);
      return result;
    };
  }
  const a = client(ownerA), b = client(ownerB), sub = client(child), local = client(ROOT_PRINCIPAL);
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privatePem = pair.privateKey.export({ type: 'sec1', format: 'pem' });
  const publicBlob = utils.parseKey(privatePem).getPublicSSH();
  const publicText = `ecdsa-sha2-nistp256 ${publicBlob.toString('base64')} fixture-config`;
  const der = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
  const envelope = 'base64:' + der.toString('base64');
  const passphrase = 'passphrase-config-non-reale';
  const protectedPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase });
  const cfg = { connectionMode: 'fields', dbType: 'mongodb', host: '127.0.0.1', port: '27017', ssh: 'true',
    sshHost: '127.0.0.1', sshPort: '22', sshUser: 'fixture', sshAuth: 'upload', sshPrivateKey: envelope, sshKeyName: 'fixture.der' };
  const fileA = path.join(root, 'tenants', 'owner-a.ini');
  const fileB = path.join(root, 'tenants', 'owner-b.ini');
  let server;
  try {
    const validation = await a('ssh:key:validate', { cfg });
    assert.equal(validation.ok, true, validation.error);
    assert.equal(validation.algorithm, 'ecdsa-sha2-nistp256');
    assert.equal(validation.fingerprint, 'SHA256:' + crypto.createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, ''));
    assert.deepEqual(Object.keys(validation).sort(), ['algorithm', 'encrypted', 'fingerprint', 'format', 'message', 'ok', 'requiresAgent', 'securityKey']);
    assert(!JSON.stringify(validation).includes(envelope));
    assert.equal(fs.existsSync(fileA), false, 'La validazione non salva il file');
    console.log('  OK   Configurazione SSH: validazione reale, soli metadati e nessuna scrittura');

    for (const invalid of [
      { sshPrivateKey: 'file-non-valido' },
      { sshPrivateKey: 'base64:!!!' },
      { sshPrivateKey: protectedPem, sshPassphrase: 'errata' },
      { sshPrivateKey: protectedPem, sshPassphrase: '' },
    ]) {
      const response = await a('connections:save', { name: 'non-salvare', cfg: { ...cfg, ...invalid } });
      assert.equal(response.ok, false, 'Una chiave non apribile non deve essere salvata');
      assert.equal(fs.existsSync(fileA), false);
    }
    const missing = await a('ssh:key:validate', { cfg: { ...cfg, sshPrivateKey: protectedPem, sshPassphrase: '' } });
    assert.equal(missing.code, 'SSH_KEY_PASSPHRASE_REQUIRED');
    assert(!JSON.stringify(missing).includes(protectedPem));
    const opened = await a('ssh:key:validate', { cfg: { ...cfg, sshPrivateKey: protectedPem, sshPassphrase: passphrase } });
    assert.equal(opened.ok, true, opened.error);
    assert(!JSON.stringify(opened).includes(passphrase));
    console.log('  OK   Configurazione SSH: file e passphrase errati non vengono salvati');

    assert.equal((await a('connections:save', { name: 'comune', cfg })).ok, true);
    const written = fs.readFileSync(fileA, 'utf8');
    assert.match(written, /sshPrivateKey=ENC:/);
    assert(!written.includes(der.toString('base64')));
    assert.equal(creaVault().loadConnections(ownerA.ownerId).comune.sshPrivateKey, envelope);
    const get = await a('connections:get', { name: 'comune' });
    assert.equal(get.hasSshPrivateKey, true);
    assert.equal(get.fields.sshPrivateKey, undefined);
    assert.equal((await b('connections:get', { name: 'comune' })).ok, false);
    assert.equal((await b('ssh:key:validate', { cfg: { ...cfg, sshPrivateKey: '' }, editName: 'comune' })).ok, false);
    assert.equal((await b('connections:save', { name: 'comune', cfg: { ...cfg, sshKeyName: 'altro-tenant.der' } })).ok, true);
    assert.equal(vault.loadConnections(ownerB.ownerId).comune.sshKeyName, 'altro-tenant.der');
    assert.equal(vault.loadConnections(ownerA.ownerId).comune.sshKeyName, 'fixture.der');
    assert(fs.existsSync(fileA) && fs.existsSync(fileB));
    assert.equal(fs.existsSync(config.env.CODEDB_CONNECTIONS_FILE), false);
    const reused = await a('ssh:key:validate', { cfg: { ...cfg, sshPrivateKey: '' }, editName: 'comune' });
    assert.equal(reused.ok, true, reused.error);
    assert.equal(reused.fingerprint, validation.fingerprint);
    console.log('  OK   Configurazione SSH: DER cifrato ricaricabile e connessioni isolate per owner');

    const encryptedSaved = await a('connections:save', { name: 'protetta', cfg: { ...cfg, sshPrivateKey: protectedPem, sshPassphrase: passphrase } });
    assert.equal(encryptedSaved.ok, true, encryptedSaved.error);
    const beforeWrong = fs.readFileSync(fileA, 'utf8');
    const replacement = await a('connections:save', { name: 'protetta', oldName: 'protetta', cfg: { ...cfg, sshPrivateKey: protectedPem, sshPassphrase: 'errata' } });
    assert.equal(replacement.ok, false);
    assert.equal(fs.readFileSync(fileA, 'utf8'), beforeWrong, 'Il fallimento deve conservare il file precedente alla lettera');
    const reusedSecret = await a('ssh:key:validate', { cfg: { ...cfg, sshPrivateKey: '', sshPassphrase: '' }, editName: 'protetta' });
    assert.equal(reusedSecret.ok, true, reusedSecret.error);
    assert(!JSON.stringify(await a('connections:get', { name: 'protetta' })).includes(passphrase));

    for (const event of ['ssh:key:validate', 'connections:save']) {
      const denied = await sub(event, { name: 'vietata', cfg });
      assert.equal(denied.ok, false);
      assert.match(denied.error, /Permesso negato/);
    }
    for (const event of ['ssh:key:validate', 'connections:save']) {
      const denied = await a(event, { name: 'agente-vietato', allowHostAgent: true, cfg: {
        ...cfg, sshPrivateKey: publicText, allowHostAgent: true, root: true, ownerId: 'local',
      } });
      assert.equal(denied.ok, false);
      assert.equal(denied.code, 'SSH_KEY_AGENT_FORBIDDEN', 'Il tenant non può usare l’agente dell’host né aggirare il gate nel payload');
    }
    assert.equal(vault.loadConnections(ownerA.ownerId)['agente-vietato'], undefined);
    console.log('  OK   Configurazione SSH: permessi owner e agente host non aggirabili dal payload');

    // Si simula una configurazione già salvata: per rinominarla non serve accedere all’agente.
    const pin = 'PIN-fixture-da-non-esporre';
    vault.saveConnections({ precedente: vault.sanitizeConnCfg({ ...cfg, sshPrivateKey: publicText, sshSecurityKeyPin: pin }) }, ROOT_PRINCIPAL.ownerId);
    const rawPin = fs.readFileSync(config.env.CODEDB_CONNECTIONS_FILE, 'utf8');
    assert.match(rawPin, /sshSecurityKeyPin=ENC:/);
    assert(!rawPin.includes(pin));
    const pinFields = await local('connections:get', { name: 'precedente' });
    assert.equal(pinFields.hasSshSecurityKeyPin, true);
    assert(!JSON.stringify(pinFields).includes(pin));
    const renamed = await local('connections:save', { name: 'rinominata', oldName: 'precedente', cfg: { ...cfg, sshPrivateKey: '' } });
    assert.equal(renamed.ok, true, renamed.error);
    assert.equal(vault.loadConnections('local').rinominata.sshPrivateKey, publicText);
    assert.equal(vault.loadConnections('local').rinominata.sshSecurityKeyPin, pin);
    assert.equal(vault.loadConnections('local').precedente, undefined);
    assert.equal(revocations.length, 1);
    assert.deepEqual(revocations[0].slice(0, 2), ['local', 'precedente']);
    const changeIdentity = await local('connections:save', { name: 'rinominata', oldName: 'rinominata', cfg });
    assert.equal(changeIdentity.ok, true, changeIdentity.error);
    assert.equal(vault.loadConnections('local').rinominata.sshSecurityKeyPin, undefined, 'Il PIN non deve essere trasferito a una nuova identità');
    console.log('  OK   Configurazione SSH: chiave salvata invariata rinominabile senza agente');

    const captured = [];
    const adapters = {
      ...dependencies,
      DbFactory: { ...dependencies.DbFactory, getStrategy: () => ({
        type: 'mongodb', async connect() {}, async disconnect() {}, async listDatabases() { return []; },
      }) },
      async openSshTunnel(_cfg, _target, options) {
        captured.push(options.allowHostAgent);
        return { host: '127.0.0.1', port: 1, close() {} };
      },
    };
    async function verificaOpzioni(factory) {
      const connection = factory.createModule({ config, vault, dependencies: adapters, errori });
      for (const [principal, allowed] of [[ROOT_PRINCIPAL, true], [admin, true], [ownerA, false], [child, false], [null, false]]) {
        const before = captured.length;
        const result = await connection.establishConnection({ ...cfg, allowHostAgent: !allowed }, { principal });
        await connection.teardownConnection(result);
        assert.equal(captured.length, before + 1);
        assert.equal(captured.at(-1), allowed, 'Il permesso agente deve provenire dal principal e dalla configurazione dell’istanza');
      }
    }
    await verificaOpzioni(require('../server/connessioni'));

    const { createServer } = require('../server');
    server = createServer({ config: { desktop: null, env: { ...config.env, CODEDB_RBAC: 'off' } }, dependencies: adapters });
    for (const [principal, allowed] of [[ROOT_PRINCIPAL, true], [admin, true], [ownerA, false]]) {
      const context = contestoFinto({ principal });
      server.registraEventi(context);
      const response = await context.socket.chiama('connections:test', { ...cfg, allowHostAgent: !allowed });
      assert.equal(response.ok, true, response.error);
      assert.equal(captured.at(-1), allowed, 'createServer deve passare la configurazione dell’istanza al modulo connessioni');
    }
    await server.stop(); server = null;
    console.log('  OK   Configurazione SSH: root/admin abilitati e tenant esclusi anche nella composizione server');

    const filename = require.resolve('../server/connessioni');
    const source = fs.readFileSync(filename, 'utf8');
    const original = 'allowHostAgent: isInstallAdmin(guardCtx?.principal, config?.env),';
    assert(source.includes(original), 'La prova di sensibilità deve modificare il controllo reale');
    const mutant = new Module(filename, module);
    mutant.filename = filename;
    mutant.paths = Module._nodeModulePaths(path.dirname(filename));
    mutant._compile(source.replace(original, 'allowHostAgent: true,'), filename);
    await assert.rejects(verificaOpzioni(mutant.exports), { name: 'AssertionError' }, 'Forzare il permesso agente deve far fallire il test');
    console.log('  OK   Configurazione SSH: sensibilità confermata sul gate agente, senza alterare file o moduli globali');
  } finally {
    await server?.stop();
    await identita.close();
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

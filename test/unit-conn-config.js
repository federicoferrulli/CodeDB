'use strict';

const assert = require('node:assert/strict');

module.exports = (async () => {
  const vault = require('../server/vault').createModule({
    config: require('../server/configurazione').configurazione({ env: {} }),
    errori: { errMsg: error => error.message }, dependencies: { DbFactory: require('../db/DbFactory') },
  });
  // Nessun accesso al vault su disco: il test usa solo configurazioni fittizie in memoria.
  const original = vault.sanitizeConnCfg;
  if (process.argv.includes('--mutant')) vault.sanitizeConnCfg = cfg => original(cfg);
  const previous = original({ dbType: 'postgresql', host: 'db.example.test', port: '27017', username: 'utente',
    password: 'password-fittizia', database: 'archivio', readOnly: 'false', folder: 'Collaudo',
    ssh: 'true', sshHost: 'ssh.example.test', sshPort: '2222', sshUser: 'tunnel', sshAuth: 'upload',
    sshPrivateKey: 'chiave-fittizia', sshKeyName: 'id_prova', sshPassphrase: 'passphrase-fittizia' });
  const updated = vault.sanitizeConnCfg({ folder: '', password: '' }, previous);
  assert(Object.keys(previous).every(key => key === 'folder' ? !updated[key] : updated[key] === previous[key]),
    'Un aggiornamento parziale conserva parametri omessi e segreti vuoti');
  for (const change of [{ sshAuth: 'path', sshKeyFile: '/nuova-chiave' }, { sshPrivateKey: 'nuova-chiave' }, { ssh: '' }]) {
    const next = vault.sanitizeConnCfg(change, previous);
    assert(!next.sshPassphrase, 'La passphrase non segue una chiave diversa o un tunnel disattivato');
    if (!change.sshPrivateKey) assert(!next.sshPrivateKey, 'La vecchia chiave non resta attiva');
  }
  const uri = vault.sanitizeConnCfg({ uri: 'mongodb://utente:password-fittizia@host/app', dbType: 'mongodb' }, previous);
  assert.equal(uri.connectionMode, 'uri');
  assert(!uri.password && !uri.ssh && !uri.sshPrivateKey, 'Il cambio a URI disattiva SSH e i vecchi segreti');
  assert.equal(vault.sanitizeConnCfg({ folder: 'Altra' }, uri).uri === uri.uri, true, 'Una URI omessa rimane salvata');
  const fields = vault.sanitizeConnCfg({ connectionMode: 'fields', host: 'nuovo-host' }, uri);
  assert(!fields.uri, 'Il passaggio esplicito ai parametri rimuove la vecchia URI');
  assert.equal(vault.sanitizeConnCfg({ username: '', database: '' }, previous).username, undefined);
  assert.equal(vault.sanitizeConnCfg({ username: '', database: '' }, previous).database, undefined);
  assert(!vault.sanitizeConnCfg({ sconosciuto: 'non salvare' }, previous).sconosciuto, 'Solo i campi ammessi vengono salvati');
  assert.throws(() => vault.sanitizeConnCfg({ sshPrivateKey: 'x'.repeat(65537) }, previous), /64 KB/);

  let received;
  vault.loadConnections = () => ({ prova: previous });
  const engine = require('../server/connessioni').createModule({ vault, errori: {}, dependencies: {
    DbFactory: { getStrategy: () => ({ async connect(cfg) { received = cfg; }, async disconnect() {} }) },
  } });
  const connection = await engine.establishConnection({ keepPasswordFrom: 'prova', ssh: '', folder: 'Altra' });
  assert(['host', 'port', 'database', 'readOnly', 'password'].every(key => received[key] === previous[key]),
    'Testa e Connetti conservano gli stessi parametri del salvataggio');
  await engine.teardownConnection(connection);
  await assert.rejects(engine.establishConnection({ keepPasswordFrom: 'rimossa' }), /non trovata/);
  await assert.rejects(engine.establishConnection({ uri: uri.uri, ssh: 'true' }), /non con URI completa/,
    'SSH richiesto esplicitamente non deve essere ignorato per collegarsi direttamente');

  const { riepilogoUri } = await import('../public/js/riepilogo-uri.mjs');
  const preview = riepilogoUri('mongodb://utente:segreto@a:27017,b:27018/app?authSource=admin&tls=true&authMechanismProperties=TOKEN:privato');
  assert(preview.includes('a:27017,b:27018/app') && preview.includes('authSource=admin') && preview.includes('tls=true'));
  assert(!preview.includes('segreto') && !preview.includes('privato'));
  assert(!riepilogoUri('formato sconosciuto con segreto').includes('con segreto'));
  console.log('OK Configurazioni: aggiornamenti parziali, segreti, cambi modalità, Testa/Connetti e URI mascherata');
})();

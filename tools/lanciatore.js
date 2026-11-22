'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: attendi } = require('node:timers/promises');
const { nuovoSegretoIstanza, probeServer } = require('../electron-server-auth');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 3030);
const dir = process.env.CODEDB_LAUNCHER_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), '.codedb', 'launcher');
const profilo = crypto.createHash('sha256').update(JSON.stringify([root,
  path.resolve(process.env.CODEDB_CONNECTIONS_FILE || path.join(root, 'connections.ini')), port])).digest('hex');
const registro = path.join(dir, profilo + '.json');
const richiestaStop = secret => path.join(dir, crypto.createHash('sha256').update(secret).digest('hex') + '.stop');

function portaOccupata() {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', err => err.code === 'ECONNREFUSED' ? resolve(false) : reject(err));
  });
}

async function stato() {
  let secret;
  try { secret = JSON.parse(fs.readFileSync(registro, 'utf8')).secret; }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (secret && await probeServer({ port, secret })) return secret;
  if (await portaOccupata()) throw new Error('La porta è occupata da un altro servizio o profilo.');
  return null;
}

async function servi() {
  const secret = nuovoSegretoIstanza();
  process.env.CODEDB_ELECTRON_INSTANCE_SECRET = secret;
  const srv = require('../server');
  srv.registerGlobalExceptionHandlers();
  await srv.startServer();
  try {
    const tmp = registro + '.' + crypto.randomUUID();
    fs.writeFileSync(tmp, JSON.stringify({ secret }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, registro);
    // La richiesta appartiene esclusivamente a questa generazione del server.
    const richiesta = richiestaStop(secret);
    fs.watchFile(richiesta, { interval: 250 }, async stat => {
      if (!stat.nlink) return;
      fs.unwatchFile(richiesta);
      try {
        await srv.stop();
        fs.unlinkSync(richiesta);
        process.exit(0);
      } catch (err) { console.error(err); process.exit(1); }
    });
    if (process.connected) process.send('pronto', () => process.disconnect());
  } catch (err) { await srv.stop(); throw err; }
}

async function avvia() {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(process.env.CODEDB_LAUNCHER_DIR || root, 'codedb.log'), 'a', 0o600);
  let figlio;
  try {
    figlio = spawn(process.execPath, [__filename, 'serve'], { cwd: root, detached: true, windowsHide: true,
      stdio: ['ignore', log, log, 'ipc'] });
  } finally { fs.closeSync(log); }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tempo di avvio scaduto. Consulta codedb.log.')), 60000);
      figlio.once('message', msg => { clearTimeout(timer); msg === 'pronto' ? resolve() : reject(new Error(String(msg))); });
      figlio.once('exit', code => { clearTimeout(timer); reject(new Error('Avvio interrotto (' + code + '). Consulta codedb.log.')); });
      figlio.once('error', err => { clearTimeout(timer); reject(err); });
    });
  } finally { if (figlio.connected) figlio.disconnect(); figlio.unref(); }
  if (!await stato()) throw new Error('Il server avviato non risponde.');
}

async function main(comando) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve essere una porta valida.');
  if (comando === 'serve') return servi();
  const secret = await stato();
  if (comando === 'status') { process.exitCode = secret ? 0 : 2; return; }
  if (comando === 'start') {
    if (secret) console.log('CodeDB è già in esecuzione.');
    else { await avvia(); console.log('CodeDB avviato.'); }
    return;
  }
  if (comando !== 'stop') throw new Error('Comando del launcher sconosciuto.');
  if (!secret) { console.log('Nessuna istanza in ascolto.'); return; }
  const richiesta = richiestaStop(secret);
  fs.closeSync(fs.openSync(richiesta, 'a', 0o600));
  const fine = Date.now() + 60000;
  while (fs.existsSync(richiesta)) {
    if (Date.now() >= fine) throw new Error('Arresto non confermato. Consulta codedb.log.');
    await attendi(150);
  }
  console.log('CodeDB fermato.');
}

main(process.argv[2]).catch(err => { console.error(err.message); process.exitCode = 1; });

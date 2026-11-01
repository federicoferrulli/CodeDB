'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MAX_SSH_KEY_BYTES = 64 * 1024;
const MAX_SSH_KEY_ENVELOPE = 7 + 4 * Math.ceil(MAX_SSH_KEY_BYTES / 3);
const errore = (message, code = 'SSH_KEY_INVALID') => Object.assign(new Error(message), { code });

function decodificaChiave(value) {
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) throw errore('Seleziona un file di chiave SSH.');
  let data;
  if (typeof value === 'string' && value.startsWith('base64:')) {
    const encoded = value.slice(7);
    if (value.length > MAX_SSH_KEY_ENVELOPE || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw errore('File SSH binario non valido o superiore a 64 KB.');
    data = Buffer.from(encoded, 'base64');
    if (data.toString('base64') !== encoded) throw errore('Codifica del file SSH non valida.');
  } else data = Buffer.from(value);
  if (data.length > MAX_SSH_KEY_BYTES) throw errore('La chiave SSH supera il limite di 64 KB.');
  if (!data.length || !data.toString('utf8').trim()) throw errore('Il file di chiave SSH è vuoto.');
  return data;
}

async function leggiChiave(cfg) {
  const mode = cfg.sshAuth || (cfg.sshPrivateKey ? 'upload' : 'path');
  if (mode !== 'path') return decodificaChiave(cfg.sshPrivateKey);
  let filename = String(cfg.sshKeyFile || '').trim().replace(/^(["'])(.*)\1$/, '$2');
  if (/^~(?:[/\\]|$)/.test(filename)) filename = path.join(os.homedir(), filename.slice(2));
  let handle;
  try {
    handle = await fs.open(filename, 'r');
    if (!(await handle.stat()).isFile()) throw new Error('Non è un file');
    const data = Buffer.alloc(MAX_SSH_KEY_BYTES + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    return decodificaChiave(data.subarray(0, bytesRead));
  } catch (err) {
    if (err.code?.startsWith('SSH_KEY_')) throw err;
    throw errore('Impossibile leggere la chiave dal percorso sul server CodeDB. Controlla percorso e permessi oppure scegli il file dal tuo dispositivo.');
  } finally { await handle?.close(); }
}

let attivi = 0;
const coda = [];
async function normalizzaInWorker(data, passphrase) {
  if (attivi >= 2) {
    if (coda.length >= 8) throw errore('Sono in corso troppe verifiche di chiavi SSH. Riprova tra qualche secondo.', 'SSH_KEY_BUSY');
    await new Promise(resolve => coda.push(resolve));
  } else attivi++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'SshKeyWorker.js'), { workerData: { data, passphrase }, resourceLimits: { maxOldGenerationSizeMb: 96 } });
      let done = false;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.terminate().finally(() => err ? reject(err) : resolve(value));
      };
      const timer = setTimeout(() => finish(errore('La chiave richiede troppi calcoli per essere aperta. Esportala con parametri di protezione standard.', 'SSH_KEY_RESOURCE_LIMIT')), 20000);
      worker.once('message', result => finish(result.error ? errore(result.error, result.code) : null, result.value));
      worker.once('error', () => finish(errore('Impossibile verificare la chiave SSH. Il file è danneggiato o richiede troppe risorse.')));
      worker.once('exit', code => { if (!done) finish(errore(`Verifica della chiave SSH interrotta (${code}).`)); });
    });
  } finally {
    const next = coda.shift();
    if (next) next(); else attivi--;
  }
}

async function preparaChiaveSsh(cfg, options = {}) {
  for (const field of ['sshPassphrase', 'sshSecurityKeyPin']) {
    if (cfg[field] != null && (typeof cfg[field] !== 'string' || Buffer.byteLength(cfg[field]) > 4096)) throw errore('La passphrase o il PIN SSH non sono validi o superano 4096 byte.');
  }
  const data = await leggiChiave(cfg);
  const { identificaChiaveAgente, preparaAgente } = require('./SshAgent');
  const identity = identificaChiaveAgente(data);
  const requireAgentAccess = () => {
    if (options.allowHostAgent === false) throw errore('L’agente SSH e i dispositivi della macchina CodeDB sono riservati all’amministratore dell’installazione. Carica una chiave privata del tuo account.', 'SSH_KEY_AGENT_FORBIDDEN');
  };
  if (identity) { requireAgentAccess(); return preparaAgente(data, { ...options, passphrase: cfg.sshPassphrase, securityKeyPin: cfg.sshSecurityKeyPin }); }
  const result = await normalizzaInWorker(data, cfg.sshPassphrase);
  if (result.publicKey) {
    requireAgentAccess();
    const pub = Buffer.from(result.publicKey, 'base64');
    return { ...await preparaAgente(pub, options), format: result.format };
  }
  return result;
}

function metadatiChiave(result) {
  const { format, algorithm, type, fingerprint, encrypted, message } = result;
  return { format: format || (result.certificate ? 'Certificato SSH' : result.securityKey ? 'Chiave FIDO SSH' : 'Chiave pubblica SSH'), algorithm: algorithm || type,
    fingerprint, encrypted: !!encrypted, requiresAgent: !!(result.agent || result.native), securityKey: !!result.securityKey, message };
}

module.exports = { preparaChiaveSsh, metadatiChiave, decodificaChiave, leggiChiave, MAX_SSH_KEY_BYTES, MAX_SSH_KEY_ENVELOPE };

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = Object.freeze({
  enabled: true, readOnly: false, allowDdl: true, allowBackup: true, allowImport: true,
  maxSessions: 32, idleTimeoutMinutes: 30, confirmTimeoutSeconds: 300,
  pendingPerPrincipal: 20, pendingGlobal: 500,
  pendingBytesPerPrincipalMiB: 64, pendingBytesGlobalMiB: 256,
  auditMaxMiB: 5, auditGenerations: 5,
});

const RANGES = Object.freeze({
  maxSessions: [1, 256], idleTimeoutMinutes: [1, 1440], confirmTimeoutSeconds: [30, 1800],
  pendingPerPrincipal: [1, 1000], pendingGlobal: [1, 10000],
  pendingBytesPerPrincipalMiB: [1, 1024], pendingBytesGlobalMiB: [1, 4096],
  auditMaxMiB: [1, 100], auditGenerations: [1, 20],
});

const ENV_KEYS = Object.freeze(Object.fromEntries(Object.keys(DEFAULTS).map(key => [key,
  'CODEDB_MCP_' + key.replace(/MiB$/, 'Mib').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase(),
])));

function validate(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Impostazioni MCP non valide: serve un oggetto.');
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`Impostazione MCP sconosciuta: ${key}.`);
    if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`Il valore di ${key} deve essere vero o falso.`);
    } else {
      const [min, max] = RANGES[key];
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Il valore di ${key} deve essere un intero tra ${min} e ${max}.`);
    }
  }
  if (values.pendingPerPrincipal > values.pendingGlobal) throw new Error('La quota di conferme per utente non può superare quella globale.');
  if (values.pendingBytesPerPrincipalMiB > values.pendingBytesGlobalMiB) throw new Error('La memoria per utente non può superare quella globale.');
  return values;
}

function environment(env) {
  const values = {}, overrides = {};
  for (const [key, name] of Object.entries(ENV_KEYS)) {
    if (env[name] == null || env[name] === '') continue;
    const raw = String(env[name]).trim().toLowerCase();
    if (typeof DEFAULTS[key] === 'boolean') {
      if (!['true', 'false', '1', '0', 'on', 'off'].includes(raw)) throw new Error(`${name}: usare true/false, on/off oppure 1/0.`);
      values[key] = ['true', '1', 'on'].includes(raw);
    } else values[key] = /^\d+$/.test(raw) ? Number(raw) : NaN;
    overrides[key] = name;
  }
  validate(values);
  return { values, overrides };
}

function createSettings({ filePath, env = {} }) {
  if (!filePath) throw new Error('Percorso delle impostazioni MCP mancante.');
  const fromEnv = environment(env);
  let saved = { ...DEFAULTS }, revision = 0;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('Versione o revisione non valida.');
    saved = validate({ ...DEFAULTS, ...validate(data.values) });
    revision = data.revision;
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Impossibile caricare le impostazioni MCP: ${err.message}`, { cause: err });
  }
  let effective = Object.freeze(validate({ ...saved, ...fromEnv.values }));
  let queue = Promise.resolve();
  let applyError = null;
  const listeners = new Set();
  const snapshot = () => ({ values: { ...effective }, saved: { ...saved }, overrides: { ...fromEnv.overrides }, revision, applied: applyError === null, applyError });

  function update(values, expectedRevision) {
    const patch = { ...validate(values) };
    const operation = queue.then(async () => {
      if (expectedRevision !== revision) throw new Error('Le impostazioni MCP sono state modificate da un’altra sessione. Ricaricale prima di salvare.');
      for (const key of Object.keys(patch)) {
        if (fromEnv.overrides[key] && patch[key] !== effective[key]) throw new Error(`${key} è imposto da ${fromEnv.overrides[key]}: modifica la configurazione del server e riavvialo.`);
      }
      // Un form invia anche i campi bloccati: non copiare gli override nei valori persistiti.
      const editable = Object.fromEntries(Object.entries(patch).filter(([key]) => !fromEnv.overrides[key]));
      const nextSaved = validate({ ...saved, ...editable });
      const nextEffective = Object.freeze(validate({ ...nextSaved, ...fromEnv.values }));
      const nextRevision = revision + 1;
      const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      try {
        const handle = await fs.promises.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ version: 1, revision: nextRevision, values: nextSaved }, null, 2) + '\n', 'utf8');
          await handle.sync();
        } finally { await handle.close(); }
        await fs.promises.rename(temporary, filePath);
      } finally {
        await fs.promises.unlink(temporary).catch(err => { if (err.code !== 'ENOENT') throw err; });
      }
      saved = nextSaved;
      effective = nextEffective;
      revision = nextRevision;
      const failures = [];
      for (const listener of listeners) {
        try { await listener(effective); } catch (err) { failures.push(err.message || String(err)); }
      }
      applyError = failures.length ? `Impostazioni salvate, applicazione incompleta: ${failures.join('; ')}. Riprova il salvataggio o riavvia CodeDB.` : null;
      return snapshot();
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return {
    get: () => effective, snapshot, update,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

module.exports = { createSettings, DEFAULTS, RANGES, ENV_KEYS, validate };

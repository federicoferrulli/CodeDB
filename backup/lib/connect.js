'use strict';

/* ---------------------------------------------------------------------------
 * Apertura/chiusura di una connessione DB per la CLI di backup: stessa logica
 * di establishConnection/teardownConnection in server.js (tunnel SSH compreso),
 * ma indipendente dal server, che non deve essere in esecuzione.
 * ------------------------------------------------------------------------- */

const DbFactory = require('../../db/DbFactory');
const { openSshTunnel } = require('../../db/SshTunnel');

function connDbType(cfg) {
  return String(cfg.dbType || 'mongodb').trim().toLowerCase();
}

function sshEnabled(cfg) {
  return String(cfg.ssh || '').trim().toLowerCase() === 'true';
}

// Apre tunnel SSH (se richiesto) e connette la strategia; in caso di errore
// chiude quanto già aperto e rilancia. La chiusura è a carico del chiamante.
async function establishConnection(cfg) {
  const dbType = connDbType(cfg);
  let tunnel = null;
  try {
    let connectCfg = cfg;
    if (sshEnabled(cfg)) {
      if (cfg.uri && cfg.uri.trim()) {
        throw new Error('Il tunnel SSH è disponibile solo in modalità "Parametri", non con URI completa.');
      }
      const target = {
        host: (cfg.host || 'localhost').trim(),
        port: parseInt(cfg.port, 10) || DbFactory.defaultPort(dbType),
      };
      // Una pianificazione per un tenant non deve usare implicitamente le chiavi dell'agente del servizio.
      tunnel = await openSshTunnel(cfg, target, { allowHostAgent: String(process.env.CODEDB_RBAC || 'off').toLowerCase() !== 'on'
        || process.env.CODEDB_SSH_ALLOW_HOST_AGENT === '1' });
      connectCfg = { ...cfg, host: tunnel.host, port: String(tunnel.port) };
      if (dbType === 'mongodb') connectCfg.directConnection = true;
    }
    const strategy = DbFactory.getStrategy(dbType);
    await strategy.connect(connectCfg);
    return { strategy, tunnel, dbType };
  } catch (err) {
    if (tunnel) try { await tunnel.close(); } catch { /* ignora */ }
    throw err;
  }
}

async function teardownConnection({ strategy, tunnel }) {
  await strategy.disconnect().catch(() => {});
  if (tunnel) {
    try { await tunnel.close(); } catch { /* ignora */ }
  }
}

module.exports = { establishConnection, teardownConnection, connDbType };

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
      const defaultPort = dbType === 'mysql' ? 3306 : 27017;
      const target = {
        host: (cfg.host || 'localhost').trim(),
        port: parseInt(cfg.port, 10) || defaultPort,
      };
      tunnel = await openSshTunnel(cfg, target);
      connectCfg = { ...cfg, host: tunnel.host, port: String(tunnel.port) };
      if (dbType === 'mongodb') connectCfg.directConnection = true;
    }
    const strategy = DbFactory.getStrategy(dbType);
    await strategy.connect(connectCfg);
    return { strategy, tunnel, dbType };
  } catch (err) {
    if (tunnel) try { tunnel.close(); } catch { /* ignora */ }
    throw err;
  }
}

async function teardownConnection({ strategy, tunnel }) {
  await strategy.disconnect().catch(() => {});
  if (tunnel) {
    try { tunnel.close(); } catch { /* ignora */ }
  }
}

module.exports = { establishConnection, teardownConnection, connDbType };

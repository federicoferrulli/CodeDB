'use strict';

/** Adapter esterni sostituibili nelle prove, senza modificare require.cache. */
function dipendenze(config, overrides = {}) {
  const positivo = (key, fallback) => Math.max(parseInt(config.env[key], 10) || fallback, 1);
  const base = {
    DbFactory: {
      ...require('../db/DbFactory'),
      getStrategy: type => require('../db/DbFactory').getStrategy(type, { env: config.env }),
    },
    // Caricamento pigro: ssh2, node-forge, AppStore (mongodb) ed export entrano
    // in memoria solo quando la relativa funzione viene davvero usata.
    openSshTunnel: (...args) => require('../db/SshTunnel').openSshTunnel(...args),
    createEntitlementProvider: (...args) => require('../auth/EntitlementProvider').createEntitlementProvider(...args),
    makeAuditor: (...args) => require('../db/AuditLog').makeAuditor(...args),
    eseguiExportMongo: (...args) => require('../db/eseguiExportMongo').eseguiExportMongo(...args),
    ScriptResults: {
      creaDeposito(code, options = {}) {
        return require('../db/ScriptResults').creaDeposito(code, {
          maxRisultati: positivo('CODEDB_SCRIPT_RESULTS_MAX', 50),
          maxBytes: positivo('CODEDB_SCRIPT_RESULTS_MAX_BYTES', 256 * 1024 * 1024),
          ...options, radice: config.env.CODEDB_SCRIPT_RESULTS_DIR,
        });
      },
      puliziaVecchi() {
        return require('../db/ScriptResults').puliziaVecchi({
          radice: config.env.CODEDB_SCRIPT_RESULTS_DIR,
          etaMassimaMs: positivo('CODEDB_SCRIPT_RESULTS_TTL_MS', 24 * 60 * 60 * 1000),
        });
      },
    },
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'AppStore')) {
    Object.defineProperty(base, 'AppStore', {
      enumerable: true,
      configurable: true,
      get() { return require('../auth/AppStore').AppStore; },
    });
  }
  return Object.assign(base, overrides);
}

module.exports = { dipendenze };

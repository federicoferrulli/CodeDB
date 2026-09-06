'use strict';

/** Adapter esterni sostituibili nelle prove, senza modificare require.cache. */
function dipendenze(config, overrides = {}) {
  const deposits = require('../db/ScriptResults');
  const positivo = (key, fallback) => Math.max(parseInt(config.env[key], 10) || fallback, 1);
  return {
    DbFactory: {
      ...require('../db/DbFactory'),
      getStrategy: type => require('../db/DbFactory').getStrategy(type, { env: config.env }),
    },
    openSshTunnel: require('../db/SshTunnel').openSshTunnel,
    AppStore: require('../auth/AppStore').AppStore,
    createEntitlementProvider: require('../auth/EntitlementProvider').createEntitlementProvider,
    makeAuditor: require('../db/AuditLog').makeAuditor,
    ScriptResults: {
      creaDeposito(code, options = {}) {
        return deposits.creaDeposito(code, {
          maxRisultati: positivo('CODEDB_SCRIPT_RESULTS_MAX', 50),
          maxBytes: positivo('CODEDB_SCRIPT_RESULTS_MAX_BYTES', 256 * 1024 * 1024),
          ...options, radice: config.env.CODEDB_SCRIPT_RESULTS_DIR,
        });
      },
      puliziaVecchi() {
        return deposits.puliziaVecchi({
          radice: config.env.CODEDB_SCRIPT_RESULTS_DIR,
          etaMassimaMs: positivo('CODEDB_SCRIPT_RESULTS_TTL_MS', 24 * 60 * 60 * 1000),
        });
      },
    },
    ...overrides,
  };
}

module.exports = { dipendenze };

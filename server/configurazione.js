'use strict';

const path = require('path');
const os = require('os');

/** Fotografia dell'ambiente: nessuna istanza scrive nella configurazione del processo. */
function configurazione(options = {}) {
  const env = { ...process.env, ...options.env };
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
  const defaults = {
    CODEDB_CONNECTIONS_FILE: path.join(rootDir, 'connections.ini'),
    CODEDB_BACKUPS_DIR: path.join(rootDir, 'backups'),
    CODEDB_UI_AUDIT_FILE: path.join(rootDir, 'ui-audit.log'),
    CODEDB_MCP_AUDIT_FILE: path.join(rootDir, 'mcp-audit.log'),
    CODEDB_SCRIPT_RESULTS_DIR: path.join(os.tmpdir(), 'codedb-risultati-script'),
  };
  for (const [key, fallback] of Object.entries(defaults)) env[key] = path.resolve(env[key] || fallback);
  env.CODEDB_CONNECTIONS_DIR = path.resolve(env.CODEDB_CONNECTIONS_DIR || path.join(path.dirname(env.CODEDB_CONNECTIONS_FILE), 'conns'));
  const port = Number(env.PORT ?? 3030);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT deve essere un intero tra 0 e 65535.');
  env.PORT = port;
  Object.freeze(env);
  return Object.freeze({
    env, rootDir,
    desktop: options.desktop === undefined ? globalThis.__codedbDesktop : options.desktop,
    rbacOn: () => String(env.CODEDB_RBAC || 'off').trim().toLowerCase() === 'on',
  });
}

module.exports = { configurazione };

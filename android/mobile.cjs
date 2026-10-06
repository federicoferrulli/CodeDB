'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Il loopback è condiviso con le altre app: ogni richiesta richiede il cookie privato. */
function proteggi(server, secret) {
  const expected = Buffer.from(secret);
  for (const event of ['request', 'upgrade']) {
    const handlers = server.listeners(event);
    server.removeAllListeners(event);
    server.on(event, (req, response, ...rest) => {
      const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim())
        .find(s => s.startsWith('codedb_mobile='));
      const actual = Buffer.from(cookie ? cookie.slice('codedb_mobile='.length) : '');
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        if (event === 'upgrade') response.destroy();
        else { response.writeHead(403); response.end('Accesso riservato alla app CodeDB.'); }
        return;
      }
      for (const handler of handlers) handler.call(server, req, response, ...rest);
    });
  }
}

async function avvia({ data, ready, secret, dns = [] }) {
  if (!path.isAbsolute(data) || !path.isAbsolute(ready) || !/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error('Configurazione Android non valida.');
  }
  fs.mkdirSync(data, { recursive: true });
  process.chdir(data);
  const portFile = path.join(data, 'porta-http.json');
  let port = 0;
  try {
    port = JSON.parse(fs.readFileSync(portFile, 'utf8'));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Porta Android salvata non valida.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  Object.assign(process.env, {
    HOST: '127.0.0.1', PORT: String(port), CODEDB_RBAC: 'off',
    CODEDB_CONNECTIONS_FILE: path.join(data, 'connections.ini'),
    CODEDB_CONNECTIONS_DIR: path.join(data, 'conns'),
    CODEDB_VAULT_FILE: path.join(data, 'vault.json'),
    CODEDB_BACKUPS_DIR: path.join(data, 'backups'),
    CODEDB_UI_AUDIT_FILE: path.join(data, 'ui-audit.log'),
    CODEDB_MCP_AUDIT_FILE: path.join(data, 'mcp-audit.log'),
    CODEDB_SCRIPT_RESULTS_DIR: path.join(data, 'risultati-script'),
  });
  if (dns.length) require('node:dns').setServers(dns);
  // Node Mobile 18 supporta import(), ma non require(ESM). Il modulo condiviso
  // resta unico: si carica prima del backend e si rende disponibile al suo ponte CJS.
  const identifierFile = path.join(__dirname, 'public/js/identificatori.mjs');
  const identifierModule = new (require('node:module'))(identifierFile);
  identifierModule.exports = await import(require('node:url').pathToFileURL(identifierFile).href);
  identifierModule.loaded = true;
  require.cache[identifierFile] = identifierModule;
  const { createServer } = require('./server/createServer');
  const app = createServer();
  proteggi(app.server, secret);
  try {
    await app.start();
    // L'origine della WebView identifica localStorage e IndexedDB: si sceglie
    // una porta libera solo al primo avvio e la si conserva fra i processi.
    fs.writeFileSync(portFile + '.tmp', JSON.stringify(app.server.address().port));
    fs.renameSync(portFile + '.tmp', portFile);
  } catch (error) {
    await app.stop();
    if (error.code === 'EADDRINUSE') throw new Error(`La porta privata ${port} è occupata. Chiudi l'app che la usa e riapri CodeDB; la porta resta invariata per conservare cronologia e diagrammi.`);
    throw error;
  }
  fs.writeFileSync(ready + '.tmp', JSON.stringify({ url: `http://127.0.0.1:${app.server.address().port}` }));
  fs.renameSync(ready + '.tmp', ready);
  return app;
}

if (require.main === module) {
  const [data, ready, secret, dns] = process.argv.slice(2);
  avvia({ data, ready, secret, dns: JSON.parse(dns || '[]') }).catch(error => {
    fs.writeFileSync(ready + '.tmp', JSON.stringify({ error: error.message }));
    fs.renameSync(ready + '.tmp', ready);
    console.error(error);
  });
}
module.exports = { avvia, proteggi };

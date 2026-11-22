'use strict';

/* ---------------------------------------------------------------------------
 * Verifiche di hardening pre-produzione:
 *  1. POST /mcp rifiuta Host vietato (403) e API key assente/errata (401)
 *     PRIMA di leggere o parsare il body JSON da 50 MB.
 *  2. Parametri scrypt limitati in db/vault.js (deriveKek e unwrapDataKey):
 *     un file vault.json o un export .ini con p/N/r ostili fallisce subito
 *     senza bloccare l'event loop.
 *  3. Intestazioni HTTP di sicurezza in server/trasporto.js (niente
 *     X-Powered-By, nosniff, SAMEORIGIN, frame-ancestors 'self', no-referrer)
 *     e gate Origin/Host su /auth/login e /auth/logout.
 * ------------------------------------------------------------------------- */

const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const Vault = require('../db/vault');
const { makePrincipal } = require('../auth/principal');
const { allowedConnections } = require('../auth/permissions');
const { attachMcp, MCP_PATH } = require('../mcp/McpGateway');
const { createServer } = require('../server/createServer');

function httpRequest({ port, method, path, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'Content-Length': buf.length, ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(buf);
  });
}

module.exports = (async () => {
  console.log('--- Test Hardening Pre-Produzione ---');

  // 1. Limiti scrypt (classe intera: deriveKek + unwrapDataKey)
  {
    const salt = Buffer.alloc(16, 7);
    const validi = Vault.validaParametriScrypt(Vault.SCRYPT);
    assert.equal(validi.N, Vault.SCRYPT.N);
    assert.equal(validi.r, Vault.SCRYPT.r);
    assert.equal(validi.p, Vault.SCRYPT.p);

    const ostili = [
      { N: 16384, r: 8, p: 100000, keylen: 32 },
      { N: 16384, r: 8, p: 0, keylen: 32 },
      { N: 12345, r: 8, p: 1, keylen: 32 },       // non potenza di 2
      { N: 131072, r: 8, p: 1, keylen: 32 },      // N oltre tetto
      { N: 65536, r: 16, p: 1, keylen: 32 },      // 128 * N * r = 128 MiB > 64 MiB
      { N: 16384, r: 0, p: 1, keylen: 32 },
      { N: 16384, r: 8, p: 1, keylen: 8 },
    ];
    const t0 = Date.now();
    for (const p of ostili) {
      assert.throws(() => Vault.deriveKek('pw', salt, p), /scrypt|memoria/i,
        `parametri scrypt ostili devono essere rifiutati: ${JSON.stringify(p)}`);
    }
    const { meta } = Vault.createMeta('segreta');
    assert.equal(Vault.unwrapDataKey({ ...meta, p: 100000 }, 'segreta'), null,
      'unwrapDataKey con p ostile deve fallire subito senza bloccare il processo');
    assert.ok(Date.now() - t0 < 500, 'il rifiuto dei parametri scrypt ostili deve essere immediato');
    console.log('  OK   Limiti scrypt (deriveKek e unwrapDataKey) rifiutano parametri DoS');
  }

  // 2. POST /mcp: Host e autenticazione PRIMA del body parser JSON da 50 MB
  {
    const owner = makePrincipal({ _id: 'o1', type: 'owner', ownerId: 'o1', email: 'o@x.it' }, []);
    const app = express();
    const control = attachMcp(app, {
      env: { HOST: '127.0.0.1', CODEDB_PUBLIC_BIND: '127.0.0.1' },
      audit: () => {},
      loadConnections: () => ({}),
      connLabel: () => '',
      connDbType: () => 'mongodb',
      setConnectionReadOnly: () => {},
      establishConnection: async () => { throw new Error('non usato'); },
      teardownConnection: async () => {},
      tryAcquireGlobalSession: () => true,
      releaseGlobalSession: () => {},
      allowedConnections,
      rbacOn: () => true,
      resolveApiKey: async (key) => (key === 'cdb_valida' ? owner : null),
    });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const badJson = '{json-tronco-non-valido';
      const unauth = await httpRequest({
        port, method: 'POST', path: MCP_PATH,
        headers: { 'Content-Type': 'application/json' },
        body: badJson,
      });
      assert.equal(unauth.status, 401, 'senza API key deve rispondere 401 prima di parsare JSON (non 400)');

      const badHost = await httpRequest({
        port, method: 'POST', path: MCP_PATH,
        headers: { Host: 'attaccante.test', 'Content-Type': 'application/json', Authorization: 'Bearer cdb_valida' },
        body: badJson,
      });
      assert.equal(badHost.status, 403, 'Host vietato deve rispondere 403 prima di parsare JSON');

      const authBadJson = await httpRequest({
        port, method: 'POST', path: MCP_PATH,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer cdb_valida' },
        body: badJson,
      });
      assert.equal(authBadJson.status, 400, 'con API key valida il JSON malformato risponde 400 JSON-RPC');
      assert.match(authBadJson.body, /jsonrpc/);
    } finally {
      await control.shutdownMcp();
      await new Promise((r) => server.close(r));
    }
    console.log('  OK   POST /mcp esegue Host e autenticazione prima del parsing JSON');
  }

  // 3. HTTP Security Headers + gate Origin/Host su /auth/login e /auth/logout
  {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-hardening-'));
    const srv = createServer({
      config: {
        env: {
          PORT: '0',
          HOST: '127.0.0.1',
          CODEDB_RBAC: 'off',
          CODEDB_CONNECTIONS_FILE: path.join(dir, 'connections.ini'),
          CODEDB_BACKUPS_DIR: path.join(dir, 'backups'),
          CODEDB_UI_AUDIT_FILE: path.join(dir, 'ui-audit.log'),
          CODEDB_MCP_AUDIT_FILE: path.join(dir, 'mcp-audit.log'),
          CODEDB_MCP_SETTINGS_FILE: path.join(dir, 'mcp-settings.json'),
        },
      },
    });
    await srv.start();
    const { port } = srv.server.address();
    try {
      const probe = await httpRequest({ port, method: 'GET', path: '/handshake-check' });
      assert.equal(probe.status, 200);
      assert.equal(probe.headers['x-powered-by'], undefined, 'X-Powered-By deve essere disabilitato');
      assert.equal(probe.headers['x-content-type-options'], 'nosniff');
      assert.equal(probe.headers['x-frame-options'], 'SAMEORIGIN');
      assert.equal(probe.headers['content-security-policy'], "frame-ancestors 'self'");
      assert.equal(probe.headers['referrer-policy'], 'no-referrer');

      const loginCross = await httpRequest({
        port, method: 'POST', path: '/auth/login',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: '{}',
      });
      assert.equal(loginCross.status, 403, 'POST /auth/login da Origin estranea deve essere rifiutato');

      const logoutCross = await httpRequest({
        port, method: 'POST', path: '/auth/logout',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: '{}',
      });
      assert.equal(logoutCross.status, 403, 'POST /auth/logout da Origin estranea deve essere rifiutato');

      const loginOk = await httpRequest({
        port, method: 'POST', path: '/auth/login',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(loginOk.status, 200, 'POST /auth/login locale continua a funzionare');
    } finally {
      await srv.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('  OK   Header HTTP di sicurezza e gate Origin su /auth/login e /auth/logout');
  }

  console.log('  OK   Hardening pre-produzione passed');
})().catch((err) => {
  console.error('  FAIL Hardening pre-produzione:', err.stack || err);
  process.exitCode = 1;
});

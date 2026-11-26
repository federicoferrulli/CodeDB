'use strict';

const crypto = require('crypto');
const http = require('http');

function nuovoSegretoIstanza() { return crypto.randomBytes(32).toString('base64url'); }
function nuovaSfida() { return crypto.randomBytes(24).toString('hex'); }

function provaIstanza(secret, challenge, ruolo = 'server', contesto = '') {
  if (!secret || !/^[a-f0-9]{48}$/i.test(String(challenge || ''))) return null;
  return crypto.createHmac('sha256', secret)
    .update(`${ruolo}:${String(contesto)}:${String(challenge)}`).digest('base64url');
}

function provaClient(secret, challenge, contesto) { return provaIstanza(secret, challenge, 'client', contesto); }
function provaServer(secret, challenge, contesto) { return provaIstanza(secret, challenge, 'server', contesto); }

function stessaProva(expected, actual) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(actual || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function probeServer({ host = '127.0.0.1', port, secret, timeout = 500, httpModule = http }) {
  return new Promise((resolve) => {
    const challenge = nuovaSfida();
    const contesto = `porta:${Number(port)}`;
    const req = httpModule.get({
      host, port, path: '/handshake-check', timeout,
      headers: {
        'x-codedb-instance-challenge': challenge,
        'x-codedb-instance-client-proof': provaClient(secret, challenge, contesto) || '',
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 4096) body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed.app === 'codedb'
            && stessaProva(provaServer(secret, challenge, contesto), parsed.instanceProof));
        } catch { resolve(false); }
      });
    });
    // Una risposta che invia byte a intervalli non deve prolungare la verifica.
    const deadline = setTimeout(() => { req.destroy(); resolve(false); }, timeout);
    req.once('close', () => clearTimeout(deadline));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Protegge il server HTTP/WebSocket incorporato in Electron contro altri
 * processi locali su 127.0.0.1: richiede il cookie HttpOnly `codedb_desktop`.
 * Lascia passare `/handshake-check` (già autenticato via HMAC) e `/mcp`
 * (protetto da impostazioni MCP, flag readOnly e confirm_token per i client AI).
 */
function proteggiDesktop(server, secret) {
  const expected = Buffer.from(String(secret || ''));
  if (!expected.length) throw new Error('Segreto desktop mancante.');
  for (const event of ['request', 'upgrade']) {
    const handlers = server.listeners(event);
    server.removeAllListeners(event);
    server.on(event, (req, response, ...rest) => {
      const pathname = String(req.url || '/').split('?')[0];
      if (event === 'request' && (pathname === '/handshake-check' || pathname === '/mcp')) {
        for (const handler of handlers) handler.call(server, req, response, ...rest);
        return;
      }
      const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim())
        .find(s => s.startsWith('codedb_desktop='));
      const actual = Buffer.from(cookie ? cookie.slice('codedb_desktop='.length) : '');
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        if (event === 'upgrade') response.destroy();
        else { response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Accesso riservato alla finestra desktop CodeDB.'); }
        return;
      }
      for (const handler of handlers) handler.call(server, req, response, ...rest);
    });
  }
}

module.exports = {
  nuovoSegretoIstanza, nuovaSfida, provaIstanza, provaClient, provaServer, stessaProva, probeServer, proteggiDesktop,
};

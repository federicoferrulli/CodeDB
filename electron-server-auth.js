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
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

module.exports = {
  nuovoSegretoIstanza, nuovaSfida, provaIstanza, provaClient, provaServer, stessaProva, probeServer,
};

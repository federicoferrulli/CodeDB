'use strict';

function bindEsposto(env) {
  return String(env.CODEDB_PUBLIC_BIND || '').trim() || env.HOST || '127.0.0.1';
}

function fuoriDalLoopback(host) {
  return !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).trim().toLowerCase());
}

function hostConsentito(env, host) {
  if (fuoriDalLoopback(bindEsposto(env))) return true;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return true;
  const pubblici = [env.CODEDB_PUBLIC_URL, ...String(env.CODEDB_ALLOWED_ORIGINS || '').split(',')];
  return pubblici.some(value => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && url.host.toLowerCase() === host.toLowerCase();
    } catch { return false; }
  });
}

module.exports = { bindEsposto, fuoriDalLoopback, hostConsentito };

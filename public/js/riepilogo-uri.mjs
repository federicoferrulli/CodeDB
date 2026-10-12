/** Mostra destinazione e opzioni note senza esporre password o token della URI. */
export function riepilogoUri(uri) {
  const parts = uri.trim().match(/^(mongodb(?:\+srv)?:\/\/)([^/?#]+)([^?#]*)(?:\?([^#]*))?$/i);
  if (!parts) return 'URI inserita (contenuto nascosto: formato non riconosciuto)';
  const [, protocol, authority, path, query] = parts;
  const at = authority.lastIndexOf('@');
  const user = at < 0 ? '' : authority.slice(0, at).split(':')[0];
  const visible = /^(authSource|authMechanism|replicaSet|tls|ssl|retryWrites|retryReads|readPreference|directConnection|loadBalanced|appName|connectTimeoutMS|serverSelectionTimeoutMS|socketTimeoutMS|maxPoolSize|minPoolSize|w|wtimeoutMS|compressors)$/i;
  const options = [...new URLSearchParams(query)].map(([key, value]) =>
    `${key}=${visible.test(key) ? value : '••••••'}`).join('&');
  return `${protocol}${at < 0 ? authority : `${user}:••••••@${authority.slice(at + 1)}`}${path}${query === undefined ? '' : `?${options}`}`;
}

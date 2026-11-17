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

const PORTE_PREDEFINITE = {
  mongodb: '27017',
  mysql: '3306',
  postgresql: '5432',
  postgres: '5432',
};

function pulisciParte(valore, fallback) {
  const pulito = String(valore ?? '').trim().replace(/^\[|\]$/g, '').replace(/[\[\]\r\n]/g, '').trim();
  return pulito || fallback;
}

/** Nome predefinito `{host}:{port}` quando il campo "Salva come" resta vuoto. */
export function nomePredefinitoConnessione(cfg = {}, uriSalvata = '') {
  const tipo = String(cfg.dbType || 'mongodb').trim().toLowerCase();
  const portaDefault = PORTE_PREDEFINITE[tipo] || '27017';
  if (cfg.connectionMode === 'uri') {
    const sorgente = String(cfg.uri || '').trim() || String(uriSalvata || '').trim();
    const parts = sorgente.match(/^mongodb(?:\+srv)?:\/\/([^/?#]+)/i);
    if (parts) {
      const authority = parts[1];
      const at = authority.lastIndexOf('@');
      const primoNodo = (at < 0 ? authority : authority.slice(at + 1)).split(',')[0].trim();
      const ipv6 = primoNodo.match(/^\[([^\]]+)\](?::([^:\]]+))?$/);
      if (ipv6) {
        return `${pulisciParte(ipv6[1], 'localhost')}:${pulisciParte(ipv6[2], portaDefault)}`;
      }
      const duePunti = primoNodo.indexOf(':');
      if (duePunti >= 0 && primoNodo.indexOf(':', duePunti + 1) < 0) {
        return `${pulisciParte(primoNodo.slice(0, duePunti), 'localhost')}:${pulisciParte(primoNodo.slice(duePunti + 1), portaDefault)}`;
      }
      return `${pulisciParte(primoNodo, 'localhost')}:${portaDefault}`;
    }
    return `localhost:${portaDefault}`;
  }
  return `${pulisciParte(cfg.host, 'localhost')}:${pulisciParte(cfg.port, portaDefault)}`;
}

/** Nome effettivo di salvataggio: quello indicato dall'utente oppure `{host}:{port}`. */
export function nomeSalvataggioConnessione(cfg = {}, uriSalvata = '') {
  const scelto = String(cfg.saveAs || '').trim();
  return scelto || nomePredefinitoConnessione(cfg, uriSalvata);
}


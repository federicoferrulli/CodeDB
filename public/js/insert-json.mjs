// Legge i valori dalla sorgente: JSON.parse da solo arrotonda i numeri prima del driver.
export function dataIsoBson(text) {
  const match = /^(\d{4}|[+-]\d{6})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.(\d+))?)?(?:[zZ]|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (!match) throw new Error('Data non valida: usa ISO 8601 oppure millisecondi a 64 bit.');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!days[month - 1] || day < 1 || day > days[month - 1]) throw new Error('Giorno o mese non valido.');
  if (match[4]?.slice(3).match(/[1-9]/)) throw new Error('BSON Date conserva millisecondi: rimuovi le frazioni più piccole.');
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(text) ? text : text.includes('T') ? text + 'Z' : text + 'T00:00:00Z');
  if (!Number.isFinite(d.getTime())) throw new Error('Data fuori intervallo ISO: usa millisecondi a 64 bit.');
  return d.toISOString();
}

export function campiJson(testo) {
  const source = String(testo);
  const obj = JSON.parse(source);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Serve un oggetto JSON con i nomi dei campi.');
  const tokens = [...source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)];
  const fields = new Map();
  for (let i = 1; i < tokens.length - 1;) {
    const name = JSON.parse(tokens[i++][0]);
    i++; // due punti, già validati da JSON.parse
    const start = tokens[i].index;
    let depth = 0;
    do {
      const token = tokens[i++][0];
      if (token === '{' || token === '[') depth++;
      if (token === '}' || token === ']') depth--;
    } while (depth > 0);
    const end = tokens[i - 1].index + tokens[i - 1][0].length;
    if (fields.has(name)) throw new Error(`Campo duplicato: "${name}".`);
    fields.set(name, source.slice(start, end));
    if (tokens[i]?.[0] === ',') i++;
  }
  return fields;
}

// Un numero senza involucro è double; un intero non rappresentabile richiede Long/Decimal.
export function leggiJsonEsatto(testo) {
  JSON.parse(testo);
  const levels = [];
  for (const [token] of String(testo).matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)) {
    if (token === '{') { levels.push({ names: new Set(), key: true }); continue; }
    if (token === '[') { levels.push(null); continue; }
    if (token === '}' || token === ']') { levels.pop(); continue; }
    const level = levels.at(-1);
    if (!level) continue;
    if (token === ',') { level.key = true; continue; }
    if (level.key && token[0] === '"') {
      const name = JSON.parse(token);
      if (level.names.has(name)) throw new Error(`Campo duplicato: "${name}".`);
      level.names.add(name); level.key = false;
    }
  }
  return JSON.parse(String(testo).replace(/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token[0] === '"') return token;
    if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) {
      const n = BigInt(token);
      return JSON.stringify({ [n >= -9223372036854775808n && n <= 9223372036854775807n ? '$numberLong' : '$numberDecimal']: token });
    }
    if (!Number.isFinite(Number(token))) throw new Error('Numero fuori intervallo: usa $numberDecimal o $numberDouble.');
    return token;
  }));
}

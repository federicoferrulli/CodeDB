/** Codec condiviso per numeri che non possono attraversare Number. */

const MIN_I64 = -9223372036854775808n;
const MAX_I64 = 9223372036854775807n;
const MAX_U64 = 18446744073709551615n;
const RE_DECIMALE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function tipoDaMetadato(metadato = {}) {
  if (typeof metadato === 'string') return metadato.toLowerCase();
  const tipi = Array.isArray(metadato.types) ? metadato.types.join(' ') : '';
  return String(metadato.type || metadato.dataType || metadato.kind || tipi).toLowerCase();
}

export function metadatoNumerico(valore, metadato = {}) {
  if (valore && typeof valore === 'object') {
    for (const wrapper of ['$numberLong', '$numberDecimal', '$numberInt', '$numberDouble']) {
      if (Object.prototype.hasOwnProperty.call(valore, wrapper)) return { wrapper };
    }
  }
  return metadato;
}

export function testoNumeroEsatto(valore) {
  if (valore && typeof valore === 'object') {
    for (const wrapper of ['$numberLong', '$numberDecimal', '$numberInt', '$numberDouble']) {
      if (Object.prototype.hasOwnProperty.call(valore, wrapper)) return String(valore[wrapper]);
    }
  }
  return String(valore ?? '');
}

export function richiedePrecisioneEsatta(metadato = {}) {
  if (metadato.wrapper === '$numberLong' || metadato.wrapper === '$numberDecimal') return true;
  const tipo = tipoDaMetadato(metadato);
  return /(^|\W)(bigint|int8|bigserial|decimal|numeric|dec|fixed)(\W|$)/.test(tipo);
}

function intero(testo, minimo, massimo, etichetta) {
  if (!/^[+-]?\d+$/.test(testo)) throw new Error(`${etichetta} non valido: è richiesto un intero.`);
  let valore;
  try { valore = BigInt(testo); } catch { throw new Error(`${etichetta} non valido.`); }
  if (valore < minimo || valore > massimo) {
    throw new Error(`${etichetta} fuori intervallo (${minimo}…${massimo}).`);
  }
  return valore.toString();
}

export function decodificaNumeroEsatto(testo, metadato = {}) {
  const t = String(testo ?? '').trim();
  if (!t) throw new Error('Numero non valido: il valore è vuoto.');
  const tipo = tipoDaMetadato(metadato);
  const wrapper = metadato && metadato.wrapper;

  if (wrapper === '$numberLong' || /(^|\W)(bigint|int8|bigserial)(\W|$)/.test(tipo)) {
    const senzaSegno = /unsigned/.test(tipo);
    const canonico = intero(t, senzaSegno ? 0n : MIN_I64, senzaSegno ? MAX_U64 : MAX_I64, 'BIGINT');
    // BSON Long è signed: il tratto unsigned superiore usa Decimal128 come
    // involucro di trasporto e arriva comunque al driver SQL come stringa.
    return senzaSegno && BigInt(canonico) > MAX_I64
      ? { $numberDecimal: canonico }
      : { $numberLong: canonico };
  }

  if (wrapper === '$numberDecimal' || /(^|\W)(decimal|numeric|dec|fixed)(\W|$)/.test(tipo)) {
    if (!RE_DECIMALE.test(t)) throw new Error('Numero decimale non valido.');
    return { $numberDecimal: t };
  }

  if (wrapper === '$numberInt') {
    return { $numberInt: intero(t, -2147483648n, 2147483647n, 'Intero a 32 bit') };
  }

  if (wrapper === '$numberDouble') {
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error('Numero double non valido.');
    return { $numberDouble: t };
  }

  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error('Numero non valido.');
  return n;
}

export function decodificaTemporale(testo, tipo = 'istante') {
  const t = String(testo ?? '').trim();
  if (tipo === 'data') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error('Data non valida: usa AAAA-MM-GG.');
    return t;
  }
  if (tipo === 'locale') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(t)) {
      throw new Error('Timestamp locale non valido: non aggiungere un fuso.');
    }
    return t;
  }
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) {
    throw new Error('Istante ambiguo: indica il fuso con Z oppure con un offset, per esempio +02:00.');
  }
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new Error('Istante non valido.');
  return { $date: d.toISOString() };
}

function decimaleDaValore(valore) {
  let testo = testoNumeroEsatto(valore).trim();
  if (!RE_DECIMALE.test(testo)) return null;
  let segno = 1n;
  if (testo[0] === '-') { segno = -1n; testo = testo.slice(1); }
  else if (testo[0] === '+') testo = testo.slice(1);
  const [mantissa, expTesto = '0'] = testo.toLowerCase().split('e');
  const [intera, frazione = ''] = mantissa.split('.');
  let scala = frazione.length - Number(expTesto);
  let cifre = (intera || '0') + frazione;
  if (scala < 0) { cifre += '0'.repeat(-scala); scala = 0; }
  let coeff = segno * BigInt(cifre || '0');
  while (scala > 0 && coeff % 10n === 0n) { coeff /= 10n; scala--; }
  return { coeff, scala };
}

function potenza10(n) { return 10n ** BigInt(n); }

function allinea(v, scala) {
  return v.coeff * potenza10(scala - v.scala);
}

function testoDecimale(coeff, scala) {
  const negativo = coeff < 0n;
  let cifre = (negativo ? -coeff : coeff).toString();
  if (scala > 0) {
    cifre = cifre.padStart(scala + 1, '0');
    cifre = `${cifre.slice(0, -scala)}.${cifre.slice(-scala)}`.replace(/0+$/, '').replace(/\.$/, '');
  }
  return (negativo && cifre !== '0' ? '-' : '') + cifre;
}

function stessoDecimale(a, b) {
  if (!a || !b) return false;
  const scala = Math.max(a.scala, b.scala);
  return allinea(a, scala) === allinea(b, scala);
}

function risultatoEsatto(testo, esatto = true) {
  const numero = Number(testo);
  const rappresentabile = Number.isFinite(numero)
    && stessoDecimale(decimaleDaValore(testo), decimaleDaValore(String(numero)));
  return { testo, numero: Number.isFinite(numero) ? numero : null, approssimato: !esatto || !rappresentabile };
}

export function aggregaNumeriEsatti(valori, operazione) {
  const parsed = valori.map(decimaleDaValore).filter(Boolean);
  if (!parsed.length) return { testo: null, numero: null, approssimato: false };
  const scala = Math.max(...parsed.map((v) => v.scala));
  const coefficienti = parsed.map((v) => allinea(v, scala));

  if (operazione === 'min' || operazione === 'max') {
    const coeff = operazione === 'min'
      ? coefficienti.reduce((a, b) => (a < b ? a : b))
      : coefficienti.reduce((a, b) => (a > b ? a : b));
    return risultatoEsatto(testoDecimale(coeff, scala));
  }

  const somma = coefficienti.reduce((a, b) => a + b, 0n);
  if (operazione !== 'media') return risultatoEsatto(testoDecimale(somma, scala));

  const divisore = BigInt(parsed.length);
  let coeff = somma;
  let scalaMedia = scala;
  let resto = coeff % divisore;
  let cifre = 0;
  while (resto !== 0n && cifre < 40) {
    coeff *= 10n;
    scalaMedia++;
    resto = coeff % divisore;
    cifre++;
  }
  return risultatoEsatto(testoDecimale(coeff / divisore, scalaMedia), resto === 0n);
}

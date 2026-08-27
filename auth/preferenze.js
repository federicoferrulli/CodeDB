'use strict';

const AMBITI = new Set(['personale', 'condiviso']);
const SCHEMI = Object.freeze({
  scorciatoie: { maxBytes: 16 * 1024, maxEntries: 100, maxString: 80 },
});

function oggettoSemplice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validaPreferenza({ ambito, chiave, valore, solaLettura = false }) {
  const scope = String(ambito || '').trim();
  const key = String(chiave || '').trim();
  if (!AMBITI.has(scope)) throw new Error('Ambito preferenza non valido.');
  const schema = Object.prototype.hasOwnProperty.call(SCHEMI, key) ? SCHEMI[key] : null;
  if (!schema) throw new Error(`Chiave preferenza non supportata: "${key || '?'}".`);
  if (solaLettura) return { ambito: scope, chiave: key };
  if (!oggettoSemplice(valore)) throw new Error(`La preferenza "${key}" deve essere un oggetto JSON.`);
  const entries = Object.entries(valore);
  if (entries.length > schema.maxEntries) throw new Error(`La preferenza "${key}" contiene troppe voci.`);
  for (const [name, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9:_-]{0,63}$/.test(name)) throw new Error(`Campo preferenza non valido: "${name}".`);
    if (typeof item !== 'string' || item.length > schema.maxString) {
      throw new Error(`Valore non valido per la preferenza "${key}.${name}".`);
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(valore), 'utf8');
  if (bytes > schema.maxBytes) throw new Error(`La preferenza "${key}" supera ${schema.maxBytes} byte.`);
  return { ambito: scope, chiave: key, valore, bytes };
}

module.exports = { validaPreferenza, SCHEMI };

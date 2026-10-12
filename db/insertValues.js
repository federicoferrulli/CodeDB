'use strict';

const { parseClientValue } = require('./sqlValori');

async function parseSqlInsert(text, columns) {
  const { campiJson } = await import('../public/js/insert-json.mjs');
  const fields = campiJson(text);
  const doc = Object.create(null);
  for (const [name, raw] of fields) {
    const col = columns.find(c => c.name === name);
    if (!col) throw new Error(`Colonna "${name}" inesistente: aggiorna lo schema.`);
    if (col.generated) throw new Error(`La colonna "${name}" è calcolata dal database: omettila dall'inserimento.`);
    const type = String(col.baseType || col.type || col.types?.[0] || '').toLowerCase();
    if (raw === 'null') doc[name] = null;
    else if (/^jsonb?$/.test(type) && raw[0] !== '"') doc[name] = raw;
    else if (/^-?\d/.test(raw)) doc[name] = raw;
    else doc[name] = parseClientValue(raw);
  }
  return doc;
}

module.exports = { parseSqlInsert };

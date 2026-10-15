'use strict';
// Le letture dei documenti usano la transazione corrente, comprese le sue
// scritture. Solo la valutazione pura avviene fuori dalla transazione: un errore
// aritmetico del server non distrugge lo snapshot né richiede di rigiocare SQL.
const { calculateObjectSize } = require('bson');

function cursore(database, coll, pipeline, options, collect, ctx, convertError) {
  let cursor, pending, closed = false;
  async function open() {
    const cache = new Map(); let bytes = 0;
    async function source(name) {
      if (!cache.has(name)) {
        const rows = await collect(database.collection(name).find({}, ctx.opzioni(options.session)));
        bytes += rows.reduce((n, row) => n + calculateObjectSize(row) + 16, 0);
        if (bytes > 16 * 1024 * 1024 - 4096) throw new Error('Snapshot delle espressioni SQL oltre il budget complessivo BSON.');
        cache.set(name, rows);
      }
      return { $documents: { $literal: cache.get(name) } };
    }
    async function expand(stages) {
      const result = [];
      for (const stage of stages) {
        if (stage.$lookup) {
          const { from, localField, foreignField, ...lookup } = stage.$lookup;
          const inner = await expand(lookup.pipeline || []);
          if (from) inner.unshift(await source(from));
          if (localField) {
            const variable = 'codedbSnapshotJoin';
            lookup.let = { ...lookup.let, [variable]: `$${localField}` };
            // I JOIN SQL semplici richiedono uguaglianza e rifiutano NULL;
            // l'emettitore conserva il relativo filtro nella pipeline.
            inner.splice(from ? 1 : 0, 0, { $match: { $expr: { $eq: [`$${foreignField}`, `$$${variable}`] } } });
          }
          result.push({ $lookup: { ...lookup, pipeline: inner } });
        } else if (stage.$unionWith) {
          const union = stage.$unionWith;
          const inner = await expand(union.pipeline || []);
          if (union.coll) inner.unshift(await source(union.coll));
          result.push({ $unionWith: { pipeline: inner } });
        } else if (stage.$facet) {
          const facets = {};
          for (const [name, inner] of Object.entries(stage.$facet)) facets[name] = await expand(inner);
          result.push({ $facet: facets });
        } else {
          // Questo percorso riceve soltanto piani SQL di lettura: nessuna
          // scrittura, lettura esterna o esecuzione JavaScript può sfuggire.
          if (!['$documents', '$match', '$project', '$set', '$addFields', '$unset', '$replaceWith', '$replaceRoot', '$sort', '$skip', '$limit', '$group', '$unwind', '$count', '$setWindowFields'].includes(Object.keys(stage)[0])) throw new Error('Stadio non puro nel piano SQL con savepoint.');
          result.push(stage);
        }
      }
      return result;
    }
    const expanded = await expand(pipeline);
    if (coll) expanded.unshift(await source(coll));
    if (calculateObjectSize({ pipeline: expanded }) > 16 * 1024 * 1024 - 4096) throw new Error('Snapshot delle espressioni SQL oltre la dimensione massima BSON del comando.');
    const { session: ignored, ...safeOptions } = options;
    cursor = database.aggregate(expanded, { ...safeOptions, ...ctx.opzioni() });
    if (closed) await cursor.close();
    return cursor;
  }
  const invoke = async method => {
    try { const c = await (pending ||= open()); return closed ? null : await c[method](); }
    catch (error) { throw convertError(error); }
  };
  return {
    next: () => invoke('next'), hasNext: () => invoke('hasNext'),
    async close() { closed = true; if (cursor) await cursor.close(); },
    async *[Symbol.asyncIterator]() { try { let row; while ((row = await invoke('next')) !== null) yield row; } finally { await this.close(); } },
  };
}
module.exports = { cursore };

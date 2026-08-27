export const GRAFO_BUDGET = Object.freeze({ nodes: 120, fields: 12, links: 240, effectsThreshold: 60 });

export function degradaSchemaGrafo(schema, budget = GRAFO_BUDGET) {
  const tutte = schema && schema.collections || [];
  const cursor = Number(schema && schema.schemaPage && schema.schemaPage.cursor);
  // Dopo una continuazione `unisciPagineSchema` conserva le pagine già viste.
  // La finestra visibile deve però avanzare al cursore appena richiesto:
  // troncare sempre dai primi N nodi rendeva invisibile ogni pagina successiva.
  const start = tutte.length > budget.nodes && Number.isSafeInteger(cursor) && cursor >= 0
    ? Math.min(cursor, Math.max(0, tutte.length - 1))
    : 0;
  const collections = tutte.slice(start, start + budget.nodes).map((collection) => ({
    ...collection,
    fields: (collection.fields || []).slice(0, budget.fields),
  }));
  const names = new Set(collections.map((collection) => collection.name));
  const relations = (schema && schema.relations || [])
    .filter((relation) => names.has(relation.from) && names.has(relation.to))
    .slice(0, budget.links);
  const incomplete = !!(schema && schema.schemaPage && !schema.schemaPage.complete)
    || (schema && schema.collections || []).length > collections.length
    || (schema && schema.relations || []).length > relations.length;
  return {
    schema: { ...schema, collections, relations },
    policy: {
      incomplete,
      reducedEffects: incomplete || collections.length > budget.effectsThreshold,
      budget: { ...budget },
    },
  };
}

export function unisciPagineSchema(base, page, { preservePagination = false } = {}) {
  const collections = new Map((base && base.collections || []).map((item) => [item.name, item]));
  for (const item of page.collections || []) collections.set(item.name, item);
  const relations = new Map((base && base.relations || []).map((item) => [JSON.stringify(item), item]));
  for (const item of page.relations || []) relations.set(JSON.stringify(item), item);
  return {
    ...page,
    schemaPage: preservePagination ? base.schemaPage : page.schemaPage,
    collections: [...collections.values()], relations: [...relations.values()],
  };
}

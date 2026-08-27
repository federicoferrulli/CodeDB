'use strict';

const DEFAULT_SCHEMA_BUDGET = Object.freeze({ collections: 80, fields: 40, relations: 200 });
const MAX_SCHEMA_BUDGET = Object.freeze({ collections: 200, fields: 200, relations: 1000 });

function intero(value, fallback, max) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

function limitaSchema(schema, richiesta = {}) {
  const allCollections = Array.isArray(schema && schema.collections) ? schema.collections : [];
  const allRelations = Array.isArray(schema && schema.relations) ? schema.relations : [];
  const budget = {
    collections: intero(richiesta.collectionLimit, DEFAULT_SCHEMA_BUDGET.collections, MAX_SCHEMA_BUDGET.collections),
    fields: intero(richiesta.fieldLimit, DEFAULT_SCHEMA_BUDGET.fields, MAX_SCHEMA_BUDGET.fields),
    relations: intero(richiesta.relationLimit, DEFAULT_SCHEMA_BUDGET.relations, MAX_SCHEMA_BUDGET.relations),
  };
  const focus = String(richiesta.focus || '').trim();
  const cursor = Math.max(0, Number.isSafeInteger(Number(richiesta.cursor)) ? Number(richiesta.cursor) : 0);
  const neighbors = new Set(allRelations.flatMap((relation) => {
    if (relation.from === focus) return [relation.to];
    if (relation.to === focus) return [relation.from];
    return [];
  }));
  const ordered = focus
    ? [
      ...allCollections.filter((c) => c.name === focus),
      ...allCollections.filter((c) => c.name !== focus && neighbors.has(c.name)),
      ...allCollections.filter((c) => c.name !== focus && !neighbors.has(c.name)),
    ]
    : allCollections;
  const selected = ordered.slice(cursor, cursor + budget.collections).map((collection) => ({
    ...collection,
    fields: (collection.fields || []).slice(0, budget.fields),
    fieldsPage: {
      total: (collection.fields || []).length,
      omitted: Math.max(0, (collection.fields || []).length - budget.fields),
      complete: (collection.fields || []).length <= budget.fields,
    },
  }));
  const selectedNames = new Set(selected.map((c) => c.name));
  const relevantRelations = allRelations.filter((relation) => selectedNames.has(relation.from));
  const relations = relevantRelations.slice(0, budget.relations);
  const nextCursor = cursor + selected.length < ordered.length ? cursor + selected.length : null;
  const totalFields = allCollections.reduce((sum, collection) => sum + (collection.fields || []).length, 0);
  const returnedFields = selected.reduce((sum, collection) => sum + collection.fields.length, 0);
  const complete = nextCursor == null
    && relevantRelations.length <= budget.relations
    && selected.every((collection) => collection.fieldsPage.complete);
  return {
    collections: selected,
    relations,
    schemaPage: {
      complete,
      cursor,
      nextCursor,
      focus: focus || null,
      budget,
      totals: { collections: allCollections.length, fields: totalFields, relations: allRelations.length },
      omitted: {
        collections: Math.max(0, allCollections.length - (cursor + selected.length)),
        fields: Math.max(0, totalFields - returnedFields),
        relations: Math.max(0, relevantRelations.length - relations.length),
      },
    },
  };
}

module.exports = { limitaSchema, DEFAULT_SCHEMA_BUDGET, MAX_SCHEMA_BUDGET };

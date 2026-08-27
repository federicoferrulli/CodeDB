'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

module.exports = (async () => {
  console.log('--- Test degradazione grafo 3D ---');
  const { degradaSchemaGrafo, unisciPagineSchema } = await import(pathToFileURL(
    path.join(__dirname, '..', 'public', 'js', 'grafo-budget.js'),
  ).href);
  const schema = {
    collections: Array.from({ length: 300 }, (_, i) => ({
      name: `n${i}`, fields: Array.from({ length: 50 }, (_, j) => ({ name: `f${j}` })),
    })),
    relations: Array.from({ length: 299 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
    schemaPage: { complete: false },
  };
  const result = degradaSchemaGrafo(schema);
  assert(result.schema.collections.length <= 120);
  assert(result.schema.collections.every((node) => node.fields.length <= 12));
  assert(result.schema.relations.length <= 240);
  assert.strictEqual(result.policy.reducedEffects, true);
  assert.strictEqual(result.policy.etichette, true,
    'centoventi nodi restano etichettati: i nomi delle tabelle SONO l informazione del grafo');
  const small = degradaSchemaGrafo({ collections: [{ name: 'a', fields: [{ name: 'id' }] }], relations: [] });
  assert.strictEqual(small.policy.reducedEffects, false);

  /*
   * Regressione misurata su un caso reale: sedici tabelle, una con piu' campi
   * del budget. `limitaSchema` marca allora `schemaPage.complete = false` per
   * il solo troncamento dei CAMPI, e la politica lo prendeva per «grafo troppo
   * grande»: si spegnevano etichette, particelle e rotazione automatica su uno
   * schema minuscolo. Il troncamento dei campi non ha alcun rapporto con il
   * costo del disegno.
   */
  const sedici = degradaSchemaGrafo({
    collections: Array.from({ length: 16 }, (_, i) => ({
      name: `t${i}`,
      fields: Array.from({ length: i === 0 ? 40 : 3 }, (_, j) => ({ name: `f${j}` })),
    })),
    relations: [{ from: 't0', to: 't1' }],
    schemaPage: { complete: false, cursor: 0, nextCursor: null },
  });
  assert.strictEqual(sedici.policy.incomplete, true,
    'lo schema resta dichiaratamente troncato: quel badge e giusto');
  assert.strictEqual(sedici.policy.reducedEffects, false,
    'sedici tabelle non sono un grafo grande: gli effetti non si riducono per un campo troncato');
  assert.strictEqual(sedici.policy.etichette, true,
    'e soprattutto i nomi delle tabelle restano visibili');
  const merged = unisciPagineSchema(
    { collections: [{ name: 'a', fields: [] }], relations: [] },
    { collections: [{ name: 'a', fields: [{ name: 'id' }] }], relations: [], schemaPage: { complete: true } },
  );
  assert.strictEqual(merged.collections[0].fields.length, 1, 'un nodo si amplia senza scaricare di nuovo tutto lo schema');
  const prima = {
    collections: schema.collections.slice(0, 120), relations: schema.relations.slice(0, 119),
    schemaPage: { complete: false, cursor: 0, nextCursor: 120 },
  };
  const seconda = {
    collections: schema.collections.slice(120, 240), relations: schema.relations.slice(120, 239),
    schemaPage: { complete: false, cursor: 120, nextCursor: 240 },
  };
  const finestraSuccessiva = degradaSchemaGrafo(unisciPagineSchema(prima, seconda));
  assert.strictEqual(finestraSuccessiva.schema.collections[0].name, 'n120',
    'la continuazione deve rendere visibile la nuova porzione, non troncarla dietro la prima');
  const dettaglio = unisciPagineSchema(seconda, {
    collections: [{ name: 'n150', fields: [{ name: 'dettaglio' }] }], relations: [],
    schemaPage: { complete: true, cursor: 0, nextCursor: null },
  }, { preservePagination: true });
  assert.strictEqual(dettaglio.schemaPage.cursor, 120, 'caricare i campi di un nodo non deve perdere la pagina corrente');
  console.log('  OK   budget nodi/campi/relazioni, effetti ridotti e ampliamento puntuale');
})();

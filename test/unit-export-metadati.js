'use strict';

/* ---------------------------------------------------------------------------
 * Regressione: l'export JSON legge i metadati di una tabella una volta sola,
 * anche quando le pagine successive arrivano dopo la scadenza della cache
 * breve usata dalla griglia. Il catalogo finto conta le letture e le righe
 * verificano anche che una colonna generata resti fuori dall'artefatto.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');

function preparaStrategia(Strategy) {
  const strategy = new Strategy();
  let lettureMetadati = 0;
  strategy.primaryKey = async () => [];
  strategy.tableColumnsInfo = async () => {
    lettureMetadati++;
    return {
      columns: [
        { name: 'id', type: 'integer', generated: false },
        { name: 'totale', type: 'integer', generated: true },
      ],
      geo: new Map(),
      geoNativo: new Map(),
    };
  };

  if (Strategy === MySqlStrategy) {
    strategy.pool = {
      query: async (sql) => {
        if (/COUNT\(\*\)/i.test(sql)) return [[{ total: 2 }], []];
        return [[{ id: 1, totale: 2 }], [{ name: 'id' }, { name: 'totale' }]];
      },
    };
  } else {
    strategy.pool = {
      query: async (sql) => {
        if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: 2 }], fields: [] };
        return {
          rows: [{ id: 1, totale: 2 }],
          fields: [{ name: 'id' }, { name: 'totale' }],
        };
      },
    };
  }

  return { strategy, lettureMetadati: () => lettureMetadati };
}

module.exports = (async () => {
  for (const Strategy of [MySqlStrategy, PostgreSqlStrategy]) {
    const { strategy, lettureMetadati } = preparaStrategia(Strategy);
    const prima = await strategy.collectionExport('vendite', 'righe', {
      format: 'json', limit: 1, skip: 0,
    });
    const seconda = await strategy.collectionExport('vendite', 'righe', {
      format: 'json', limit: 1, skip: 1,
    });

    assert.deepStrictEqual(JSON.parse(prima.lines[0]), { id: 1 });
    assert.deepStrictEqual(JSON.parse(seconda.lines[0]), { id: 1 });
    assert.strictEqual(
      lettureMetadati(), 1,
      `${Strategy.name}: i blocchi dello stesso export devono condividere i metadati della tabella`,
    );

    // Una nuova prima pagina apre un nuovo export e rinnova lo snapshot: la
    // memoizzazione non deve rendere invisibile per sempre una ALTER esterna.
    await strategy.collectionExport('vendite', 'righe', {
      format: 'json', limit: 1, skip: 0,
    });
    assert.strictEqual(
      lettureMetadati(), 2,
      `${Strategy.name}: un nuovo export deve rinnovare i metadati della tabella`,
    );
  }

  console.log('  OK   export JSON: metadati letti una volta per tabella sui due motori SQL');
})();

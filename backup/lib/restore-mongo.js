'use strict';

/* ---------------------------------------------------------------------------
 * Applicazione di un singolo layer di backup su MongoDB (opzioni collection,
 * tombstone, insertMany/replaceOne/BSON fedele).
 * ------------------------------------------------------------------------- */

const { EJSON } = require('bson');
const { preparaCollectionMongo } = require('../../db/mongoCollectionOptions');
const { readLines, fileDelBackup } = require('./util');
const {
  BATCH_SIZE, eliminaSePresente, registraFileAtteso, registraAttesa,
  assertColumnsAndIdentity, checkApplied,
} = require('./restore-catena');

async function restoreLayerMongo({
  strategy, targetDb, layer, isFirst, onlyCollections, drop, log, problems, tracker, mongoOptions,
}) {
  const client = strategy.client;
  const dataFiles = layer.manifest.files.filter(
    (f) => f.kind === 'data' && (!onlyCollections || onlyCollections.includes(f.collection))
  );
  let total = 0;
  for (const f of dataFiles) {
    const primaComparsa = !tracker.has(f.collection);
    registraFileAtteso(tracker, f);
    const collection = client.db(targetDb).collection(f.collection);
    if (primaComparsa && drop) {
      await eliminaSePresente(() => collection.drop(), {
        dbType: 'mongodb', target: `${targetDb}.${f.collection}`,
      });
    }
    if (primaComparsa) {
      const metadata = mongoOptions.get(f.collection);
      await preparaCollectionMongo(client, targetDb, f.collection, metadata?.options || {}, { deferValidation: true, metadata });
    }
    if (!f.identity) {
      const empty = (await collection.countDocuments({})) === 0;
      assertColumnsAndIdentity(f, [], null, { empty });
    }

    const eliminazioni = layer.manifest.files.find((x) => x.kind === 'tombstones' && x.collection === f.collection);
    if (!isFirst && eliminazioni) {
      let batchDelete = [];
      const flushDelete = async () => {
        if (!batchDelete.length) return;
        if (eliminazioni.encoding === 'bson-base64') await require('../../db/mongoBson').deleteRows(client, targetDb, f.collection, batchDelete);
        else await collection.bulkWrite(
          batchDelete.map((id) => ({ deleteOne: { filter: id } })),
          { ordered: true }
        );
        batchDelete = [];
      };
      for await (const line of readLines(fileDelBackup(layer.dir, eliminazioni.path, 'file di cancellazioni'))) {
        batchDelete.push(eliminazioni.encoding === 'bson-base64' ? JSON.parse(line) : EJSON.parse(line, { relaxed: false }));
        if (batchDelete.length >= BATCH_SIZE) await flushDelete();
      }
      await flushDelete();
    }

    let batch = [];
    let applied = 0;
    const flush = async () => {
      if (!batch.length) return;
      if (f.encoding === 'bson-base64') {
        const result = await require('../../db/mongoBson').importRows(client, targetDb, f.collection, batch,
          !isFirst || (!drop && !!f.identity), { preservaIdentita: !drop && !!f.identity });
        if (result.failed) throw new Error(result.errors.join('; '));
      } else if (isFirst && (drop || !f.identity)) {
        await collection.insertMany(batch, { ordered: false });
      } else {
        await collection.bulkWrite(
          batch.map((doc) => {
            const { _id, ...fields } = doc;
            return { replaceOne: { filter: { _id }, replacement: !drop && f.identity ? fields : doc, upsert: true } };
          }),
          { ordered: false }
        );
      }
      batch = [];
    };
    for await (const line of readLines(fileDelBackup(layer.dir, f.path, 'file di dati'))) {
      const row = f.encoding === 'bson-base64' ? JSON.parse(line) : EJSON.parse(line, { relaxed: false });
      registraAttesa(tracker, f);
      batch.push(row);
      applied += 1;
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    total += applied;
    log.info(`  ${f.collection}: ${applied} documenti applicati (layer ${layer.manifest.id}).`);
    checkApplied(problems, layer, f, applied);
  }
  return total;
}

module.exports = { restoreLayerMongo };

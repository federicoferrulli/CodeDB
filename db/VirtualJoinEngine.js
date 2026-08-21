'use strict';

const EJSON = require('bson').EJSON;
// La quotatura degli identificatori è una regola sola per tutto il repo: vedi
// db/identificatori.js.
const { quotaSempre } = require('./identificatori');

// Normalizza a stringa una chiave di join. I documenti arrivano serializzati in
// EJSON relaxed, quindi i valori tipizzati sono oggetti wrapper ($oid, $date,
// $numberLong...): senza scompattarli, String() darebbe "[object Object]" e il
// match fallirebbe. Deve restare coerente in TUTTI i punti (estrazione chiavi,
// indicizzazione di B e merge), altrimenti i JOIN su ObjectId/Date/Long
// restituiscono silenziosamente null.
function keyToString(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') {
    if (val.$oid) return String(val.$oid);
    if (val.$numberLong) return String(val.$numberLong);
    if (val.$date != null) {
      // $date può essere una stringa ISO oppure { $numberLong: "..." }
      const d = val.$date;
      return String(d && typeof d === 'object' && d.$numberLong ? d.$numberLong : d);
    }
  }
  return String(val);
}

// Intero positivo per le clausole LIMIT (interpolate direttamente nell'SQL):
// vanno coercite per non rompere/iniettare la query con valori non numerici.
function toLimit(val, fallback = 1000) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 100000);
}

/**
 * Motore per Virtual JOINs e Aggregazioni Cross-Database (MySQL <-> MongoDB)
 */
class VirtualJoinEngine {
  /**
   * Esegue una query virtual join cross-database
   * @param {Object} spec Specifica del Virtual Join
   * @param {DbStrategy} strategyA Istanza della prima strategia
   * @param {DbStrategy} strategyB Istanza della seconda strategia
   * @returns {Promise<Array>} Risultato del merge in memoria
   */
  static async execute(spec, strategyA, strategyB) {
    if (!spec || !spec.virtualJoin) {
      throw new Error('Formato query Virtual Join non valido. Inserisci una struttura {"virtualJoin": ...}');
    }

    const vj = spec.virtualJoin;
    const { sourceA, sourceB, on, as = 'joined_data' } = vj;
    const maxPayloadSize = toLimit(vj.maxPayloadSize, 1000);

    if (!sourceA || !sourceB || !on || !on.leftKey || !on.rightKey) {
      throw new Error('Definizione Virtual Join incompleta: specificare sourceA, sourceB, on.leftKey e on.rightKey.');
    }

    const isSql = (type) => ['mysql', 'postgresql', 'postgres'].includes(String(type).toLowerCase());
    // Quoting dell'identificatore: la regola è una sola per tutto il repo e sta
    // in db/identificatori.js, che conosce anche il raddoppio del delimitatore
    // interno (`"` su PostgreSQL, `` ` `` su MySQL).
    const qid = (type, name) => quotaSempre(name, type);

    // Fetching dati Sorgente A (SQL o MongoDB)
    let rowsA = [];
    const typeA = sourceA.dbType || strategyA.type;
    if (isSql(typeA)) {
      const tableName = sourceA.table || sourceA.collection;
      const sql = sourceA.query || `SELECT * FROM ${qid(typeA, tableName)} LIMIT ${maxPayloadSize}`;
      const resA = await strategyA.collectionAggregate(sourceA.db, tableName, { pipeline: sql });
      rowsA = resA.docs || [];
    } else {
      const pipelineStr = typeof sourceA.query === 'string' ? sourceA.query : JSON.stringify(sourceA.query || []);
      const resA = await strategyA.collectionAggregate(sourceA.db, sourceA.collection, { pipeline: pipelineStr });
      rowsA = resA.docs || [];
    }

    if (!rowsA.length) return [];

    // Estrazione chiavi per la query guidata sulla Sorgente B (Batch In-Memory
    // Lookup). Map<chiaveNormalizzata, valoreOriginale>: la stringa serve per il
    // dedup e per l'IN dei DB SQL; il valore originale (wrapper EJSON come
    // {$oid}/{$numberLong}/{$date}) serve per l'$in tipizzato lato MongoDB, così
    // EJSON.parse in collectionAggregate lo ri-tipizza (ObjectId/Long/Date) e il
    // match funziona anche su chiavi non-ObjectId.
    const joinKeys = new Map();
    rowsA.forEach((row) => {
      const raw = row[on.leftKey];
      const key = keyToString(raw);
      if (key !== null && !joinKeys.has(key)) joinKeys.set(key, raw);
    });

    if (joinKeys.size === 0) return rowsA;

    // Fetching dati Sorgente B
    let rowsB = [];
    const keysArray = Array.from(joinKeys.keys());
    const typeB = sourceB.dbType || strategyB.type;

    if (!isSql(typeB)) {
      // Per MongoDB: pipeline $match $in. Usa il valore originale (già tipizzato
      // in forma EJSON); per le stringhe di 24 esadecimali applica l'euristica
      // hex→ObjectId, utile ai JOIN cross-tipo (stringa su un lato, ObjectId
      // sull'altro).
      const oidsOrKeys = keysArray.map((k) => {
        const raw = joinKeys.get(k);
        if (typeof raw === 'string' && /^[0-9a-fA-F]{24}$/.test(raw)) return { $oid: raw };
        return raw;
      });
      const matchPipeline = [
        { $match: { [on.rightKey]: { $in: oidsOrKeys } } },
        { $limit: maxPayloadSize }
      ];
      const resB = await strategyB.collectionAggregate(sourceB.db, sourceB.collection, { pipeline: JSON.stringify(matchPipeline) });
      rowsB = resB.docs || [];
    } else {
      // Per SQL (MySQL / PostgreSQL): WHERE rightKey IN (...)
      const tableName = sourceB.table || sourceB.collection;
      const escapedKeys = keysArray.map((k) => `'${String(k).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`).join(',');
      const sql = `SELECT * FROM ${qid(typeB, tableName)} WHERE ${qid(typeB, on.rightKey)} IN (${escapedKeys}) LIMIT ${maxPayloadSize}`;
      const resB = await strategyB.collectionAggregate(sourceB.db, tableName, { pipeline: sql });
      rowsB = resB.docs || [];
    }

    // Indicizzazione Sorgente B in una Map in-memory per O(1) lookup
    const mapB = new Map();
    rowsB.forEach((bDoc) => {
      const bKeyStr = keyToString(bDoc[on.rightKey]);
      if (bKeyStr !== null) mapB.set(bKeyStr, bDoc);
    });

    // Merge in memoria
    const mergedResults = rowsA.map((aDoc) => {
      const aKeyStr = keyToString(aDoc[on.leftKey]);
      const matchB = (aKeyStr !== null && mapB.get(aKeyStr)) || null;
      return {
        ...aDoc,
        [as]: matchB
      };
    });

    return mergedResults;
  }
}

module.exports = VirtualJoinEngine;

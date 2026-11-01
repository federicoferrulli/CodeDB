'use strict';

const DbStrategy = require('./DbStrategy');
const { isWriteSql, isWriteMongoPipeline } = require('../auth/capabilities');
const { splitStatementsDetailed } = require('./sqlText');
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
    return JSON.stringify(val);
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
    const typeA = strategyA.type;
    const typeB = strategyB.type;
    for (const [source, type] of [[sourceA, typeA], [sourceB, typeB]]) {
      if (source.dbType && source.dbType !== type && !(source.dbType === 'postgres' && type === 'postgresql')) {
        throw new Error('Il tipo della sorgente Virtual JOIN non corrisponde alla connessione selezionata.');
      }
      if (source.query && (isSql(type)
        ? splitStatementsDetailed(String(source.query)).length !== 1 || isWriteSql(source.query)
        : isWriteMongoPipeline(typeof source.query === 'string' ? JSON.parse(source.query) : source.query))) {
        throw new Error('Le sorgenti di un Virtual JOIN devono essere query di sola lettura.');
      }
    }
    const leggi = async (strategy, source, pipeline, params) => {
      const res = await strategy.collectionAggregate(source.db, source.table || source.collection,
        { pipeline, params, maxRows: maxPayloadSize + 1, readOnly: true }).catch(err => {
          // L'intervallo appartiene alla query interna, non al JSON del Virtual JOIN.
          delete err.queryError;
          throw err;
        });
      if (res.truncated || res.docs?.length > maxPayloadSize) {
        throw new Error(`Virtual JOIN incompleto: una sorgente supera il budget di ${maxPayloadSize} righe o di byte. Restringi le sorgenti o aumenta il budget.`);
      }
      return res.docs || [];
    };
    if (isSql(typeA)) {
      const tableName = sourceA.table || sourceA.collection;
      const sql = sourceA.query || `SELECT * FROM ${qid(typeA, tableName)} LIMIT ${maxPayloadSize + 1}`;
      rowsA = await leggi(strategyA, sourceA, sql);
    } else {
      const pipelineStr = typeof sourceA.query === 'string' ? sourceA.query : JSON.stringify(sourceA.query || []);
      rowsA = await leggi(strategyA, sourceA, pipelineStr);
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

    if (joinKeys.size === 0) return rowsA.map(row => ({ ...row, [as]: null }));

    // Fetching dati Sorgente B
    let rowsB = [];
    const keysArray = Array.from(joinKeys.keys());

    if (!isSql(typeB)) {
      // Per MongoDB: pipeline $match $in. Usa il valore originale (già tipizzato
      // in forma EJSON); per le stringhe di 24 esadecimali applica l'euristica
      // hex→ObjectId, utile ai JOIN cross-tipo (stringa su un lato, ObjectId
      // sull'altro).
      const oidsOrKeys = keysArray.flatMap((k) => {
        const raw = joinKeys.get(k);
        if (typeof raw === 'string' && /^[0-9a-fA-F]{24}$/.test(raw)) return [raw, { $oid: raw }];
        return [raw];
      });
      const matchPipeline = [
        ...(typeof sourceB.query === 'string' ? JSON.parse(sourceB.query) : sourceB.query || []),
        { $match: { [on.rightKey]: { $in: oidsOrKeys } } },
        { $limit: maxPayloadSize + 1 }
      ];
      rowsB = await leggi(strategyB, sourceB, JSON.stringify(matchPipeline));
    } else {
      // Per SQL (MySQL / PostgreSQL): WHERE rightKey IN (...)
      const tableName = sourceB.table || sourceB.collection;
      const parametri = keysArray.map((_, i) => typeB === 'mysql' ? '?' : `$${i + 1}`).join(',');
      const from = sourceB.query ? `(${String(sourceB.query).trim().replace(/;$/, '')}) AS codedb_join` : qid(typeB, tableName);
      const sql = `SELECT * FROM ${from} WHERE ${qid(typeB, on.rightKey)} IN (${parametri}) LIMIT ${maxPayloadSize + 1}`;
      rowsB = await leggi(strategyB, sourceB, sql, keysArray);
    }

    // Indicizzazione Sorgente B in una Map in-memory per O(1) lookup
    const mapB = new Map();
    rowsB.forEach((bDoc) => {
      const bKeyStr = keyToString(bDoc[on.rightKey]);
      if (bKeyStr !== null) {
        if (!mapB.has(bKeyStr)) mapB.set(bKeyStr, []);
        mapB.get(bKeyStr).push(bDoc);
      }
    });

    // Merge in memoria
    const mergedResults = [];
    let bytes = 2;
    const budget = DbStrategy.maxResultBytes(strategyA.env);
    for (const aDoc of rowsA) {
      const aKeyStr = keyToString(aDoc[on.leftKey]);
      for (const matchB of (aKeyStr !== null && mapB.get(aKeyStr)) || [null]) {
        const row = { ...aDoc, [as]: matchB };
        bytes += Buffer.byteLength(JSON.stringify(row)) + (mergedResults.length ? 1 : 0);
        if (mergedResults.length >= maxPayloadSize || (budget > 0 && bytes > budget)) {
          throw new Error('Virtual JOIN incompleto: il risultato supera il budget. Restringi le sorgenti o aumenta il budget.');
        }
        mergedResults.push(row);
      }
    }

    return mergedResults;
  }
}

module.exports = VirtualJoinEngine;

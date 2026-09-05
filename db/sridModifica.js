'use strict';

const { isGeoJson, daFormaDriverMysql } = require('./geometry');

const ERRORE_SRID = 'SRID non noto: CodeDB non può modificare la geometria senza reinterpretare le coordinate. Verifica i privilegi SELECT sui metadata e sulla geometria originale oppure dichiara lo SRID nello schema della colonna.';

// Legge il riferimento originale sotto lock: due editor concorrenti non devono
// separare la lettura dello SRID dalla scrittura. La cache di colonna resta intatta.
async function modificaConSrid({ pool, mysql, info, set, table, where, qid }, modifica) {
  const colonne = [...info.geo.keys()].filter((col) => isGeoJson(set[col]) || (mysql && daFormaDriverMysql(set[col])));
  if (!colonne.length) return modifica(pool, info.geo);
  if (colonne.some((col) => info.geo.get(col).erroreSrid)) throw new Error(ERRORE_SRID);
  const conn = await (mysql ? pool.getConnection() : pool.connect());
  try {
    await conn.query('BEGIN');
    let result;
    try { result = await conn.query(
      `SELECT ${colonne.map((col) => `ST_SRID(${qid(col)}) AS ${qid(col)}`).join(', ')} FROM ${table} WHERE ${where.sql} FOR UPDATE`,
      where.params
    ); } catch (err) { throw new Error(ERRORE_SRID, { cause: err }); }
    const rows = mysql ? result[0] : result.rows;
    if (!rows.length) {
      await conn.query('COMMIT');
      return { matched: 0, modified: 0 };
    }
    const geo = new Map(info.geo);
    for (const col of colonne) {
      const metadata = info.geo.get(col);
      // PostGIS indica con 0 anche una colonna priva di vincolo: solo il
      // valore originale può attestare uno zero effettivo.
      const dichiarato = !mysql && metadata.srid === 0 ? null : metadata.srid;
      const valori = rows.map((row) => row[col] == null ? dichiarato : Number(row[col]));
      const srid = valori[0];
      if (srid == null || !Number.isInteger(srid) || srid < 0 || valori.some((v) => v !== srid)) throw new Error(ERRORE_SRID);
      geo.set(col, { ...metadata, srid });
    }
    const resultModifica = await modifica(conn, geo);
    await conn.query('COMMIT');
    return resultModifica;
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { modificaConSrid, ERRORE_SRID };

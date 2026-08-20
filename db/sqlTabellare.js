'use strict';

/* ---------------------------------------------------------------------------
 * Il tabellare comune ai due motori SQL.
 *
 * La griglia dati è una sola: la stessa colonna cliccata produce lo stesso
 * ordinamento, la stessa riga selezionata produce lo stesso `_id`, e lo stesso
 * `_id` rimandato indietro deve colpire quella riga e non un'altra. Queste
 * quattro decisioni non hanno nulla di MySQL né di PostgreSQL — vivevano però
 * in due copie byte per byte identiche dentro i due adattatori, messaggio
 * d'errore e costanti comprese, dove correggerne una lasciava l'altra intatta
 * senza che nulla lo segnalasse.
 *
 * Ciò che davvero cambia fra i due motori è soltanto il DIALETTO: come si
 * quota un identificatore, come si qualifica una tabella, come si scrive
 * l'uguaglianza sulla chiave (`<=>` e `?` su MySQL, `IS NULL`/`=` e `$n` su
 * PostgreSQL). Sta tutto nell'oggetto passato a `tabellare()`, e resta
 * dell'adattatore.
 *
 * Sono funzioni pure: si provano senza alcun database acceso
 * (`test/unit-sql-tabellare.js`).
 * ------------------------------------------------------------------------- */

const DbStrategy = require('./DbStrategy');
const { parseClientValue } = require('./sqlValori');

// _id virtuale per il client: la chiave primaria come oggetto
// { colonna: valore }. Senza chiave primaria si usa l'intera riga come
// chiave composita di fallback.
function componiIdRiga(row, pkCols, allCols) {
  const cols = pkCols.length ? pkCols : allCols;
  const id = {};
  for (const c of cols) id[c] = row[c];
  return id;
}

// Risale dalla chiave inviata dal client (JSON.stringify di _id) e la
// trasforma in clausola WHERE. `whereFromId` è la parte di dialetto.
function leggiIdRiga(rawId, whereFromId) {
  const id = parseClientValue(rawId);
  if (!id || typeof id !== 'object' || Array.isArray(id)) {
    throw new Error('Identificatore di riga non valido.');
  }
  return whereFromId(id);
}

// ORDER BY: accetta sia SQL libero ("name ASC") sia il JSON {"name": 1}
// prodotto dal click sulle intestazioni di colonna.
function componiOrdinamento(text, qid) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.startsWith('{')) {
    let spec;
    try {
      spec = JSON.parse(t);
    } catch {
      throw new Error('Ordinamento non valido: usare SQL (es. name ASC) oppure JSON (es. {"name":1}).');
    }
    const parts = Object.entries(spec).map(([col, dir]) => `${qid(col)} ${Number(dir) < 0 ? 'DESC' : 'ASC'}`);
    return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
  }
  return ` ORDER BY ${t}`;
}

// Pezzi comuni di una SELECT su filter/sort/limit/skip liberi (usati sia
// dalla query dati vera e propria sia dal suo EXPLAIN).
function componiSelezione(db, coll, payload, { qid, qtable }) {
  const where = String(payload.filter || '').trim();
  const whereSql = where ? ` WHERE ${where}` : '';
  const orderSql = componiOrdinamento(payload.sort, qid);
  const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), DbStrategy.resultCap(payload));
  const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
  const table = qtable(db, coll);
  return { table, whereSql, orderSql, limit, skip };
}

/**
 * Lega le quattro funzioni a un dialetto e le restituisce già pronte.
 * `dialetto`: { qid, qtable, whereFromId }.
 */
function tabellare(dialetto) {
  const { qid, qtable, whereFromId } = dialetto || {};
  if (typeof qid !== 'function' || typeof qtable !== 'function' || typeof whereFromId !== 'function') {
    throw new Error('Dialetto SQL incompleto: servono qid, qtable e whereFromId.');
  }
  return {
    makeId: (row, pkCols, allCols) => componiIdRiga(row, pkCols, allCols),
    parseRowId: (rawId) => leggiIdRiga(rawId, whereFromId),
    buildOrderBy: (text) => componiOrdinamento(text, qid),
    buildSelect: (db, coll, payload) => componiSelezione(db, coll, payload, { qid, qtable }),
  };
}

module.exports = {
  tabellare,
  componiIdRiga,
  leggiIdRiga,
  componiOrdinamento,
  componiSelezione,
};

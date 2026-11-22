'use strict';

const { randomUUID } = require('crypto');
const {
  pianificaDuplicazione,
  calcolaNuovoValore,
  documentoSorgente,
  applicaRicalcolo,
  valoreSemplice,
} = require('./duplica');

/**
 * Creazione di un indice SQL (`CREATE [UNIQUE] INDEX`), identica fra MySQL e
 * PostgreSQL a meno della quotatura degli identificatori (`qid`, `qtable`) e
 * dell'esecuzione sul pool.
 */
async function creaIndiceSql(strategia, { qid, qtable }, db, coll, payload) {
  const pool = strategia.requirePool();
  let spec;
  try {
    spec = JSON.parse(String((payload && payload.fields) || ''));
  } catch {
    throw new Error('Specifica dei campi non valida: usa ad es. {"email": 1}.');
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Object.keys(spec).length) {
    throw new Error('Specifica dei campi non valida: usa ad es. {"email": 1}.');
  }
  const cols = Object.entries(spec).map(([c, dir]) => `${qid(c)} ${Number(dir) < 0 ? 'DESC' : 'ASC'}`);
  const name = String((payload && payload.name) || '').trim() || `${Object.keys(spec).join('_')}_idx`;
  await pool.query(
    `CREATE ${payload && payload.unique ? 'UNIQUE ' : ''}INDEX ${qid(name)} ON ${qtable(db, coll)} (${cols.join(', ')})`
  );
  return { name };
}

/**
 * Documento pronto da inserire come duplicato della riga ricevuta sui motori
 * SQL: le decisioni pure vivono in `db/duplica.js`, mentre qui si interroga il
 * database (tramite il dialetto) solo per `MAX(col)` e l'esistenza dei valori
 * candidati.
 */
async function pianificaDuplicatoSql(strategia, { qid, qtable, segnaposto, esegui }, db, coll, payload) {
  strategia.requirePool();
  const doc = documentoSorgente(payload && payload.doc);
  const fields = await strategia.tableFields(db, coll);
  if (!fields.length) throw new Error(`Tabella "${coll}" non trovata in "${db}".`);
  const colonne = fields.map((f) => ({
    name: f.name,
    tipo: f.types[0],
    pk: f.key === 'PRI',
    nullable: f.nullable,
    generabile: f.autoIncrement,
    generata: f.generated,
  }));
  const piano = pianificaDuplicazione({
    doc,
    colonne,
    uniche: await strategia.uniqueIndexes(db, coll),
    conChiavi: Boolean(payload && payload.conChiavi === true),
    idVirtuale: !fields.some((f) => f.name === '_id'),
  });

  const table = qtable(db, coll);
  for (const nome of piano.ricalcola) {
    const col = colonne.find((c) => c.name === nome);
    const nuovo = await calcolaNuovoValore({
      tipo: col.tipo,
      originale: valoreSemplice(doc[nome]),
      massimo: async () => {
        const rows = await esegui(strategia, `SELECT MAX(${qid(nome)}) AS m FROM ${table}`);
        return rows && rows[0] ? rows[0].m : null;
      },
      esiste: async (v) => {
        const rows = await esegui(
          strategia,
          `SELECT 1 FROM ${table} WHERE ${qid(nome)} = ${segnaposto(1)} LIMIT 1`,
          [v]
        );
        return Array.isArray(rows) && rows.length > 0;
      },
      uuid: () => randomUUID(),
    });
    applicaRicalcolo(piano, nome, nuovo, { pk: col.pk, etichetta: col.tipo });
  }
  return { doc: JSON.stringify(piano.doc), note: piano.note, azioni: piano.azioni };
}

module.exports = { creaIndiceSql, pianificaDuplicatoSql };

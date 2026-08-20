'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari del tabellare comune ai due motori SQL (db/sqlTabellare.js).
 * Nessun database: sono funzioni pure, ed è per poterle provare qui che sono
 * state estratte dagli adattatori — dove esistevano in due copie identiche e
 * non erano coperte da nessun test.
 *
 * Cosa vale la pena verificare:
 *   1. l'`_id` virtuale usa la chiave primaria quando c'è e RIPIEGA sull'intera
 *      riga quando manca: se il ripiego sparisse, una tabella senza chiave
 *      primaria non sarebbe più modificabile dalla griglia;
 *   2. la lettura dell'`_id` rifiuta ciò che non è un oggetto (una stringa, un
 *      array, `null`): passarli a `whereFromId` produrrebbe un WHERE composto
 *      su indici numerici, cioè una condizione che colpisce righe a caso;
 *   3. l'ordinamento distingue il JSON del click sull'intestazione dall'SQL
 *      libero, e QUOTA i nomi di colonna del JSON col dialetto giusto — è la
 *      sola differenza osservabile fra i due motori su queste funzioni;
 *   4. la SELECT normalizza limite e salto: il limite è sempre dentro
 *      [1, resultCap] e il salto non è mai negativo, comunque il client li
 *      abbia scritti;
 *   5. la funzione è la STESSA per i due motori: gli stessi ingressi danno
 *      risultati che differiscono solo per il dialetto, e nulla può più
 *      divergere in silenzio.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const {
  tabellare, componiIdRiga, leggiIdRiga, componiOrdinamento, componiSelezione,
} = require('../db/sqlTabellare');

// Dialetti finti, gli stessi dei due adattatori ridotti all'osso: qui interessa
// che il tabellare CHIAMI il dialetto, non come il dialetto sia fatto.
const MYSQL = {
  qid: (n) => '`' + String(n).replace(/`/g, '``') + '`',
  qtable: (db, t) => `${MYSQL.qid(db)}.${MYSQL.qid(t)}`,
  whereFromId: (id) => {
    const cols = Object.keys(id);
    if (!cols.length) throw new Error('Identificatore di riga mancante.');
    return { sql: cols.map((c) => `${MYSQL.qid(c)} <=> ?`).join(' AND '), params: cols.map((c) => id[c]) };
  },
};
const PG = {
  qid: (n) => '"' + String(n).replace(/"/g, '""') + '"',
  qtable: (db, t) => `${PG.qid(db || 'public')}.${PG.qid(t)}`,
  whereFromId: (id) => {
    const cols = Object.keys(id);
    if (!cols.length) throw new Error('Identificatore di riga mancante.');
    let i = 1;
    return { sql: cols.map((c) => `${PG.qid(c)} = $${i++}`).join(' AND '), params: cols.map((c) => id[c]) };
  },
};

console.log('  --- Tabellare comune SQL (db/sqlTabellare.js) ---');

/* 1. Identificatore di riga -------------------------------------------------- */

assert.deepStrictEqual(
  componiIdRiga({ id: 7, nome: 'a', extra: true }, ['id'], ['id', 'nome', 'extra']),
  { id: 7 },
  'Con chiave primaria l\'_id contiene SOLO le sue colonne'
);
assert.deepStrictEqual(
  componiIdRiga({ id: 7, nome: 'a' }, [], ['id', 'nome']),
  { id: 7, nome: 'a' },
  'Senza chiave primaria si ripiega sull\'intera riga'
);
assert.deepStrictEqual(
  componiIdRiga({ ordine_id: 1, riga: 2, q: 5 }, ['ordine_id', 'riga'], ['ordine_id', 'riga', 'q']),
  { ordine_id: 1, riga: 2 },
  'Chiave composta: tutte le componenti, nell\'ordine dichiarato'
);
// Un valore NULL nella chiave deve restare nell'_id: toglierlo cambierebbe la
// riga identificata (il WHERE avrebbe una condizione in meno).
assert.deepStrictEqual(
  componiIdRiga({ a: null, b: 1 }, ['a', 'b'], ['a', 'b']),
  { a: null, b: 1 },
  'I NULL della chiave restano nell\'_id'
);
console.log('  OK   componiIdRiga: chiave primaria, ripiego, chiave composta, NULL');

/* 2. Lettura dell'identificatore --------------------------------------------- */

const letto = leggiIdRiga(JSON.stringify({ id: 7 }), MYSQL.whereFromId);
assert.strictEqual(letto.sql, '`id` <=> ?', 'La lettura passa dal dialetto per il WHERE');
assert.deepStrictEqual(letto.params, [7], 'I valori diventano parametri, mai testo interpolato');

for (const cattivo of ['"stringa"', '[1,2]', 'null', '42']) {
  assert.throws(
    () => leggiIdRiga(cattivo, MYSQL.whereFromId),
    /Identificatore di riga non valido/,
    `Deve rifiutare ${cattivo}: non è un oggetto { colonna: valore }`
  );
}
assert.throws(
  () => leggiIdRiga('{}', MYSQL.whereFromId),
  /Identificatore di riga mancante/,
  'Un oggetto vuoto non identifica nulla: WHERE assente = tutte le righe'
);
// Extended JSON: una data deve tornare Date, non la stringa "$date".
const conData = leggiIdRiga(JSON.stringify({ quando: { $date: '2020-01-02T03:04:05.000Z' } }), (id) => id);
assert.ok(conData.quando instanceof Date, 'I valori arrivano in EJSON e tornano tipi nativi');
console.log('  OK   leggiIdRiga: WHERE parametrizzato, rifiuti, EJSON');

/* 3. Ordinamento -------------------------------------------------------------- */

assert.strictEqual(componiOrdinamento('', MYSQL.qid), '', 'Ordinamento vuoto: nessuna clausola');
assert.strictEqual(componiOrdinamento('   ', MYSQL.qid), '', 'Solo spazi: nessuna clausola');
assert.strictEqual(componiOrdinamento(null, MYSQL.qid), '', 'Assente: nessuna clausola');
assert.strictEqual(componiOrdinamento('name ASC', MYSQL.qid), ' ORDER BY name ASC', 'SQL libero passa invariato');
assert.strictEqual(
  componiOrdinamento('{"name":1}', MYSQL.qid), ' ORDER BY `name` ASC',
  'JSON: colonna quotata col backtick su MySQL'
);
assert.strictEqual(
  componiOrdinamento('{"name":1}', PG.qid), ' ORDER BY "name" ASC',
  'JSON: colonna quotata con le virgolette su PostgreSQL'
);
assert.strictEqual(
  componiOrdinamento('{"a":1,"b":-1}', PG.qid), ' ORDER BY "a" ASC, "b" DESC',
  'Più colonne, direzione dal segno'
);
assert.strictEqual(componiOrdinamento('{}', MYSQL.qid), '', 'JSON vuoto: nessuna clausola, non " ORDER BY "');
assert.throws(
  () => componiOrdinamento('{non json', MYSQL.qid),
  /Ordinamento non valido/,
  'Un JSON rotto è un errore parlante, non una sintassi SQL invalida spedita al server'
);
console.log('  OK   componiOrdinamento: SQL libero, JSON, dialetto, JSON rotto');

/* 4. Pezzi della SELECT ------------------------------------------------------- */

const sel = componiSelezione('shop', 'orders', { filter: 'q > 1', sort: '{"id":-1}', limit: 20, skip: 40 }, MYSQL);
assert.strictEqual(sel.table, '`shop`.`orders`', 'Tabella sempre qualificata dal dialetto');
assert.strictEqual(sel.whereSql, ' WHERE q > 1', 'Il filtro arriva come frammento WHERE grezzo');
assert.strictEqual(sel.orderSql, ' ORDER BY `id` DESC', 'L\'ordinamento passa dalla stessa funzione');
assert.strictEqual(sel.limit, 20);
assert.strictEqual(sel.skip, 40);

const vuoto = componiSelezione('public', 'orders', {}, PG);
assert.strictEqual(vuoto.whereSql, '', 'Senza filtro nessun WHERE');
assert.strictEqual(vuoto.orderSql, '', 'Senza sort nessun ORDER BY');
assert.strictEqual(vuoto.limit, 50, 'Limite predefinito 50 (una pagina di griglia)');
assert.strictEqual(vuoto.skip, 0);

assert.strictEqual(componiSelezione('d', 't', { limit: 0 }, MYSQL).limit, 50, 'limit 0 → predefinito, mai zero righe');
assert.strictEqual(componiSelezione('d', 't', { limit: -5 }, MYSQL).limit, 1, 'limit negativo → almeno 1');
assert.strictEqual(componiSelezione('d', 't', { limit: 99999 }, MYSQL).limit, 500, 'Oltre il tetto → resultCap');
assert.strictEqual(
  componiSelezione('d', 't', { limit: 99999, maxRows: 5000 }, MYSQL).limit, 5000,
  'maxRows (campo riservato al server) alza il tetto'
);
assert.strictEqual(componiSelezione('d', 't', { skip: -3 }, MYSQL).skip, 0, 'Salto negativo → 0, mai un OFFSET invalido');
assert.strictEqual(componiSelezione('d', 't', { filter: '   ' }, MYSQL).whereSql, '', 'Filtro di soli spazi: nessun WHERE');
console.log('  OK   componiSelezione: qualificazione, filtro, tetti su limite e salto');

/* 5. Un'implementazione sola per i due motori --------------------------------- */

const my = tabellare(MYSQL);
const pg = tabellare(PG);
const riga = { id: 3, nome: 'x' };

assert.deepStrictEqual(
  my.makeId(riga, ['id'], ['id', 'nome']), pg.makeId(riga, ['id'], ['id', 'nome']),
  'L\'_id non dipende dal motore: stesso oggetto sui due'
);
assert.deepStrictEqual(
  my.buildSelect('d', 't', { limit: 7, skip: 2 }).limit, pg.buildSelect('d', 't', { limit: 7, skip: 2 }).limit,
  'Limite e salto non dipendono dal motore'
);
assert.strictEqual(my.buildOrderBy('{"a":1}'), ' ORDER BY `a` ASC');
assert.strictEqual(pg.buildOrderBy('{"a":1}'), ' ORDER BY "a" ASC');
assert.strictEqual(my.parseRowId('{"id":3}').sql, '`id` <=> ?');
assert.strictEqual(pg.parseRowId('{"id":3}').sql, '"id" = $1');
assert.throws(() => tabellare({ qid: MYSQL.qid }), /Dialetto SQL incompleto/, 'Un dialetto monco è un errore subito');
console.log('  OK   tabellare: stesse decisioni, dialetti diversi');

/* 6. Gli adattatori chiamano DAVVERO questo modulo ---------------------------- */

// Senza questo controllo l'estrazione potrebbe restare un modulo nuovo accanto
// a due copie ancora vive: il test passerebbe e nulla sarebbe cambiato.
const DbFactory = require('../db/DbFactory');
for (const tipo of ['mysql', 'postgresql']) {
  const s = DbFactory.getStrategy(tipo);
  const virgolette = tipo === 'mysql' ? '`a`' : '"a"';
  assert.strictEqual(s.buildOrderBy('{"a":1}'), ` ORDER BY ${virgolette} ASC`, `${tipo}: ordinamento dal modulo comune`);
  assert.deepStrictEqual(s.makeId({ id: 1, b: 2 }, ['id'], ['id', 'b']), { id: 1 }, `${tipo}: _id dal modulo comune`);
  assert.strictEqual(s.buildSelect('d', 't', { limit: -5 }).limit, 1, `${tipo}: limite normalizzato dal modulo comune`);
  assert.throws(() => s.parseRowId('[1]'), /Identificatore di riga non valido/, `${tipo}: rifiuto dal modulo comune`);
}

// Il controllo qui sopra è di comportamento, e due copie identiche si
// comportano identicamente: da solo passerebbe anche con le copie ancora al
// loro posto. Serve quindi anche un controllo sul TESTO degli adattatori — la
// stessa scelta di test/unit-scritture-bersaglio.js — perché il difetto da
// evitare (due implementazioni che divergono) non è osservabile finché non è
// già successo.
const fs = require('fs');
const path = require('path');
for (const file of ['MySqlStrategy.js', 'PostgreSqlStrategy.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', file), 'utf8');
  assert.ok(
    /require\('\.\/sqlTabellare'\)/.test(src),
    `${file} deve prendere il tabellare dal modulo comune`
  );
  assert.ok(
    !src.includes('Ordinamento non valido'),
    `${file} contiene ancora una copia di buildOrderBy: il messaggio d'errore vive in un posto solo`
  );
  assert.ok(
    !src.includes('Identificatore di riga non valido'),
    `${file} contiene ancora una copia di parseRowId`
  );
  assert.ok(
    !src.includes('return { table, whereSql, orderSql, limit, skip };'),
    `${file} contiene ancora una copia di buildSelect`
  );
  // Stesso difetto, altra famiglia: le quattro funzioni che traducono fra EJSON
  // e parametri SQL erano anch'esse copie identiche. La prima stesura di questo
  // modulo ne aveva aggiunta una TERZA, cioè aveva allargato il difetto che
  // stava chiudendo: da qui la sorveglianza esplicita.
  for (const nome of ['toSqlValue', 'parseClientValue', 'deserializeClientObject', 'serializeRow']) {
    assert.ok(
      !src.includes(`function ${nome}(`),
      `${file} ridichiara ${nome}: la conversione EJSON<->SQL vive in db/sqlValori.js`
    );
  }
  assert.ok(
    /require\('\.\/sqlValori'\)/.test(src),
    `${file} deve prendere la conversione dei valori dal modulo comune`
  );
}
console.log('  OK   MySqlStrategy e PostgreSqlStrategy usano il modulo comune');

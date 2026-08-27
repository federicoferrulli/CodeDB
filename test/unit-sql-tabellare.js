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
const { tabellare } = require('../db/sqlTabellare');
const { toSqlValue } = require('../db/sqlValori');

// Dialetti finti, gli stessi dei due adattatori ridotti all'osso: qui interessa
// che il tabellare CHIAMI il dialetto, non come il dialetto sia fatto.
const MYSQL = {
  qid: (n) => '`' + String(n).replace(/`/g, '``') + '`',
  qtable: (db, t) => `${MYSQL.qid(db)}.${MYSQL.qid(t)}`,
  whereFromId: (id) => {
    const cols = Object.keys(id);
    if (!cols.length) throw new Error('Identificatore di riga mancante.');
    return { sql: cols.map((c) => `${MYSQL.qid(c)} <=> ?`).join(' AND '), params: cols.map((c) => toSqlValue(id[c])) };
  },
};
const PG = {
  qid: (n) => '"' + String(n).replace(/"/g, '""') + '"',
  qtable: (db, t) => `${PG.qid(db || 'public')}.${PG.qid(t)}`,
  whereFromId: (id) => {
    const cols = Object.keys(id);
    if (!cols.length) throw new Error('Identificatore di riga mancante.');
    let i = 1;
    return { sql: cols.map((c) => `${PG.qid(c)} = $${i++}`).join(' AND '), params: cols.map((c) => toSqlValue(id[c])) };
  },
};

// I due dialetti LEGATI: è l'unica porta del modulo, ed è la stessa che usano
// gli adattatori. Prima questo test importava anche le quattro funzioni crude e
// passava loro il `qid` a mano — cioè poteva chiedere l'ordinamento di MySQL
// con le regole di PostgreSQL, un accoppiamento che in produzione non esiste.
// Provare da una porta che la produzione non ha significa provare un'altra cosa.
const my = tabellare(MYSQL);
const pg = tabellare(PG);

console.log('  --- Tabellare comune SQL (db/sqlTabellare.js) ---');

/* 1. Identificatore di riga -------------------------------------------------- */

assert.deepStrictEqual(
  my.makeId({ id: 7, nome: 'a', extra: true }, ['id'], ['id', 'nome', 'extra']),
  { id: 7 },
  'Con chiave primaria l\'_id contiene SOLO le sue colonne'
);
assert.deepStrictEqual(
  my.makeId({ id: 7, nome: 'a' }, [], ['id', 'nome']),
  { id: 7, nome: 'a' },
  'Senza chiave primaria si ripiega sull\'intera riga'
);
assert.deepStrictEqual(
  my.makeId({ ordine_id: 1, riga: 2, q: 5 }, ['ordine_id', 'riga'], ['ordine_id', 'riga', 'q']),
  { ordine_id: 1, riga: 2 },
  'Chiave composta: tutte le componenti, nell\'ordine dichiarato'
);
// Un valore NULL nella chiave deve restare nell'_id: toglierlo cambierebbe la
// riga identificata (il WHERE avrebbe una condizione in meno).
assert.deepStrictEqual(
  my.makeId({ a: null, b: 1 }, ['a', 'b'], ['a', 'b']),
  { a: null, b: 1 },
  'I NULL della chiave restano nell\'_id'
);
console.log('  OK   makeId: chiave primaria, ripiego, chiave composta, NULL');

/* 2. Lettura dell'identificatore --------------------------------------------- */

const letto = my.parseRowId(JSON.stringify({ id: 7 }));
assert.strictEqual(letto.sql, '`id` <=> ?', 'La lettura passa dal dialetto per il WHERE');
assert.deepStrictEqual(letto.params, [7], 'I valori diventano parametri, mai testo interpolato');

for (const cattivo of ['"stringa"', '[1,2]', 'null', '42']) {
  assert.throws(
    () => my.parseRowId(cattivo),
    /Identificatore di riga non valido/,
    `Deve rifiutare ${cattivo}: non è un oggetto { colonna: valore }`
  );
}
assert.throws(
  () => my.parseRowId('{}'),
  /Identificatore di riga mancante/,
  'Un oggetto vuoto non identifica nulla: WHERE assente = tutte le righe'
);
// Extended JSON: una data deve arrivare al driver come Date, non come la
// stringa "$date". Si guarda il PARAMETRO, che è ciò che il driver riceve.
const conData = my.parseRowId(JSON.stringify({ quando: { $date: '2020-01-02T03:04:05.000Z' } }));
assert.ok(conData.params[0] instanceof Date, 'I valori arrivano in EJSON e tornano tipi nativi');
console.log('  OK   parseRowId: WHERE parametrizzato, rifiuti, EJSON');

/* 3. Ordinamento -------------------------------------------------------------- */

assert.strictEqual(my.buildOrderBy(''), '', 'Ordinamento vuoto: nessuna clausola');
assert.strictEqual(my.buildOrderBy('   '), '', 'Solo spazi: nessuna clausola');
assert.strictEqual(my.buildOrderBy(null), '', 'Assente: nessuna clausola');
assert.strictEqual(my.buildOrderBy('name ASC'), ' ORDER BY name ASC', 'SQL libero passa invariato');
assert.strictEqual(
  my.buildOrderBy('{"name":1}'), ' ORDER BY `name` ASC',
  'JSON: colonna quotata col backtick su MySQL'
);
assert.strictEqual(
  pg.buildOrderBy('{"name":1}'), ' ORDER BY "name" ASC',
  'JSON: colonna quotata con le virgolette su PostgreSQL'
);
assert.strictEqual(
  pg.buildOrderBy('{"a":1,"b":-1}'), ' ORDER BY "a" ASC, "b" DESC',
  'Più colonne, direzione dal segno'
);
assert.strictEqual(my.buildOrderBy('{}'), '', 'JSON vuoto: nessuna clausola, non " ORDER BY "');
assert.throws(
  () => my.buildOrderBy('{non json'),
  /Ordinamento non valido/,
  'Un JSON rotto è un errore parlante, non una sintassi SQL invalida spedita al server'
);
console.log('  OK   buildOrderBy: SQL libero, JSON, dialetto, JSON rotto');

/* 4. Pezzi della SELECT ------------------------------------------------------- */

const sel = my.buildSelect('shop', 'orders', { filter: 'q > 1', sort: '{"id":-1}', limit: 20, skip: 40 });
assert.strictEqual(sel.table, '`shop`.`orders`', 'Tabella sempre qualificata dal dialetto');
assert.strictEqual(sel.whereSql, ' WHERE q > 1', 'Il filtro arriva come frammento WHERE grezzo');
assert.strictEqual(sel.orderSql, ' ORDER BY `id` DESC', 'L\'ordinamento passa dalla stessa funzione');
assert.strictEqual(sel.limit, 20);
assert.strictEqual(sel.skip, 40);

const vuoto = pg.buildSelect('public', 'orders', {});
assert.strictEqual(vuoto.whereSql, '', 'Senza filtro nessun WHERE');
assert.strictEqual(vuoto.orderSql, '', 'Senza sort nessun ORDER BY');
assert.strictEqual(vuoto.limit, 50, 'Limite predefinito 50 (una pagina di griglia)');
assert.strictEqual(vuoto.skip, 0);

assert.strictEqual(my.buildSelect('d', 't', { limit: 0 }).limit, 50, 'limit 0 → predefinito, mai zero righe');
assert.strictEqual(my.buildSelect('d', 't', { limit: -5 }).limit, 1, 'limit negativo → almeno 1');
assert.strictEqual(my.buildSelect('d', 't', { limit: 99999 }).limit, 500, 'Oltre il tetto → resultCap');
assert.strictEqual(
  my.buildSelect('d', 't', { limit: 99999, maxRows: 5000 }).limit, 5000,
  'maxRows (campo riservato al server) alza il tetto'
);
assert.strictEqual(my.buildSelect('d', 't', { skip: -3 }).skip, 0, 'Salto negativo → 0, mai un OFFSET invalido');
assert.strictEqual(my.buildSelect('d', 't', { filter: '   ' }).whereSql, '', 'Filtro di soli spazi: nessun WHERE');
console.log('  OK   buildSelect: qualificazione, filtro, tetti su limite e salto');

// La ricerca globale entra dalla porta della strategia e parte dopo gli
// eventuali parametri del filtro strutturato. Su PostgreSQL sbagliare questo
// numero legherebbe il testo cercato al segnaposto della condizione precedente.
{
  const pgConParametri = tabellare({
    ...PG,
    segnaposto: (n) => `$${n}`,
    testoDi: (col) => `${col}::text`,
  });
  let posizioneVista = null;
  const globale = pgConParametri.buildSelect('public', 'orders', {
    filtro: { condizioni: [{ campo: 'stato', operatore: 'uguale', valore: 'aperto' }] },
    cercaOvunque: { operatore: 'contieneOvunque', valore: 'membro' },
  }, {
    ricercaGlobale: (da) => {
      posizioneVista = da;
      return { sql: `LOWER("label"::text) LIKE LOWER($${da})`, params: ['%membro%'] };
    },
  });
  assert.strictEqual(posizioneVista, 2, 'la ricerca globale segue il parametro del filtro strutturato');
  assert.deepStrictEqual(globale.whereParams, ['aperto', '%membro%']);
  assert.ok(globale.whereSql.includes(' AND '), 'condizione e ricerca globale valgono insieme');
}
console.log('  OK   buildSelect: ricerca globale parametrizzata dopo la condizione');

/* 5. Un'implementazione sola per i due motori --------------------------------- */

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
assert.deepStrictEqual(
  Object.keys(require('../db/sqlTabellare')), ['tabellare'],
  'Il modulo espone una porta SOLA: le funzioni crude accettavano qualunque '
  + 'regola di quotatura, e comporre l\'ordinamento di MySQL con le regole di '
  + 'PostgreSQL dava ORDER BY "nome" ASC senza che nulla protestasse'
);
console.log('  OK   tabellare: stesse decisioni, dialetti diversi');

/* 6. Gli adattatori chiamano DAVVERO questo modulo ---------------------------- */

// Senza questo controllo l'estrazione potrebbe restare un modulo nuovo accanto
// a due copie ancora vive: il test passerebbe e nulla sarebbe cambiato.
const DbFactory = require('../db/DbFactory');
for (const tipo of ['mysql', 'postgresql']) {
  const s = DbFactory.getStrategy(tipo);
  const virgolette = tipo === 'mysql' ? '`a`' : '"a"';
  // Su una colonna di cui non si conosce la nullabilita' PostgreSQL scrive il
  // suffisso che allinea i nulli alla regola di CodeDB (il nullo e' il piu'
  // piccolo); MySQL non scrive niente perche' il suo predefinito gia' coincide.
  // Il suffisso e' provato per esteso in test/unit-ordinamento-strategia.js.
  const nulli = tipo === 'mysql' ? '' : ' NULLS FIRST';
  assert.strictEqual(
    s.buildOrderBy('{"a":1}'), ` ORDER BY ${virgolette} ASC${nulli}`,
    `${tipo}: ordinamento dal modulo comune`
  );
  assert.deepStrictEqual(s.makeId({ id: 1, b: 2 }, ['id'], ['id', 'b']), { id: 1 }, `${tipo}: _id dal modulo comune`);
  assert.strictEqual(s.buildSelect('d', 't', { limit: -5 }).limit, 1, `${tipo}: limite normalizzato dal modulo comune`);
  assert.throws(() => s.parseRowId('[1]'), /Identificatore di riga non valido/, `${tipo}: rifiuto dal modulo comune`);
}

/* ---------------------------------------------------------------------------
 * IL GUARDIANO STRUTTURALE — che cos'è, e che cosa NON è.
 *
 * Il controllo qui sopra è di comportamento, e due copie identiche si
 * comportano identicamente: da solo passerebbe anche con le copie ancora al
 * loro posto. Il difetto da evitare — due implementazioni che divergono — non è
 * osservabile finché non è già successo. Serve quindi un controllo sul TESTO
 * degli adattatori, come in test/unit-scritture-bersaglio.js.
 *
 * QUESTO È UN RILEVATORE DI FUMO, NON UN ANALIZZATORE.
 *
 * Confronta il sorgente con frammenti presi ALLA LETTERA, e questo ha due lati.
 * Entrambi vanno detti, perché un test che sembra promettere più di quanto dà è
 * peggio di uno che non c'è:
 *
 *  1. **NON vede la copia riscritta.** Basta uno spazio diverso, l'ordine delle
 *     chiavi cambiato, una funzione anonima al posto di una dichiarazione, e la
 *     copia passa indisturbata. Se questo test è verde non è dimostrato che le
 *     copie non ci siano: è dimostrato che non ci sono NELLA FORMA CHE AVEVANO.
 *  2. **Può fallire su modifiche innocenti.** Chi rinomina legittimamente una
 *     variabile o riformula un messaggio d'errore lo fa diventare rosso senza
 *     che esista alcun difetto. Per questo il messaggio di fallimento (sotto)
 *     dice quale frammento è scattato e come distinguere i due casi: un test
 *     che fallisce a vuoto senza spiegarsi è un test che qualcuno cancella.
 *
 * PERCHÉ COMUNQUE COSÌ. Un matcher più permissivo aggancerebbe commenti e
 * funzioni soltanto somiglianti, e i suoi fallimenti diventerebbero rompicapi —
 * cioè peggiorerebbe proprio il lato 2. Un analizzatore sintattico sarebbe una
 * dipendenza nuova in un repo che non ha né build step né parser. Il valore qui
 * è nel costo: due righe che intercettano il ritorno più probabile della copia,
 * quello per copia-incolla.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

/**
 * Un frammento sorvegliato: il testo cercato, dove dovrebbe vivere invece, e
 * che cosa significa trovarlo.
 */
const SORVEGLIATI = [
  {
    frammento: 'Ordinamento non valido',
    cosa: 'il messaggio d\'errore di buildOrderBy',
    casa: 'db/sqlTabellare.js',
  },
  {
    frammento: 'Identificatore di riga non valido',
    cosa: 'il messaggio d\'errore di parseRowId',
    casa: 'db/sqlTabellare.js',
  },
  {
    frammento: 'return { table, whereSql, orderSql, limit, skip };',
    cosa: 'la riga finale di buildSelect',
    casa: 'db/sqlTabellare.js',
  },
  // Stesso difetto, altra famiglia: le quattro funzioni che traducono fra EJSON
  // e parametri SQL erano anch'esse copie identiche. La prima stesura del
  // modulo tabellare ne aveva aggiunta una TERZA, cioè aveva allargato il
  // difetto che stava chiudendo: da qui la sorveglianza esplicita.
  ...['toSqlValue', 'parseClientValue', 'deserializeClientObject', 'serializeRow'].map((nome) => ({
    frammento: `function ${nome}(`,
    cosa: `la dichiarazione di ${nome}`,
    casa: 'db/sqlValori.js',
  })),
];

/**
 * Il messaggio che legge chi trova il test rosso. Deve rispondere in dieci
 * secondi alla sola domanda che conta: «ho davanti un difetto o un
 * rinominamento?».
 */
function spiegazione(file, voce) {
  return [
    `${file}: trovato ${voce.cosa}, che dovrebbe vivere solo in ${voce.casa}.`,
    `  Frammento cercato (alla lettera): ${JSON.stringify(voce.frammento)}`,
    '',
    '  DUE CASI, e si distinguono guardando il file:',
    `  1. DIFETTO — nell'adattatore è ricomparsa una copia di ciò che sta in`,
    `     ${voce.casa}. Va tolta: la correzione di una copia non raggiunge l'altra,`,
    "     e nulla lo segnala finché i due motori non si comportano diversamente.",
    '  2. FALSO ALLARME — quel testo è ricomparso per un altro motivo (un',
    '     messaggio riformulato, un nome riusato in un contesto diverso). Allora',
    "     va aggiornata la voce in SORVEGLIATI qui sopra, non cancellato il test.",
    '',
    '  Questo controllo è un rilevatore di FUMO: cerca frammenti letterali, e una',
    '  copia riscritta con altre parole gli sfugge. Vedi la nota in testa.',
  ].join('\n');
}

for (const file of ['MySqlStrategy.js', 'PostgreSqlStrategy.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', file), 'utf8');

  // Che l'adattatore IMPORTI i moduli comuni: è il controllo con il valore più
  // alto, perché non ha falsi allarmi — o l'import c'è o non c'è.
  for (const [modulo, cosa] of [['sqlTabellare', 'il tabellare'], ['sqlValori', 'la conversione dei valori']]) {
    assert.ok(
      new RegExp(`require\\('\\./${modulo}'\\)`).test(src),
      `${file} deve prendere ${cosa} dal modulo comune (db/${modulo}.js)`
    );
  }

  for (const voce of SORVEGLIATI) {
    assert.ok(!src.includes(voce.frammento), spiegazione(file, voce));
  }
}
console.log('  OK   MySqlStrategy e PostgreSqlStrategy usano il modulo comune');

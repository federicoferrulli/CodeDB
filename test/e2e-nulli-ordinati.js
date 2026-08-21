'use strict';

/* ---------------------------------------------------------------------------
 * I valori nulli si ordinano allo stesso modo sui TRE motori, contro server
 * veri.
 *
 * `test/unit-ordinamento-strategia.js` prova che la SQL composta sia quella
 * giusta. Quello che un pool finto non può provare è il fatto che conta: che i
 * tre motori, ricevuto lo stesso ordinamento della griglia, restituiscano le
 * righe nello **stesso ordine** — nulli compresi.
 *
 * LA REGOLA DI CODEDB: il valore nullo è il più piccolo. In salita in cima, in
 * discesa in fondo.
 *
 * Perché serve un server vero, motore per motore:
 *
 *  - **MySQL** non riceve alcun suffisso, perché il suo comportamento
 *    predefinito già coincide con la regola. Che coincida va PROVATO, non
 *    assunto: senza questa verifica la regola su MySQL si regge su una
 *    coincidenza che nessuno sorveglia, e una versione futura che la cambiasse
 *    non farebbe fallire niente.
 *  - **PostgreSQL** riceve `NULLS FIRST`/`NULLS LAST`, ed è l'unico che cambia.
 *  - **MongoDB** deve collocare un campo **assente** dove colloca un campo
 *    nullo: sono due assenze diverse per il database e una sola per chi guarda
 *    la griglia.
 *
 * E il piano di esecuzione: su una colonna NOT NULL con indice il suffisso
 * viene omesso, e PostgreSQL deve continuare a usare l'indice. Si legge il
 * piano, non si deduce — perché il planner NON riconosce da solo che un
 * `NULLS FIRST` su una colonna NOT NULL è un'operazione nulla, ed è proprio la
 * trappola che l'omissione evita.
 *
 * Uso:  node test/e2e-nulli-ordinati.js
 * Motori non raggiungibili vengono SALTATI con un messaggio esplicito: il test
 * non finge di aver provato ciò che non ha provato.
 *   MongoDB:    MONGO_HOST (127.0.0.1), MONGO_PORT (27017)
 *   MySQL:      MYSQL_PORT (3306), MYSQL_PASSWORD ('')
 *   PostgreSQL: PG_HOST (127.0.0.1), PG_PORT (5432), PG_USER (postgres),
 *               PG_PASSWORD (''), PG_DATABASE (postgres)
 * ------------------------------------------------------------------------- */

const { io } = require('socket.io-client');
const { startTestServer } = require('./e2e-harness');

const DB = 'codedb_e2e_nulli';
const COLL = 'persone';

const MONGO_HOST = process.env.MONGO_HOST || '127.0.0.1';
const MONGO_PORT = parseInt(process.env.MONGO_PORT, 10) || 27017;
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT, 10) || 3306;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '';
const PG_HOST = process.env.PG_HOST || '127.0.0.1';
const PG_PORT = parseInt(process.env.PG_PORT, 10) || 5432;
const PG_USER = process.env.PG_USER || 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD || '';
const PG_DATABASE = process.env.PG_DATABASE || 'postgres';

let socket = null;
let testServer = null;
const saltati = [];
/** Ordine osservato per motore: è ciò che alla fine viene confrontato. */
const osservato = {};

function emit(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function assert(cond, label, dettaglio = '') {
  if (cond) console.log(`  OK   ${label}`);
  else {
    console.error(`  FAIL ${label}${dettaglio ? `\n       ${dettaglio}` : ''}`);
    process.exitCode = 1;
  }
}

function salta(motore, motivo) {
  saltati.push(motore);
  console.log(`  SALTATO ${motore}: ${motivo}`);
}

function sql(db, query) {
  return emit('collection:aggregate', { db, coll: null, pipeline: query });
}

/**
 * L'ordine dei nomi come lo vede la griglia, con i vuoti resi visibili.
 * Un campo assente e uno nullo diventano lo stesso segno: è precisamente la
 * pretesa da verificare su MongoDB.
 */
function ordineDi(docs) {
  return (docs || []).map((d) => (d.nome === null || d.nome === undefined ? '∅' : String(d.nome)));
}

/** Legge la pagina della griglia con l'ordinamento STRUTTURATO (clic sull'intestazione). */
async function leggiOrdinata(db, coll, direzione) {
  const res = await emit('collection:find', {
    db, coll, sort: JSON.stringify({ nome: direzione }), limit: 50, skip: 0,
  });
  if (!res.ok) throw new Error(res.error);
  return ordineDi(res.docs);
}

async function provaMotore(nome, connessione, prepara, pulisci) {
  console.log(`\n--- ${nome} ---`);
  const conn = await emit('mongo:connect', connessione);
  if (!conn.ok) return salta(nome, conn.error || 'connessione non riuscita');
  try {
    const pronto = await prepara();
    if (pronto !== true) return salta(nome, pronto);

    const asc = await leggiOrdinata(DB, COLL, 1);
    const desc = await leggiOrdinata(DB, COLL, -1);
    osservato[nome] = { asc, desc };

    assert(asc[0] === '∅', `${nome} ASC: i vuoti in cima`, `ordine: ${asc.join(' ')}`);
    assert(desc[desc.length - 1] === '∅', `${nome} DESC: i vuoti in fondo`, `ordine: ${desc.join(' ')}`);
    // I non nulli devono restare ordinati fra loro: la regola sposta i vuoti,
    // non mescola il resto.
    const pieniAsc = asc.filter((v) => v !== '∅');
    assert(
      JSON.stringify(pieniAsc) === JSON.stringify([...pieniAsc].sort()),
      `${nome} ASC: i valori pieni restano in ordine`, `ordine: ${asc.join(' ')}`
    );
  } finally {
    await pulisci().catch(() => {});
    await emit('mongo:disconnect', {});
  }
}

/* --- MySQL: nessun suffisso, il predefinito deve COINCIDERE --------------- */
async function provaMySql() {
  await provaMotore('MySQL',
    { dbType: 'mysql', host: '127.0.0.1', port: MYSQL_PORT, username: 'root', password: MYSQL_PASSWORD },
    async () => {
      await emit('db:drop', { db: DB });
      const creato = await emit('db:create', { db: DB, coll: '' });
      if (!creato.ok) return `db:create non riuscito (${creato.error})`;
      await sql(DB, `CREATE TABLE ${COLL} (id INT PRIMARY KEY, nome VARCHAR(50) NULL)`);
      await sql(DB, `INSERT INTO ${COLL} (id, nome) VALUES (1, 'bruno'), (2, NULL), (3, 'aldo')`);
      return true;
    },
    () => emit('db:drop', { db: DB }));
}

/* --- PostgreSQL: il suffisso, e il piano di esecuzione -------------------- */
async function provaPostgres() {
  await provaMotore('PostgreSQL',
    {
      dbType: 'postgresql', host: PG_HOST, port: PG_PORT,
      username: PG_USER, password: PG_PASSWORD, database: PG_DATABASE,
    },
    async () => {
      await emit('db:drop', { db: DB });
      const creato = await emit('db:create', { db: DB, coll: '' });
      if (!creato.ok) return `db:create non riuscito (${creato.error})`;
      await sql(DB, `CREATE TABLE ${COLL} (id INT PRIMARY KEY, nome VARCHAR(50) NULL)`);
      await sql(DB, `INSERT INTO ${COLL} (id, nome) VALUES (1, 'bruno'), (2, NULL), (3, 'aldo')`);
      return true;
    },
    () => emit('db:drop', { db: DB }));

  if (saltati.includes('PostgreSQL')) return;

  // Il piano di esecuzione: LETTO, non dedotto.
  console.log('\n--- PostgreSQL: il piano di esecuzione ---');
  const conn = await emit('mongo:connect', {
    dbType: 'postgresql', host: PG_HOST, port: PG_PORT,
    username: PG_USER, password: PG_PASSWORD, database: PG_DATABASE,
  });
  if (!conn.ok) return salta('PostgreSQL (piano)', conn.error || 'connessione non riuscita');
  try {
    await emit('db:drop', { db: DB });
    await emit('db:create', { db: DB, coll: '' });
    // `id` è NOT NULL e indicizzato dalla chiave primaria: su questa colonna il
    // suffisso viene OMESSO da CodeDB, ed è dove si recupera il costo.
    await sql(DB, `CREATE TABLE ${COLL} (id INT PRIMARY KEY, nome VARCHAR(50) NULL)`);
    const valori = [];
    for (let i = 1; i <= 5000; i++) valori.push(`(${i}, 'n${i}')`);
    await sql(DB, `INSERT INTO ${COLL} (id, nome) VALUES ${valori.join(',')}`);
    await sql(DB, 'ANALYZE');

    const piano = await emit('collection:explain', {
      db: DB, coll: COLL, mode: 'find', sort: JSON.stringify({ id: 1 }), limit: 50,
    });
    const testo = JSON.stringify(piano.plan || piano.rows || piano);
    assert(piano.ok, 'il piano di esecuzione è stato letto', piano.error || '');
    assert(
      piano.ok && /Index Scan|Index Only Scan/i.test(testo),
      'su una colonna NOT NULL l\'indice resta utilizzabile (nessun suffisso)',
      testo.slice(0, 400)
    );
    // E la conferma che il suffisso NON compare nella query spiegata.
    assert(
      piano.ok && !/NULLS/i.test(String(piano.query || '')),
      'la query di una colonna NOT NULL non porta il suffisso',
      String(piano.query || '')
    );
  } finally {
    await emit('db:drop', { db: DB });
    await emit('mongo:disconnect', {});
  }
}

/* --- MongoDB: un campo ASSENTE va dove va un campo nullo ------------------ */
async function provaMongo() {
  await provaMotore('MongoDB',
    { dbType: 'mongodb', host: MONGO_HOST, port: MONGO_PORT },
    async () => {
      await emit('db:drop', { db: DB });
      const creato = await emit('db:create', { db: DB, coll: COLL });
      if (!creato.ok) return `db:create non riuscito (${creato.error})`;
      // Tre forme di riga: valore, NULL esplicito, campo ASSENTE.
      for (const doc of [{ id: 1, nome: 'bruno' }, { id: 2, nome: null }, { id: 3, nome: 'aldo' }, { id: 4 }]) {
        const r = await emit('doc:insert', { db: DB, coll: COLL, doc: JSON.stringify(doc) });
        if (!r.ok) return `inserimento non riuscito (${r.error})`;
      }
      return true;
    },
    () => emit('db:drop', { db: DB }));

  if (saltati.includes('MongoDB')) return;
  const { asc, desc } = osservato.MongoDB;
  // Due vuoti in cima in salita (il nullo e l'assente), due in fondo in discesa.
  assert(asc[0] === '∅' && asc[1] === '∅',
    'MongoDB: il campo ASSENTE sta dove sta il campo nullo (in salita)', asc.join(' '));
  assert(desc[desc.length - 1] === '∅' && desc[desc.length - 2] === '∅',
    'MongoDB: il campo ASSENTE sta dove sta il campo nullo (in discesa)', desc.join(' '));
}

/* --- Il confronto fra i motori: è il punto di tutto il test --------------- */
function confronta() {
  console.log('\n--- Confronto fra i motori ---');
  const motori = Object.keys(osservato);
  if (motori.length < 2) {
    console.log(`  IMPOSSIBILE: motori disponibili ${motori.length}, ne servono almeno 2.`);
    return;
  }
  // Si confronta la FORMA dell'ordine, non i valori: MongoDB ha una riga in più
  // (il campo assente), quindi si guarda dove stanno i vuoti e in che ordine
  // stanno i pieni.
  const forma = (o) => ({
    vuotiInCima: o.asc.filter((v) => v === '∅').length && o.asc[0] === '∅',
    vuotiInFondo: o.desc.filter((v) => v === '∅').length && o.desc[o.desc.length - 1] === '∅',
    pieniAsc: o.asc.filter((v) => v !== '∅').join(','),
    pieniDesc: o.desc.filter((v) => v !== '∅').join(','),
  });
  const riferimento = forma(osservato[motori[0]]);
  for (const m of motori.slice(1)) {
    const f = forma(osservato[m]);
    assert(
      JSON.stringify(f) === JSON.stringify(riferimento),
      `${m} ordina come ${motori[0]}`,
      `${motori[0]}: ${JSON.stringify(riferimento)}\n       ${m}: ${JSON.stringify(f)}`
    );
  }
  for (const m of motori) {
    console.log(`  ${m.padEnd(12)} ASC: ${osservato[m].asc.join(' ')}   DESC: ${osservato[m].desc.join(' ')}`);
  }
}

(async () => {
  console.log('--- I valori nulli si ordinano allo stesso modo sui tre motori ---');
  testServer = await startTestServer({ port: parseInt(process.env.E2E_PORT, 10) || 3153 });
  socket = io(testServer.url);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  try {
    await provaMongo();
    await provaMySql();
    await provaPostgres();
    confronta();
  } finally {
    socket.close();
    await testServer.stop();
  }

  if (saltati.length) {
    console.log(`\n${saltati.length} motore/i saltato/i (${saltati.join(', ')}): la prova NON copre quel percorso.`);
  }
  // Con meno di due motori non c'è nessun confronto possibile, e dichiararlo
  // "superato" sarebbe la bugia peggiore — è quella che ci si porta dietro.
  if (Object.keys(osservato).length < 2) {
    console.log('\nNESSUN CONFRONTO ESEGUITO: l\'allineamento fra i motori NON risulta verificato.');
    process.exitCode = 1;
  } else {
    console.log(process.exitCode ? '\nALCUNI TEST FALLITI' : '\nTUTTI I TEST ESEGUITI SUPERATI');
  }
})().catch(async (err) => {
  console.error('Errore imprevisto:', (err && err.stack) || err);
  process.exitCode = 1;
  if (socket) socket.close();
  if (testServer) await testServer.stop();
});

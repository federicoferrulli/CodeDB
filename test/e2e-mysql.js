'use strict';

// Test end-to-end della strategia MySQL: esercita l'intero flusso socket
// contro un MySQL locale (root, password vuota).
// Uso: node test/e2e-mysql.js            (MySQL su localhost:3306)
//      MYSQL_PORT=3307 node test/e2e-mysql.js
// Richiede il server della GUI già avviato su :3030.

const { io } = require('socket.io-client');
const { startTestServer } = require('./e2e-harness');

// Il test avvia una PROPRIA istanza di CodeDB su una porta dedicata, con un
// connections.ini temporaneo (test/e2e-harness.js): nessuna dipendenza dal
// server dell'utente e nessun rischio per il suo vault.
let socket = null;
let testServer = null;
const MYSQL_PORT = process.env.MYSQL_PORT || 3306;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '';
const DB = 'gui_mysql_e2e';
const DB2 = 'gui_mysql_e2e_ren';
const TABLE = 'people';

function emit(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    process.exitCode = 1;
  }
}

// Esegue una query SQL libera nel database indicato (modalità "SQL Raw").
function sql(db, query) {
  return emit('collection:aggregate', { db, coll: null, pipeline: query });
}

(async () => {
  testServer = await startTestServer({ port: parseInt(process.env.E2E_PORT, 10) || 3144 });
  socket = io(testServer.url);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  await runTests();
})().catch(async (err) => {
  console.error('Impossibile avviare i test:', (err && err.message) || err);
  process.exitCode = 1;
  if (socket) socket.close();
  if (testServer) await testServer.stop();
});

async function runTests() {
  try {
    console.log('1. mongo:connect (dbType = mysql)');
    const conn = await emit('mongo:connect', {
      dbType: 'mysql', host: 'localhost', port: MYSQL_PORT, username: 'root', password: MYSQL_PASSWORD,
    });
    assert(conn.ok && conn.dbType === 'mysql',
      `connessione riuscita (${conn.ok ? conn.databases.length + ' schema, dbType=' + conn.dbType : conn.error})`);
    if (!conn.ok) return socket.close();

    // Pulizia da eventuali esecuzioni precedenti fallite.
    await emit('db:drop', { db: DB });
    await emit('db:drop', { db: DB2 });

    console.log('2. db:create + SQL Raw (CREATE TABLE)');
    const created = await emit('db:create', { db: DB, coll: '' });
    assert(created.ok, `database "${DB}" creato`);
    const dup = await emit('db:create', { db: DB, coll: '' });
    assert(!dup.ok, 'creazione di un db già esistente rifiutata');
    const ddl = await sql(DB,
      `CREATE TABLE ${TABLE} (
         id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         name VARCHAR(50) NOT NULL,
         age INT,
         city VARCHAR(50),
         born DATETIME,
         f1 VARCHAR(20),
         f2 VARCHAR(20),
         label VARCHAR(50),
         meta JSON
       )`);
    assert(ddl.ok, `tabella "${TABLE}" creata via SQL Raw`);

    console.log('3. doc:insert (righe come JSON)');
    const ins1 = await emit('doc:insert', { db: DB, coll: TABLE, doc: '{ "name": "Ada", "age": 36, "city": "Torino" }' });
    const ins2 = await emit('doc:insert', {
      db: DB, coll: TABLE,
      doc: '{ "name": "Bruno", "age": 41, "city": "Bari", "born": { "$date": "1984-05-09T10:30:00.000Z" }, "label": "Responsabile", "meta": { "gruppi": [{ "label": "Membro" }] } }',
    });
    assert(ins1.ok && ins2.ok, `due righe inserite (insertId = ${ins1.ok ? ins1.insertedId : ins1.error}, ${ins2.ok ? ins2.insertedId : ins2.error})`);

    console.log('4. db:collections');
    const colls = await emit('db:collections', { db: DB });
    assert(colls.ok && colls.collections.some((c) => c.name === TABLE), `tabella "${TABLE}" presente`);

    console.log('5. collection:find con WHERE e ordinamento');
    const find = await emit('collection:find', {
      db: DB, coll: TABLE,
      filter: 'age > 30',
      sort: '{ "age": -1 }', // JSON come dal click sull'intestazione di colonna
      limit: 50, skip: 0,
    });
    assert(find.ok && find.total === 2, `total = ${find.ok ? find.total : find.error}`);
    assert(find.ok && find.docs[0].name === 'Bruno', 'ordinamento decrescente per age');
    assert(find.ok && find.docs[0]._id && typeof find.docs[0]._id.id === 'number',
      `_id virtuale dalla chiave primaria (${find.ok ? JSON.stringify(find.docs[0]._id) : ''})`);
    assert(find.ok && find.columns[0] === 'id' && find.columns.includes('born'), 'colonne nell\'ordine della tabella');
    assert(find.ok && find.docs[0].born && typeof find.docs[0].born.$date === 'string',
      'DATETIME serializzato come { "$date": ... }');

    const sorted = await emit('collection:find', { db: DB, coll: TABLE, filter: '', sort: 'name ASC' });
    assert(sorted.ok && sorted.docs[0].name === 'Ada', 'ordinamento SQL libero (name ASC)');

    const globaleLabel = await emit('collection:find', {
      db: DB, coll: TABLE,
      cercaOvunque: { operatore: 'contieneOvunque', valore: 'RESPONSABILE' },
      limit: 50, skip: 0,
    });
    assert(globaleLabel.ok && globaleLabel.docs.length === 1 && globaleLabel.docs[0].name === 'Bruno',
      `ricerca globale oltre le prime sei colonne (${globaleLabel.ok ? globaleLabel.docs.length : globaleLabel.error})`);
    const globaleJson = await emit('collection:find', {
      db: DB, coll: TABLE,
      cercaOvunque: { operatore: 'contieneOvunque', valore: 'mEmBrO' },
      limit: 50, skip: 0,
    });
    assert(globaleJson.ok && globaleJson.docs.length === 1 && globaleJson.docs[0].name === 'Bruno',
      `ricerca globale nei valori JSON annidati (${globaleJson.ok ? globaleJson.docs.length : globaleJson.error})`);

    console.log('6. doc:update (UPDATE via chiave primaria)');
    const id = JSON.stringify(find.docs[0]._id);
    const upd = await emit('doc:update', {
      db: DB, coll: TABLE, id,
      set: { age: 42, city: 'Roma', born: { $date: '1984-05-09T10:30:00.000Z' } },
    });
    assert(upd.ok && upd.matched === 1, 'riga aggiornata');
    const check = await emit('collection:find', { db: DB, coll: TABLE, filter: "name = 'Bruno'" });
    assert(check.ok && check.docs[0].age === 42 && check.docs[0].city === 'Roma', 'modifica persistita');
    assert(check.ok && check.docs[0].born &&
      new Date(check.docs[0].born.$date).getTime() === Date.parse('1984-05-09T10:30:00.000Z'),
      'data EJSON round-trip senza shift di fuso');

    console.log('7. SQL Raw (SELECT aggregato)');
    const agg = await sql(DB, `SELECT SUM(age) AS totale FROM ${TABLE}`);
    assert(agg.ok && Number(agg.docs[0].totale) === 78, `aggregazione SQL: totale = ${agg.ok ? agg.docs[0].totale : agg.error}`);

    console.log('8. WHERE con errore di sintassi');
    const bad = await emit('collection:find', { db: DB, coll: TABLE, filter: 'non na senso ===' });
    assert(!bad.ok && bad.error, 'errore riportato correttamente');

    console.log('9. doc:replace (riga intera)');
    const rep = await emit('doc:replace', {
      db: DB, coll: TABLE, id,
      doc: '{ "name": "Bruno", "age": 50, "city": "Milano", "born": null }',
    });
    assert(rep.ok && rep.matched === 1, 'riga sostituita');
    const repCheck = await emit('collection:find', { db: DB, coll: TABLE, filter: "name = 'Bruno'" });
    assert(repCheck.ok && repCheck.docs[0].age === 50 && repCheck.docs[0].born === null,
      'replace persistito (born = NULL)');

    console.log('10. collection:stats');
    const stats = await emit('collection:stats', { db: DB, coll: TABLE });
    assert(stats.ok && stats.indexes.some((i) => i.name === 'PRIMARY' && i.unique), 'indice PRIMARY presente');
    assert(stats.ok && stats.fields.some((f) => f.name === 'name' && f.types[0].startsWith('varchar')),
      'schema: colonna "name" varchar');

    console.log('10-bis. doc:duplicate (duplicazione di una riga)');
    // Duplicare una riga NON e' copiarla: la chiave primaria collide sempre, le
    // colonne uniche collidono spesso e quelle calcolate non si possono nemmeno
    // nominare in un INSERT. Qui si prova che a queste tre cose pensa il server.
    const DUP = 'dup_test';
    const ddlDup = await sql(DB,
      `CREATE TABLE ${DUP} (
         id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         email VARCHAR(120) NOT NULL UNIQUE,
         codice VARCHAR(10) NULL UNIQUE,
         nome VARCHAR(50) NOT NULL,
         nome_upper VARCHAR(50) AS (UPPER(nome)) STORED
       )`);
    assert(ddlDup.ok, `tabella "${DUP}" creata (PK auto, due uniche, una calcolata)`);
    await emit('doc:insert', { db: DB, coll: DUP, doc: '{ "email": "ada@x.it", "codice": "A1", "nome": "Ada" }' });
    const origine = await emit('collection:find', { db: DB, coll: DUP, filter: '', sort: 'id ASC' });
    const riga = origine.ok && origine.docs[0];

    // Senza chiavi: la primaria la genera il DBMS, le uniche vengono svuotate
    // (NULL se la colonna lo permette, altrimenti un valore nuovo).
    const dupSenza = await emit('doc:duplicate', {
      db: DB, coll: DUP, doc: JSON.stringify(riga), conChiavi: false,
    });
    assert(dupSenza.ok, `duplicato senza chiavi inserito (${dupSenza.ok ? dupSenza.insertedId : dupSenza.error})`);
    const dopoSenza = await emit('collection:find', { db: DB, coll: DUP, filter: '', sort: 'id ASC' });
    const copia = dopoSenza.ok && dopoSenza.docs[1];
    assert(copia && copia.id !== riga.id, `chiave primaria nuova (${riga && riga.id} -> ${copia && copia.id})`);
    assert(copia && copia.nome === 'Ada', 'i dati veri sono quelli della riga sorgente');
    assert(copia && copia.email !== riga.email, `email unica ricalcolata (${copia && copia.email})`);
    assert(copia && copia.codice === null, 'colonna unica annullabile azzerata');
    assert(copia && copia.nome_upper === 'ADA', 'colonna calcolata rifatta dal database, non copiata');

    // Con chiavi: resta tutto tranne la primaria. Su questa tabella l'email
    // unica viene conservata, quindi l'inserimento DEVE fallire - ed e' la
    // risposta giusta, non un difetto: e' quello che "con chiavi" significa.
    const dupCon = await emit('doc:duplicate', {
      db: DB, coll: DUP, doc: JSON.stringify(riga), conChiavi: true,
    });
    assert(!dupCon.ok && /duplicat/i.test(dupCon.error || ''),
      `con chiavi su una unica collidente: errore parlante (${dupCon.ok ? 'inserito!' : dupCon.error})`);

    // Con chiavi su una tabella la cui sola chiave e' la primaria: passa, e la
    // riga nuova e' identica tranne l'id.
    const persona = await emit('collection:find', { db: DB, coll: TABLE, filter: "name = 'Bruno'" });
    const dupPersona = await emit('doc:duplicate', {
      db: DB, coll: TABLE, doc: JSON.stringify(persona.docs[0]), conChiavi: true,
    });
    assert(dupPersona.ok, `riga duplicata con chiavi (${dupPersona.ok ? 'ok' : dupPersona.error})`);
    const bruni = await emit('collection:find', { db: DB, coll: TABLE, filter: "name = 'Bruno'", sort: 'id ASC' });
    assert(bruni.ok && bruni.docs.length === 2 && bruni.docs[0].id !== bruni.docs[1].id,
      `due Bruno con id diversi (${bruni.ok ? bruni.docs.map((d) => d.id).join(', ') : bruni.error})`);
    assert(bruni.ok && bruni.docs[1].city === bruni.docs[0].city, 'gli altri campi sono copiati');
    // Ripulisce: le sezioni successive contano le righe di "people".
    await sql(DB, `DELETE FROM ${TABLE} WHERE id = ${bruni.docs[1].id}`);

    // Chiave primaria composta senza AUTO_INCREMENT: si rifa' solo l'ultima
    // componente, cosi' il duplicato resta dentro lo stesso ordine.
    const ddlComposta = await sql(DB,
      `CREATE TABLE dup_composta (
         ordine_id INT NOT NULL,
         riga INT NOT NULL,
         qta INT NOT NULL,
         PRIMARY KEY (ordine_id, riga)
       )`);
    assert(ddlComposta.ok, 'tabella con chiave primaria composta creata');
    await emit('doc:insert', { db: DB, coll: 'dup_composta', doc: '{ "ordine_id": 3, "riga": 1, "qta": 5 }' });
    const compOrig = await emit('collection:find', { db: DB, coll: 'dup_composta', filter: '' });
    const dupComp = await emit('doc:duplicate', {
      db: DB, coll: 'dup_composta', doc: JSON.stringify(compOrig.docs[0]), conChiavi: true,
    });
    assert(dupComp.ok, `chiave composta duplicata (${dupComp.ok ? 'ok' : dupComp.error})`);
    const compDopo = await emit('collection:find', { db: DB, coll: 'dup_composta', filter: '', sort: 'riga ASC' });
    assert(compDopo.ok && compDopo.docs.length === 2
      && compDopo.docs[1].ordine_id === 3 && compDopo.docs[1].riga === 2,
      `stessa ordine_id, riga nuova (${compDopo.ok ? JSON.stringify(compDopo.docs[1]) : compDopo.error})`);

    // Anteprima: calcola e NON scrive - e' la modalita' "Duplica e modifica".
    const primaDiAnteprima = await emit('collection:find', { db: DB, coll: DUP, filter: '' });
    const anteprima = await emit('doc:duplicate', {
      db: DB, coll: DUP, doc: JSON.stringify(riga), conChiavi: false, soloAnteprima: true,
    });
    const dopoAnteprima = await emit('collection:find', { db: DB, coll: DUP, filter: '' });
    assert(anteprima.ok && anteprima.doc && !('id' in JSON.parse(anteprima.doc)),
      'anteprima senza chiave primaria');
    assert(dopoAnteprima.ok && dopoAnteprima.docs.length === primaDiAnteprima.docs.length,
      'l\'anteprima non inserisce nulla');

    console.log('11. db:schema con foreign key (orders.people_id -> people)');
    const fk = await sql(DB,
      `CREATE TABLE orders (
         id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         people_id INT UNSIGNED,
         amount DECIMAL(10,2),
         FOREIGN KEY (people_id) REFERENCES ${TABLE}(id)
       )`);
    assert(fk.ok, 'tabella "orders" creata con FK');
    const schema = await emit('db:schema', { db: DB });
    assert(schema.ok && schema.collections.some((c) => c.name === 'orders'), 'schema contiene "orders"');
    assert(schema.ok && schema.relations.some((r) => r.from === 'orders' && r.field === 'people_id' && r.to === TABLE),
      'relazione orders.people_id -> people rilevata');

    console.log('11-bis. collection:relations + relation:rows (pannello 🔗 della griglia)');
    // Il pannello delle chiavi esterne NON passa da db:schema: quello descrive
    // tutto il database ed è troppo caro da chiedere a ogni apertura di tabella.
    const rel = await emit('collection:relations', { db: DB, coll: 'orders' });
    assert(rel.ok && rel.relazioni.length === 1, `una sola FK uscente da "orders" (${rel.ok ? rel.relazioni.length : rel.error})`);
    const fkDesc = rel.ok && rel.relazioni[0];
    assert(fkDesc && fkDesc.campo === 'people_id' && fkDesc.tabella === TABLE && fkDesc.colonna === 'id',
      `descrittore completo: ${JSON.stringify(fkDesc)}`);
    assert(fkDesc && fkDesc.origine === 'vincolo',
      'un vincolo dichiarato non deve essere presentato come ipotesi');
    assert(fkDesc && fkDesc.db === DB, 'lo schema riferito è esplicito (una FK può attraversare i database)');
    // La tabella di partenza non ha FK uscenti: l'assenza è una risposta valida,
    // non un errore (altrimenti la griglia mostrerebbe un avviso su ogni tabella).
    const relPeople = await emit('collection:relations', { db: DB, coll: TABLE });
    assert(relPeople.ok && relPeople.relazioni.length === 0, 'nessuna FK uscente da "people"');

    // Riga riferita: è la domanda "chi è il cliente 42".
    const bruno = await emit('collection:find', { db: DB, coll: TABLE, filter: "name = 'Bruno'" });
    const brunoId = bruno.docs[0].id;
    // Il pannello 🔗 non ha più un evento proprio: chiede `collection:find` con
    // un filtro STRUTTURATO, che è la stessa via della griglia (ticket 22-24).
    const conFiltro = (condizioni, limit = 50) =>
      emit('collection:find', { db: DB, coll: TABLE, filtro: { condizioni }, limit, skip: 0 });

    const rigaRif = await conFiltro([{ campo: 'id', operatore: 'uguale', valore: brunoId }], 1);
    assert(rigaRif.ok && rigaRif.docs.length === 1 && rigaRif.docs[0].name === 'Bruno',
      `riga riferita risolta (${rigaRif.ok ? JSON.stringify(rigaRif.docs[0] && rigaRif.docs[0].name) : rigaRif.error})`);

    // Un valore che non corrisponde a nulla deve dare zero righe, non un errore:
    // scoprire che il riferimento è rotto è proprio uno degli usi del pannello.
    const orfano = await conFiltro([{ campo: 'id', operatore: 'uguale', valore: 999999 }], 1);
    assert(orfano.ok && orfano.docs.length === 0, 'riferimento inesistente = zero righe, non errore');

    // Ricerca per il selettore: la stessa del filtro rapido, su tutte le colonne.
    const cerca = await conFiltro([{ campo: 'name', operatore: 'contiene', valore: 'Bru' }]);
    assert(cerca.ok && cerca.docs.length === 1 && cerca.docs[0].name === 'Bruno',
      `ricerca testuale (${cerca.ok ? cerca.docs.length : cerca.error} righe)`);
    // I metacaratteri di LIKE vanno neutralizzati: chi cerca "%" cerca il
    // carattere, non "qualsiasi cosa".
    const jolly = await conFiltro([{ campo: 'name', operatore: 'contiene', valore: '%' }]);
    assert(jolly.ok && jolly.docs.length === 0, '"%" cercato come carattere, non come jolly');

    // Colonna inventata: l'errore arriva dal motore, e dice che non esiste.
    const finta = await conFiltro([{ campo: 'non_esiste', operatore: 'uguale', valore: 1 }]);
    assert(!finta.ok && /non esist|Unknown column/i.test(finta.error),
      `colonna inesistente rifiutata (${finta.error})`);

    // E il nome di campo che su MongoDB sarebbe un OPERATORE viene rifiutato
    // prima di toccare il database, su qualunque motore.
    const operatore = await conFiltro([{ campo: '$where', operatore: 'uguale', valore: 1 }]);
    assert(!operatore.ok && /nome di campo non valido/i.test(operatore.error),
      `un campo con prefisso $ è rifiutato (${operatore.error})`);

    console.log('12. doc:delete');
    const del = await emit('doc:delete', { db: DB, coll: TABLE, id });
    assert(del.ok && del.deleted === 1, 'riga eliminata');

    console.log('12b. collection:create con schema + gestione colonne e indici');
    const tcre = await emit('collection:create', {
      db: DB, name: 'gadgets',
      columns: [
        { name: 'id', type: 'INT UNSIGNED', nullable: false, autoIncrement: true, primaryKey: true },
        { name: 'sku', type: 'VARCHAR(40)', nullable: false },
        { name: 'price', type: 'DECIMAL(10,2)', nullable: true, default: '0' },
      ],
    });
    assert(tcre.ok, `tabella "gadgets" creata con schema${tcre.ok ? '' : ' (' + tcre.error + ')'}`);
    const gs1 = await emit('collection:stats', { db: DB, coll: 'gadgets' });
    assert(gs1.ok && gs1.fields.some((f) => f.name === 'sku' && !f.nullable), 'colonna "sku" NOT NULL presente');
    assert(gs1.ok && gs1.indexes.some((i) => i.name === 'PRIMARY' && i.unique), 'chiave primaria su "id"');
    assert(gs1.ok && gs1.fields.some((f) => f.name === 'id' && f.autoIncrement && f.key === 'PRI'),
      'colonna "id" marcata AUTO_INCREMENT e PRI (per il modulo di inserimento)');

    const cadd = await emit('column:add', { db: DB, coll: 'gadgets', column: { name: 'note', type: 'TEXT', nullable: true } });
    assert(cadd.ok, `colonna "note" aggiunta${cadd.ok ? '' : ' (' + cadd.error + ')'}`);
    const calt = await emit('column:alter', {
      db: DB, coll: 'gadgets', oldName: 'note',
      column: { name: 'descrizione', type: 'VARCHAR(200)', nullable: true },
    });
    assert(calt.ok, `colonna rinominata in "descrizione"${calt.ok ? '' : ' (' + calt.error + ')'}`);
    const gs2 = await emit('collection:stats', { db: DB, coll: 'gadgets' });
    assert(gs2.ok && gs2.fields.some((f) => f.name === 'descrizione' && f.types[0].startsWith('varchar')),
      'modifica riflessa nello schema');

    const gidx = await emit('index:create', { db: DB, coll: 'gadgets', fields: '{"sku": 1}', unique: true, name: 'sku_unique' });
    assert(gidx.ok && gidx.name === 'sku_unique', `indice unico creato (${gidx.ok ? gidx.name : gidx.error})`);
    const gs3 = await emit('collection:stats', { db: DB, coll: 'gadgets' });
    assert(gs3.ok && gs3.indexes.some((i) => i.name === 'sku_unique' && i.unique), 'indice presente e unico');
    const gdel = await emit('index:drop', { db: DB, coll: 'gadgets', name: 'sku_unique' });
    assert(gdel.ok, 'indice eliminato');

    const cdel = await emit('column:drop', { db: DB, coll: 'gadgets', name: 'descrizione' });
    assert(cdel.ok, 'colonna eliminata');
    const tren = await emit('collection:rename', { db: DB, coll: 'gadgets', newName: 'widgets' });
    assert(tren.ok, `tabella rinominata in "widgets"${tren.ok ? '' : ' (' + tren.error + ')'}`);
    const tlist = await emit('db:collections', { db: DB });
    assert(tlist.ok && tlist.collections.some((c) => c.name === 'widgets') && !tlist.collections.some((c) => c.name === 'gadgets'),
      'rinomina riflessa nell\'elenco');
    const tdrop = await emit('collection:drop', { db: DB, coll: 'widgets' });
    assert(tdrop.ok, 'tabella eliminata');

    console.log('13. collection:watch non disponibile su MySQL');
    const watch = await emit('collection:watch', { db: DB, coll: TABLE });
    assert(!watch.ok, 'watch rifiutato (nessun change stream)');

    console.log('14. db:rename / db:drop');
    const ren = await emit('db:rename', { db: DB, newName: DB2 });
    assert(!ren.ok && /non supporta una rinomina atomica/i.test(ren.error || ''),
      'rinomina database non atomica rifiutata senza spostare o eliminare tabelle');
    const renCheck = await emit('collection:find', { db: DB, coll: TABLE, filter: '' });
    assert(renCheck.ok && renCheck.total === 1, 'database originale intatto dopo la rinomina rifiutata');
    const dbs = await emit('db:list', {});
    assert(dbs.ok && dbs.databases.some((d) => d.name === DB)
      && !dbs.databases.some((d) => d.name === DB2), 'nessun database parziale creato dalla rinomina');
    const sysDrop = await emit('db:drop', { db: 'mysql' });
    assert(!sysDrop.ok, 'eliminazione di uno schema di sistema rifiutata');
    const drop = await emit('db:drop', { db: DB });
    assert(drop.ok, `database "${DB2}" eliminato`);

    console.log('15. mongo:disconnect');
    const disc = await emit('mongo:disconnect', {});
    assert(disc.ok, 'disconnessione pulita');

    console.log(process.exitCode ? '\nALCUNI TEST FALLITI' : '\nTUTTI I TEST SUPERATI');
  } catch (err) {
    console.error('Errore imprevisto:', err);
    process.exitCode = 1;
  } finally {
    socket.close();
    await testServer.stop();
  }
}

'use strict';

/* ---------------------------------------------------------------------------
 * Lo schema progressivo: i tre cursori, la revisione e lo snapshot.
 *
 * Il difetto che questi test sorvegliano non è un errore, è un SILENZIO. Prima
 * `fieldLimit` e `relationLimit` tagliavano, `complete: false` lo dichiarava, e
 * non esisteva alcuna continuazione: le colonne oltre il tetto erano
 * irraggiungibili da questa via, ma la risposta aveva l'aria di essere a posto.
 * E la paginazione rileggeva l'intero catalogo a ogni pagina — su MongoDB
 * ricampionando ogni collection, quindi due pagine dello stesso schema potevano
 * osservare campi diversi.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { limitaSchema, revisioneSchema } = require('../db/schemaProgressivo');
const { schemaPaginato, invalidaSnapshot } = require('../db/schemaSnapshot');
const { makePrincipal } = require('../auth/principal');

console.log('--- Test budget schema progressivo ---');

/* --- 1. Retro-compatibilità: il contratto di prima non cambia ------------- */
const grande = {
  collections: Array.from({ length: 500 }, (_, i) => ({
    name: `tabella_${String(i).padStart(3, '0')}`,
    fields: Array.from({ length: 100 }, (_, j) => ({ name: `campo_${j}`, types: ['varchar'] })),
  })),
  relations: Array.from({ length: 499 }, (_, i) => ({ from: `tabella_${String(i + 1).padStart(3, '0')}`, to: `tabella_${String(i).padStart(3, '0')}`, field: 'parent_id' })),
};
const first = limitaSchema(grande, { collectionLimit: 50, fieldLimit: 10, relationLimit: 60 });
assert.strictEqual(first.collections.length, 50);
assert(first.collections.every((collection) => collection.fields.length <= 10));
assert(first.relations.length <= 60);
assert.strictEqual(first.schemaPage.totals.collections, 500);
assert.strictEqual(first.schemaPage.complete, false);
assert.strictEqual(first.schemaPage.nextCursor, 50);
assert(Buffer.byteLength(JSON.stringify(first)) < 200000, 'il primo payload deve restare entro il budget');
const next = limitaSchema(grande, { cursor: first.schemaPage.nextCursor, collectionLimit: 50, fieldLimit: 10 });
assert.strictEqual(next.collections[0].name, 'tabella_050', 'la continuazione non deve ripetere la prima pagina');

const piccolo = limitaSchema({ collections: [{ name: 'a', fields: [{ name: 'id' }] }], relations: [] });
assert.strictEqual(piccolo.schemaPage.complete, true);
assert.deepStrictEqual(piccolo.collections[0].fields, [{ name: 'id' }]);
console.log('  OK   payload iniziale limitato, metadati, continuazione e schema piccolo completo');

/* --- 2. I CAMPI hanno un cursore proprio, e si arriva in fondo ------------ */
{
  const schema = {
    collections: [{ name: 'larga', fields: Array.from({ length: 260 }, (_, i) => ({ name: `c${i}` })) }],
    relations: [],
  };
  const visti = [];
  let pagina = limitaSchema(schema, { fieldLimit: 100 });
  let giri = 0;
  for (;;) {
    visti.push(...pagina.collections[0].fields.map((f) => f.name));
    const prossimo = pagina.schemaPage.cursori.campi.larga;
    if (prossimo == null) break;
    assert.ok(++giri < 10, 'la paginazione dei campi deve terminare');
    pagina = limitaSchema(schema, { fieldLimit: 100, fieldCursors: { larga: prossimo } });
  }
  assert.strictEqual(visti.length, 260, 'seguendo il cursore dei campi si arriva a TUTTE le colonne');
  assert.deepStrictEqual(visti.slice(0, 3), ['c0', 'c1', 'c2']);
  assert.strictEqual(new Set(visti).size, 260, 'e nessuna colonna arriva due volte');
  assert.strictEqual(pagina.schemaPage.fine.campi, true, 'l’ultima pagina dichiara la fine dei campi');
  console.log('  OK   cursore dei campi: si raggiungono tutte le colonne, una volta ciascuna');
}

/* --- 3. Le RELAZIONI hanno un cursore proprio ----------------------------- */
{
  const schema = {
    collections: [{ name: 'a', fields: [{ name: 'id' }] }],
    relations: Array.from({ length: 250 }, (_, i) => ({ from: 'a', to: `b${i}`, field: `f${i}` })),
  };
  const viste = [];
  let pagina = limitaSchema(schema, { relationLimit: 100 });
  for (let giro = 0; giro < 10; giro++) {
    viste.push(...pagina.relations.map((r) => r.field));
    const prossimo = pagina.schemaPage.cursori.relazioni;
    if (prossimo == null) break;
    pagina = limitaSchema(schema, { relationLimit: 100, relationCursor: prossimo });
  }
  assert.strictEqual(viste.length, 250, 'seguendo il cursore delle relazioni si arriva a tutte');
  assert.strictEqual(new Set(viste).size, 250, 'e nessuna arriva due volte');
  assert.strictEqual(pagina.schemaPage.fine.relazioni, true);
  console.log('  OK   cursore delle relazioni: indipendente da quello del catalogo');
}

/* --- 3-bis. Il Grafo 3D pagina il CATALOGO e deve ricevere le sue relazioni */
// Il consumatore storico avanza nel catalogo con «Carica la porzione
// successiva» (graph3d.js). Prima dei tre cursori le relazioni erano filtrate
// sulla fetta corrente, quindi paginare il catalogo se le portava dietro; con
// un cursore indipendente, chi manda solo `cursor` riceve a ogni pagina la
// stessa prima fetta di relazioni — e quelle delle tabelle successive non
// arrivano MAI. Il difetto non si vede dalle pagine, che sono tutte valide:
// si vede solo drenando e contando ciò che è arrivato almeno una volta.
{
  const schema = {
    collections: Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, fields: [{ name: 'id' }] })),
    relations: Array.from({ length: 6 }, (_, i) => ({ from: `t${i}`, to: `t${(i + 1) % 6}`, field: `f${i}` })),
  };
  const budget = { collectionLimit: 2, fieldLimit: 10, relationLimit: 2 };
  const viste = new Set();
  let pagina = limitaSchema(schema, { ...budget });
  for (let giro = 0; giro < 10; giro++) {
    for (const r of pagina.relations) viste.add(r.field);
    const cursori = pagina.schemaPage.cursori;
    if (cursori.collezioni == null && cursori.relazioni == null) break;
    pagina = limitaSchema(schema, {
      ...budget,
      cursor: cursori.collezioni || 0,
      relationCursor: cursori.relazioni || 0,
      revisione: pagina.schemaPage.revisione,
    });
  }
  assert.strictEqual(viste.size, 6,
    'paginando il catalogo si raggiungono TUTTE le relazioni, comprese quelle delle tabelle oltre la prima pagina');
  console.log('  OK   paginare il catalogo non lascia indietro le relazioni delle pagine successive');
}

/* --- 4. I tre cursori sono INDIPENDENTI ----------------------------------- */
{
  const schema = {
    collections: [
      { name: 'a', fields: Array.from({ length: 5 }, (_, i) => ({ name: `a${i}` })) },
      { name: 'b', fields: Array.from({ length: 5 }, (_, i) => ({ name: `b${i}` })) },
    ],
    relations: [{ from: 'a', to: 'b', field: 'b_id' }],
  };
  // Avanzare nei CAMPI di `a` non deve far avanzare il catalogo.
  const p = limitaSchema(schema, { collectionLimit: 10, fieldLimit: 2, fieldCursors: { a: 2 } });
  assert.deepStrictEqual(p.collections.map((c) => c.name), ['a', 'b'], 'il catalogo resta dov’era');
  assert.deepStrictEqual(p.collections[0].fields.map((f) => f.name), ['a2', 'a3']);
  assert.deepStrictEqual(p.collections[1].fields.map((f) => f.name), ['b0', 'b1'],
    'il cursore dei campi di una tabella non sposta quello di un’altra');
  assert.strictEqual(p.schemaPage.fine.relazioni, true, 'le relazioni erano poche: finite');
  assert.strictEqual(p.schemaPage.fine.campi, false, 'i campi no, e lo dice');
  console.log('  OK   i tre cursori non si spostano a vicenda');
}

/* --- 5. La revisione invalida i cursori di un catalogo cambiato ----------- */
{
  const prima = { collections: [{ name: 'a', fields: [{ name: 'x' }] }], relations: [] };
  const dopo = {
    collections: [{ name: 'a', fields: [{ name: 'x' }] }, { name: 'nuova', fields: [{ name: 'y' }] }],
    relations: [],
  };
  const rev = revisioneSchema(prima);
  assert.notStrictEqual(rev, revisioneSchema(dopo), 'una tabella in più cambia la revisione');
  assert.strictEqual(rev, revisioneSchema(JSON.parse(JSON.stringify(prima))),
    'la revisione dipende dalla FORMA, non dall’identità dell’oggetto');

  const pagina = limitaSchema(dopo, { revisione: rev, cursor: 1, collectionLimit: 1 });
  assert.strictEqual(pagina.schemaPage.revisioneCambiata, true, 'il cambio viene DICHIARATO');
  assert.strictEqual(pagina.collections[0].name, 'a',
    'e i cursori ripartono da capo invece di indicare righe che non sono più quelle');

  const stessa = limitaSchema(prima, { revisione: rev });
  assert.strictEqual(stessa.schemaPage.revisioneCambiata, false);
  console.log('  OK   revisione: un catalogo cambiato non fonde due mezze letture');
}

/* --- 6. Il campionamento viaggia con lo schema ---------------------------- */
{
  const campionato = {
    collections: [{ name: 'c', fields: [{ name: 'x' }] }],
    relations: [],
    campionamento: { documenti: 50, collezioni: 1, quando: '2026-09-16T10:00:00.000Z' },
  };
  const p = limitaSchema(campionato, {});
  assert.deepStrictEqual(p.schemaPage.campionamento, campionato.campionamento,
    'chi mostra campi OSSERVATI deve poter dire su quanti documenti');
  assert.strictEqual(limitaSchema({ collections: [], relations: [] }, {}).schemaPage.campionamento, null,
    'su uno schema DICHIARATO (SQL) non si inventa un campione');
  console.log('  OK   il campionamento è dichiarato, e non si inventa dove non c’è');
}

/* --- 7. Drenaggio completo su scala piano: 250 tabelle, 250 colonne, 1100 relazioni --- */
async function drenaggioCompleto() {
  // Lo scenario della tabella «Verifica richiesta»: una tabella oltre le 200
  // colonne e oltre mille relazioni complessive. Il giro segue i cursori come
  // fa il client (`completaSchema` + `unisciSchema`): catalogo, relazioni e
  // campi avanzano insieme sulla pagina FUSA, con la revisione rimandata
  // indietro a ogni richiesta. Seguire i cursori dell'ultima risposta invece
  // della fusa perdeva le colonne oltre il tetto in silenzio: è il difetto che
  // questa prova sorveglia.
  const M = await import('../public/js/uml-modello.js');
  const nomi = Array.from({ length: 250 }, (_, i) => `tabella_${String(i).padStart(3, '0')}`);
  const schema = {
    collections: nomi.map((name, i) => ({
      name,
      fields: Array.from({ length: i === 0 ? 250 : 5 }, (_, j) => ({ name: `c${j}`, types: ['int'] })),
    })),
    relations: Array.from({ length: 1100 }, (_, i) => ({
      from: nomi[i % 250],
      field: `f${i}`,
      to: nomi[(i + 1) % 250],
      toField: 'id',
      constraint: `fk_${i}`,
      ordine: 1,
      origine: 'vincolo',
    })),
  };
  const BUDGET = { collectionLimit: 80, fieldLimit: 60, relationLimit: 200 };
  let fuso = null;
  let giri = 0;
  for (;;) {
    assert.ok(++giri <= 30, 'il drenaggio deve terminare, non girare «carica altri» all’infinito');
    const page = fuso ? fuso.schemaPage : null;
    if (page && page.complete) break;
    const pagina = limitaSchema(schema, {
      ...BUDGET,
      ...(page ? {
        revisione: page.revisione,
        cursor: page.cursori.collezioni || 0,
        relationCursor: page.cursori.relazioni || 0,
        fieldCursors: page.cursori.campi,
      } : {}),
    });
    fuso = fuso ? M.unisciSchema(fuso, pagina) : pagina;
  }
  assert.strictEqual(fuso.collections.length, 250, 'ogni tabella si raggiunge');
  const larga = fuso.collections.find((c) => c.name === 'tabella_000');
  assert.strictEqual(larga.fields.length, 250, 'la tabella larga arriva a tutte le colonne');
  assert.strictEqual(new Set(larga.fields.map((f) => f.name)).size, 250, 'e nessuna colonna arriva due volte');
  assert.strictEqual(fuso.relations.length, 1100, 'ogni relazione si raggiunge, una volta sola');
  assert.strictEqual(fuso.schemaPage.complete, true, 'l’ultima pagina dichiara la fine');
  console.log(`  OK   drenaggio completo: 250 tabelle, 250 colonne, 1100 relazioni in ${giri} pagine`);
}

/* --- 8. Lo snapshot: la seconda pagina non rilegge il catalogo ------------- */
module.exports = (async () => {
  await drenaggioCompleto();
  const schema = {
    collections: Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, fields: [{ name: 'id' }] })),
    relations: [],
  };
  let letture = 0;
  const strategia = { dbSchema: async () => { letture++; return JSON.parse(JSON.stringify(schema)); } };
  // Il principal è quello VERO (`auth/principal.js`): con una forma inventata
  // il test qui sotto sull'impronta dei permessi non poteva fallire, perché
  // guardava campi che sul principal non esistono.
  const utente = { _id: 'u1', type: 'user', ownerId: 'o1', email: 'u1@esempio.it' };
  const scopeLargo = [{ connName: 'c1', capabilities: ['read'], scope: { databases: ['*'], collections: ['*'] } }];
  const sess = { principal: makePrincipal(utente, scopeLargo) };

  const p1 = await schemaPaginato(strategia, sess, { db: 'app', progressive: true, collectionLimit: 3 });
  assert.strictEqual(letture, 1);
  assert.strictEqual(p1.collections.length, 3);

  const p2 = await schemaPaginato(strategia, sess, {
    db: 'app', progressive: true, collectionLimit: 3, cursor: p1.schemaPage.nextCursor, revisione: p1.schemaPage.revisione,
  });
  assert.strictEqual(letture, 1, 'la seconda pagina NON rilegge il catalogo: è il senso dello snapshot');
  assert.strictEqual(p2.collections[0].name, 't3');
  assert.strictEqual(p2.schemaPage.revisioneCambiata, false, 'stesso snapshot, stessa revisione');
  assert.ok(p2.schemaPage.scadenza > Date.now(), 'la scadenza dello snapshot è dichiarata al chiamante');

  // `refresh` rilegge davvero: è ciò che fa «Rigenera».
  await schemaPaginato(strategia, sess, { db: 'app', progressive: true, refresh: true });
  assert.strictEqual(letture, 2, 'refresh deve rileggere');

  // Un altro database è un altro catalogo.
  await schemaPaginato(strategia, sess, { db: 'altro', progressive: true });
  assert.strictEqual(letture, 3, 'lo snapshot è di UN database');

  // Un'invalidazione esplicita (la DDL della giuntura) butta via lo snapshot.
  await schemaPaginato(strategia, sess, { db: 'altro', progressive: true });
  assert.strictEqual(letture, 3, 'senza invalidazione si riusa');
  invalidaSnapshot(sess);
  await schemaPaginato(strategia, sess, { db: 'altro', progressive: true });
  assert.strictEqual(letture, 4, 'dopo una DDL lo snapshot non vale più');

  // I PERMESSI fanno parte dell'impronta: sotto RBAC lo scope decide quali
  // oggetti esistono, e servire a un principal il catalogo filtrato per un
  // altro è una fuga di metadati, non una cache stantia.
  //
  // Il caso che conta è la REVOCA A CALDO, ed è quello che l'impronta sbagliava:
  // stesso utente, stesso id, stesse capability — cambia solo lo `scope` del
  // grant, cioè quali oggetti esistono per lui. Cambiare anche l'identità
  // renderebbe il test insensibile proprio alla cosa che deve sorvegliare.
  sess.principal = makePrincipal(utente, [
    { connName: 'c1', capabilities: ['read'], scope: { databases: ['solo_uno'], collections: ['pubblica'] } },
  ]);
  await schemaPaginato(strategia, sess, { db: 'altro', progressive: true });
  assert.strictEqual(letture, 5, 'una revoca che restringe lo scope non riusa lo snapshot di prima');

  // E la revoca dell'intero grant, che è l'altra forma della stessa cosa.
  await schemaPaginato(strategia, sess, { db: 'altro', progressive: true });
  assert.strictEqual(letture, 5, 'senza cambi si riusa');
  sess.principal = makePrincipal(utente, []);
  await schemaPaginato(strategia, sess, { db: 'altro', progressive: true });
  assert.strictEqual(letture, 6, 'un grant revocato del tutto non riusa lo snapshot');

  // La scadenza.
  sess.schemaSnapshot.scadenza = Date.now() - 1;
  await schemaPaginato(strategia, sess, { db: 'altro', progressive: true });
  assert.strictEqual(letture, 7, 'uno snapshot scaduto si rilegge');
  console.log('  OK   snapshot: riuso, refresh, database, invalidazione, principal, scadenza');
  console.log('--- Schema progressivo: tutti i test passati ---\n');
})();

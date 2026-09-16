'use strict';

/* ---------------------------------------------------------------------------
 * Lo schema progressivo: come un catalogo che non entra in una risposta viene
 * consegnato a pezzi, e come si dichiara che cosa manca ancora.
 *
 * PRIMA C'ERA UN CURSORE SOLO, ed era quello delle collection. Campi e
 * relazioni venivano semplicemente TAGLIATI: `fieldLimit` teneva i primi N
 * campi di ogni oggetto e `relationLimit` le prime N relazioni, e non esisteva
 * alcun modo di chiedere le successive. Il difetto non si vedeva perché
 * `complete: false` c'era: la risposta dichiarava onestamente di essere
 * parziale, e non offriva alcuna continuazione. Su una tabella con 260 colonne
 * le ultime 60 erano irraggiungibili da questa via, e su uno schema con più di
 * mille relazioni lo erano le relazioni in eccesso — cioè proprio le cose che
 * un diagramma deve poter disegnare per intero.
 *
 * Ora le tre risorse hanno TRE CURSORI INDIPENDENTI. Avanzare nel catalogo non
 * riazzera i campi già letti, e chiedere il resto delle colonne di una tabella
 * non costringe a riscaricare il catalogo.
 *
 * TRE COSE CHE NON SONO OVVIE:
 *
 * 1. LA REVISIONE È PARTE DEL CONTRATTO. Una paginazione su un catalogo che
 *    cambia sotto è una paginazione che salta o ripete oggetti senza dirlo: se
 *    fra due pagine qualcuno crea una tabella, il cursore 50 non indica più la
 *    stessa riga. La revisione è l'impronta del catalogo da cui la pagina è
 *    stata ritagliata; il chiamante la rimanda indietro e, se non coincide,
 *    riceve `revisioneCambiata: true` e pagina di nuovo da capo — invece di
 *    fondere due mezzi cataloghi diversi credendoli lo stesso.
 *
 * 2. «FINE» È PER RISORSA, non per la risposta. `complete` (che resta, e resta
 *    il significato di prima: tutto letto) non sa distinguere «mancano
 *    tabelle» da «manca una colonna di una tabella», e sono due cose che il
 *    chiamante deve poter chiedere separatamente.
 *
 * 3. IL CAMPIONAMENTO VIAGGIA CON LO SCHEMA. Su MongoDB i campi non sono
 *    dichiarati: sono OSSERVATI su un campione di documenti. Una risposta che
 *    non dice quanti documenti ha guardato fa sembrare un elenco campionato un
 *    elenco esaustivo, e un campo raro assente diventa indistinguibile da un
 *    campo che non esiste.
 * ------------------------------------------------------------------------- */

const crypto = require('crypto');

const DEFAULT_SCHEMA_BUDGET = Object.freeze({ collections: 80, fields: 40, relations: 200 });
const MAX_SCHEMA_BUDGET = Object.freeze({ collections: 200, fields: 200, relations: 1000 });

function intero(value, fallback, max) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

function cursore(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * Impronta del catalogo da cui una pagina è stata ritagliata.
 *
 * Non è un checksum del contenuto (due letture dello stesso database possono
 * differire su un conteggio stimato senza che nulla di strutturale sia
 * cambiato): è la FORMA — quali oggetti esistono, quante colonne ha ciascuno,
 * quante relazioni ci sono. È questo che rende valido o non valido un cursore.
 */
function revisioneSchema(schema) {
  const collections = Array.isArray(schema && schema.collections) ? schema.collections : [];
  const relations = Array.isArray(schema && schema.relations) ? schema.relations : [];
  const forma = collections
    .map((c) => `${c.name}:${(c.fields || []).length}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256')
    .update(`${forma}#${relations.length}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Ritaglia una pagina dello schema.
 *
 * @param {object} schema   catalogo completo (già filtrato dai permessi)
 * @param {object} richiesta payload del client
 * @param {object} extra     `{ scadenza }` dello snapshot, quando c'è
 */
function limitaSchema(schema, richiesta = {}, extra = {}) {
  const allCollections = Array.isArray(schema && schema.collections) ? schema.collections : [];
  const allRelations = Array.isArray(schema && schema.relations) ? schema.relations : [];
  const budget = {
    collections: intero(richiesta.collectionLimit, DEFAULT_SCHEMA_BUDGET.collections, MAX_SCHEMA_BUDGET.collections),
    fields: intero(richiesta.fieldLimit, DEFAULT_SCHEMA_BUDGET.fields, MAX_SCHEMA_BUDGET.fields),
    relations: intero(richiesta.relationLimit, DEFAULT_SCHEMA_BUDGET.relations, MAX_SCHEMA_BUDGET.relations),
  };
  const revisione = revisioneSchema(schema);
  // Il cursore vale su UNA revisione. Se il catalogo è cambiato, i cursori
  // ricevuti indicano righe che non sono più quelle: si riparte da capo e lo si
  // DICHIARA, invece di fondere due mezzi cataloghi diversi credendoli lo stesso.
  const revisioneCambiata = !!richiesta.revisione && richiesta.revisione !== revisione;
  const azzera = revisioneCambiata;

  const focus = String(richiesta.focus || '').trim();
  const curCollezioni = azzera ? 0 : cursore(richiesta.cursor);
  const curRelazioni = azzera ? 0 : cursore(richiesta.relationCursor);
  const curCampi = azzera || !richiesta.fieldCursors || typeof richiesta.fieldCursors !== 'object'
    ? {} : richiesta.fieldCursors;

  const neighbors = new Set(allRelations.flatMap((relation) => {
    if (relation.from === focus) return [relation.to];
    if (relation.to === focus) return [relation.from];
    return [];
  }));
  const ordered = focus
    ? [
      ...allCollections.filter((c) => c.name === focus),
      ...allCollections.filter((c) => c.name !== focus && neighbors.has(c.name)),
      ...allCollections.filter((c) => c.name !== focus && !neighbors.has(c.name)),
    ]
    : allCollections;

  const selected = ordered.slice(curCollezioni, curCollezioni + budget.collections).map((collection) => {
    const tutti = collection.fields || [];
    const da = Math.min(cursore(curCampi[collection.name]), tutti.length);
    const fette = tutti.slice(da, da + budget.fields);
    const fine = da + fette.length >= tutti.length;
    return {
      ...collection,
      fields: fette,
      fieldsPage: {
        total: tutti.length,
        cursor: da,
        // `nextCursor` è la continuazione di QUESTA risorsa: era l'informazione
        // che mancava del tutto, e senza la quale i campi oltre il tetto non
        // erano raggiungibili in alcun modo.
        nextCursor: fine ? null : da + fette.length,
        omitted: Math.max(0, tutti.length - (da + fette.length)),
        complete: fine,
      },
    };
  });

  // Le relazioni si paginano sul CATALOGO INTERO, non sulla fetta appena
  // letta. Un cursore nato su una fetta, applicato alla successiva, saltava in
  // silenzio le prime N relazioni della nuova fetta — e su uno schema oltre le
  // 200 tabelle erano proprio quelle il diagramma non disegnava mai. L'ordine
  // mette prima quelle che toccano il FOCUS (stabile da una pagina all'altra,
  // a differenza della fetta corrente) e poi le altre in ordine di schema:
  // chi apre da una tabella vede subito i suoi archi e i cursori restano validi.
  const punteggio = (relation) => (relation.from === focus || relation.to === focus ? 0 : 1);
  const ordinate = allRelations
    .map((relation, i) => [relation, i])
    .sort((a, b) => (punteggio(a[0]) - punteggio(b[0])) || (a[1] - b[1]))
    .map(([relation]) => relation);
  const relations = ordinate.slice(curRelazioni, curRelazioni + budget.relations);
  const fineRelazioni = curRelazioni + relations.length >= ordinate.length;
  const nextCursor = curCollezioni + selected.length < ordered.length ? curCollezioni + selected.length : null;

  const totalFields = allCollections.reduce((sum, collection) => sum + (collection.fields || []).length, 0);
  const returnedFields = selected.reduce((sum, collection) => sum + collection.fields.length, 0);
  const fineCampi = selected.every((collection) => collection.fieldsPage.complete);
  const complete = nextCursor == null && fineRelazioni && fineCampi;

  return {
    collections: selected,
    relations,
    schemaPage: {
      complete,
      cursor: curCollezioni,
      nextCursor,
      focus: focus || null,
      budget,
      revisione,
      revisioneCambiata,
      // Quando la pagina viene da uno snapshot, il chiamante deve poter sapere
      // fino a quando quei cursori restano validi senza doverlo indovinare.
      scadenza: extra.scadenza == null ? null : extra.scadenza,
      // I campi OSSERVATI (MongoDB) non sono campi dichiarati: chi li mostra
      // deve poter dire su quanti documenti sono stati visti e quando.
      campionamento: schema && schema.campionamento ? schema.campionamento : null,
      cursori: {
        collezioni: nextCursor,
        relazioni: fineRelazioni ? null : curRelazioni + relations.length,
        campi: Object.fromEntries(selected
          .filter((c) => c.fieldsPage.nextCursor != null)
          .map((c) => [c.name, c.fieldsPage.nextCursor])),
      },
      fine: {
        collezioni: nextCursor == null,
        relazioni: fineRelazioni,
        campi: fineCampi,
      },
      totals: { collections: allCollections.length, fields: totalFields, relations: allRelations.length },
      omitted: {
        collections: Math.max(0, allCollections.length - (curCollezioni + selected.length)),
        fields: Math.max(0, totalFields - returnedFields),
        relations: Math.max(0, allRelations.length - (curRelazioni + relations.length)),
      },
    },
  };
}

module.exports = { limitaSchema, revisioneSchema, DEFAULT_SCHEMA_BUDGET, MAX_SCHEMA_BUDGET };

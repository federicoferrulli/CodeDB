'use strict';

/* ---------------------------------------------------------------------------
 * Lo snapshot dei metadati: perché la seconda pagina non costi quanto la prima.
 *
 * `db:schema` leggeva l'INTERO catalogo a ogni richiesta e limitava dopo. La
 * paginazione riduceva quindi il payload e non il lavoro: chiedere la seconda
 * pagina di un catalogo costava esattamente quanto chiedere la prima. Su
 * MongoDB non era nemmeno solo costo — `dbSchema()` campiona 50 documenti per
 * collection, quindi ogni pagina RIFACEVA il campionamento di tutte le
 * collection, e due pagine dello stesso schema potevano osservare campi diversi
 * perché guardavano documenti diversi. Un cursore su un catalogo che cambia
 * sotto salta o ripete oggetti senza dirlo.
 *
 * Il piano (docs/piano-uml-interattivo.md, fase 2) ammette due strade: leggere
 * solo la porzione richiesta, oppure tenere uno snapshot con scadenza e
 * invalidazione. Questa è la seconda, ed è quella che si può avere senza
 * riscrivere `dbSchema()` in tre adattatori e senza moltiplicare le query di
 * catalogo (una per colonna, una per relazione) che il piano stesso chiede di
 * evitare.
 *
 * TRE PROPRIETÀ CHE, MANCANDO, FAREBBERO DI QUESTA CACHE UN DIFETTO:
 *
 * 1. LO SNAPSHOT È DELLA SESSIONE, non del processo. Vive su `sess`, che è già
 *    per socket, per tab e per connessione. Una cache globale per (database)
 *    servirebbe a un utente il catalogo filtrato per un altro: sotto RBAC lo
 *    scope decide QUALI oggetti esistono, e «esistono» è esattamente ciò che
 *    uno schema dichiara.
 *
 * 2. UN CAMBIO DI PRINCIPAL LO BUTTA VIA. La revoca a caldo aggiorna
 *    `sess.principal` (rivalidaPrincipal): lo snapshot porta con sé l'impronta
 *    dei permessi con cui è stato costruito, e se non coincide si rilegge.
 *    Senza, una revoca continuerebbe a mostrare i nomi già letti — che è una
 *    fuga di metadati, non una cache stantia.
 *
 * 3. HA UNA SCADENZA E UN'INVALIDAZIONE ESPLICITA. La scadenza (breve) copre i
 *    cambi fatti da altri; l'invalidazione copre quelli fatti da qui, ed è
 *    agganciata alla capability `ddl` nella giuntura dei dati, non a un elenco
 *    di nomi di evento da tenere allineato a mano.
 * ------------------------------------------------------------------------- */

const crypto = require('crypto');

const { limitaSchema, revisioneSchema } = require('./schemaProgressivo');

/** Quanto resta valido uno snapshot. Breve: è una finestra di paginazione. */
const TTL_MS = Math.max(1000, Number(process.env.CODEDB_SCHEMA_SNAPSHOT_TTL_MS) || 60000);

/**
 * Impronta dei permessi con cui lo snapshot è stato costruito. Due principal
 * con lo stesso scope vedono lo stesso catalogo; due scope diversi no.
 *
 * L'impronta si prende sul principal INTERO, non su un elenco di campi scelti
 * a mano. Elencarli era il difetto: la prima versione guardava `role` e
 * `scopes`, due nomi che sul principal non esistono affatto (`auth/principal.js`
 * costruisce `root`, `owner`, `connScope`, `capabilities`, `tenantCapabilities`
 * e `grants`), quindi la revoca RBAC normale — restringere lo `scope` di un
 * grant lasciando l'utente lo stesso — non cambiava l'impronta e lo snapshot
 * continuava a servire i nomi degli oggetti appena tolti fino alla scadenza.
 * Questa NON è una cache stantia: è una fuga di metadati, ed è esattamente ciò
 * che la proprietà 2 dell'intestazione dichiara di impedire.
 *
 * Il principal è piccolo, piatto e serializzabile (una sola via di costruzione,
 * `makePrincipal`), quindi prenderlo tutto costa quanto prenderne quattro
 * campi — e un campo di autorizzazione aggiunto domani è coperto senza che
 * nessuno debba ricordarsi di aggiungerlo qui. Un campo che NON riguarda i
 * permessi (un `displayName` cambiato) costa al massimo una rilettura del
 * catalogo: l'errore cade dalla parte sicura.
 */
function improntaPermessi(principal) {
  if (!principal) return 'nessuno';
  return crypto.createHash('sha256')
    .update(JSON.stringify(principal))
    .digest('hex')
    .slice(0, 24);
}

/** Butta via lo snapshot della sessione (una DDL, un logout, una disconnessione). */
function invalidaSnapshot(sess) {
  if (sess) sess.schemaSnapshot = null;
}

function valido(snapshot, db, impronta, ora) {
  return !!snapshot
    && snapshot.db === db
    && snapshot.impronta === impronta
    && snapshot.scadenza > ora;
}

/**
 * Restituisce una pagina di schema, leggendo il catalogo dal database solo
 * quando non c'è uno snapshot valido.
 *
 * `payload.refresh === true` forza la rilettura: è ciò che fa il pulsante
 * «Rigenera» della vista UML, e ciò che deve fare chiunque abbia appena
 * cambiato lo schema da un'altra strada.
 */
async function schemaPaginato(strategy, sess, payload = {}) {
  const db = payload.db;
  const ora = Date.now();
  const impronta = improntaPermessi(sess && sess.principal);
  let snapshot = sess ? sess.schemaSnapshot : null;

  if (payload.refresh === true || !valido(snapshot, db, impronta, ora)) {
    const schema = await strategy.dbSchema(db);
    snapshot = {
      db,
      impronta,
      schema,
      revisione: revisioneSchema(schema),
      creato: ora,
      scadenza: ora + TTL_MS,
    };
    if (sess) sess.schemaSnapshot = snapshot;
  }

  return limitaSchema(snapshot.schema, payload, { scadenza: snapshot.scadenza });
}

module.exports = { schemaPaginato, invalidaSnapshot, improntaPermessi, TTL_MS };

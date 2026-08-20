/**
 * CodeDB
 * Copyright (c) 2026 Federico Ferrulli
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */
'use strict';

/* ---------------------------------------------------------------------------
 * Il payload dell'esecuzione di una query: che cosa vi mette il client e che
 * cosa vi mette il server.
 *
 * `executeQueryCode` riceve un solo oggetto, ma le sue chiavi hanno DUE origini
 * diverse. Il codice, il motore, il database e la collezione li propone chi
 * manda la richiesta. Il riferimento di annullamento (`opHandle`) e il registro
 * dell'esecuzione (`run`) no: sono strutture VIVE del server — il primo è il
 * modo in cui `query:cancel` raggiunge la query in corso, il secondo è ciò su
 * cui le operazioni di scrittura lasciano il segno da cui `finalizzaScript`
 * ricava la categoria con cui l'operazione finisce nell'audit.
 *
 * Prima il gestore le sovrascriveva con `{ ...payload, runId, opHandle }`, cioè
 * per ACCIDENTE D'ORDINE: bastava spostare lo spread dopo le due chiavi perché
 * il riferimento di annullamento tornasse a essere quello del client. E `run`
 * non compariva affatto in quel letterale, quindi passava intatto: un client
 * poteva costruire il registro dell'esecuzione.
 *
 * Qui la rimozione è una REGOLA DICHIARATA e l'elenco dei campi del server sta
 * in un posto solo. La marcatura (`marca`) chiude il cerchio: un payload che non
 * è passato di qui viene rifiutato da `assertPayloadEsecuzione`, quindi
 * reintrodurre la composizione a mano in un altro chiamante non produce un varco
 * silenzioso ma un errore immediato.
 * ------------------------------------------------------------------------- */

/**
 * I campi del payload che il SERVER impone. Un valore mandato dal client su una
 * di queste chiavi viene tolto, qualunque sia l'ordine delle chiavi.
 *
 * `runId` è nell'elenco benché il suo VALORE nasca dal client, e non è una
 * contraddizione: il client PROPONE un identificativo di annullamento, ma è il
 * gestore a leggerlo esplicitamente
 * (`payload.runId`) e a rimetterlo nel payload attraverso il contesto del
 * server, dopo averlo registrato fra le operazioni in corso. Ciò che arriva a
 * `executeQueryCode` è quindi sempre il valore che il server ha registrato.
 */
const CAMPI_IMPOSTI_DAL_SERVER = Object.freeze(['runId', 'opHandle', 'run']);

// Marcatura non enumerabile: uno spread (`{ ...richiesta }`) la perde, e questo
// è voluto. Chi ricompone il payload a mano deve ripassare dalla regola.
const MARCA = Symbol('payloadEsecuzione');

function marca(oggetto) {
  Object.defineProperty(oggetto, MARCA, { value: true, enumerable: false });
  return oggetto;
}

/**
 * Compone il payload di `executeQueryCode`: i campi del client meno quelli
 * riservati al server, più quelli che il server fornisce davvero.
 *
 * @param {object} payloadClient  ciò che è arrivato dalla richiesta
 * @param {object} contestoServer solo chiavi di CAMPI_IMPOSTI_DAL_SERVER; `undefined`
 *                                significa "non c'è", e non finisce nel payload
 * @returns {object} un oggetto nuovo, marcato
 */
function payloadEsecuzione(payloadClient, contestoServer = {}) {
  const richiesta = {};
  for (const chiave of Object.keys(payloadClient || {})) {
    if (CAMPI_IMPOSTI_DAL_SERVER.includes(chiave)) continue;
    richiesta[chiave] = payloadClient[chiave];
  }
  for (const chiave of Object.keys(contestoServer || {})) {
    if (!CAMPI_IMPOSTI_DAL_SERVER.includes(chiave)) {
      throw new Error(`payloadEsecuzione: "${chiave}" non è un campo del server. `
        + `I campi del server sono: ${CAMPI_IMPOSTI_DAL_SERVER.join(', ')}.`);
    }
    if (contestoServer[chiave] !== undefined) richiesta[chiave] = contestoServer[chiave];
  }
  return marca(richiesta);
}

/** Il payload è stato composto dalla regola? */
function payloadMarcato(payload) {
  return !!(payload && typeof payload === 'object' && payload[MARCA] === true);
}

/**
 * Rifiuta un payload che non è passato dalla regola. Il messaggio è per chi
 * scrive il codice, non per l'utente finale: qui non ci arriva una richiesta,
 * ci arriva un chiamante nuovo scritto male.
 */
function assertPayloadEsecuzione(payload) {
  if (!payloadMarcato(payload)) {
    throw new Error('executeQueryCode: il payload deve essere composto da payloadEsecuzione() '
      + '(db/payloadEsecuzione.js), altrimenti i campi riservati al server — '
      + `${CAMPI_IMPOSTI_DAL_SERVER.join(', ')} — potrebbero arrivare dal client.`);
  }
  return payload;
}

module.exports = { CAMPI_IMPOSTI_DAL_SERVER, payloadEsecuzione, payloadMarcato, assertPayloadEsecuzione };

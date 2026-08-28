'use strict';

import { state } from './state.js';
import { $, emit, toast, openModal, closeModal, showError, esc, isSqlType, captureContext, iniziaCaricamento, marcaDatiSporchi } from './utils.js';
import { collWord, refreshDbTree } from './dbtree.js';
import { tabs } from './tabs.js';
import { socket } from './socket.js';
import { descriviEsitoImport } from './import-status.js';
import { preparaImportCsv } from './csv.js';
import { eseguiInParalleloOrdinato } from './export-pool.js';

// Export/import di collection e tabelle: l'export scarica il file a blocchi
// (skip/limit) via `collection:export`, l'import invia batch di documenti o
// righe via `collection:import`.
//
// Sono operazioni LUNGHE e non bloccanti: emit() inietta il tabId del tab ATTIVO
// al momento della chiamata, quindi ogni ciclo a blocchi deve congelare il
// proprio contesto con captureContext() e passare `tabId` esplicitamente. Senza,
// cambiare tab a metà import dirotta i blocchi rimanenti su un'altra
// connessione — con danno permanente, perché sono scritture.

const CHUNK = 500;
// Tetto in BYTE per blocco di import (CDB-34). Il conteggio a soli documenti non
// dice nulla sulla dimensione del messaggio: il server accetta al massimo 5 MB
// per messaggio Socket.IO (`maxHttpBufferSize`), quindi 500 documenti con un
// campo testo lungo superano il limite e la connessione CADE — l'import si
// interrompe con un errore di rete invece che con un messaggio comprensibile.
// Si tiene un margine ampio per la serializzazione EJSON e il resto del payload.
const CHUNK_BYTES = 3 * 1024 * 1024;

// Quanti documenti si misurano davvero prima di passare alla media (CDB-75).
const CAMPIONE_DIM = 50;

/**
 * Divide i documenti in blocchi che rispettano ENTRAMBI i limiti: numero di
 * documenti e dimensione stimata. Un singolo documento più grande del tetto
 * viaggia comunque da solo — se sfora, il rifiuto arriva dal server con un
 * messaggio, che è meglio di una connessione chiusa a metà lavoro.
 *
 * La dimensione si stima su un CAMPIONE (CDB-75): misurare ogni documento con
 * `JSON.stringify` significa serializzare l'intero file una volta in più
 * rispetto a quanto farà Socket.IO al momento dell'invio, e su un import da
 * centomila documenti quel giro in più blocca l'interfaccia prima ancora che
 * l'avanzamento parta. Qui serve un ordine di grandezza, non una misura: il
 * limite vero lo applica il server, e il margine di 3 MB su 5 assorbe l'errore
 * della stima. I documenti molto grandi restano misurati singolarmente finché
 * il campione non è completo, che è il caso in cui la stima conta davvero.
 *
 * Il margine 3/5 assorbe però un ERRORE di stima, non un ordine di grandezza
 * (CDB-A08): con documenti eterogenei — le prime cinquanta righe piccole e le
 * successive con un campo testo lungo — il blocco reale superava i 5 MB e
 * Socket.IO chiudeva la connessione. Due correzioni, entrambe a costo
 * trascurabile rispetto alla serializzazione che avverrà comunque:
 *  · si RIMISURA periodicamente (ogni RICALIBRA documenti), così la media segue
 *    il file invece di restare ferma alle prime righe;
 *  · quando il blocco corrente ha già superato metà del tetto si misura DAVVERO
 *    ogni documento, cioè esattamente dove sbagliare costa la connessione.
 */
// Ogni quanti documenti si torna a misurare per aggiornare la media.
const RICALIBRA = 200;

function blocchiDiImport(docs) {
  const blocchi = [];
  let corrente = [];
  let byte = 0;
  let misurati = 0;
  let sommaMisurata = 0;
  let daUltimaMisura = 0;

  for (const doc of docs) {
    let dim;
    // Vicino al tetto la stima non basta più: lì si misura sempre.
    const vicinoAlTetto = byte > CHUNK_BYTES / 2;
    if (misurati < CAMPIONE_DIM || vicinoAlTetto || daUltimaMisura >= RICALIBRA) {
      dim = JSON.stringify(doc).length;
      sommaMisurata += dim;
      misurati += 1;
      daUltimaMisura = 0;
    } else {
      dim = Math.ceil(sommaMisurata / misurati);
      daUltimaMisura += 1;
    }
    if (corrente.length && (corrente.length >= CHUNK || byte + dim > CHUNK_BYTES)) {
      blocchi.push(corrente);
      corrente = [];
      byte = 0;
    }
    corrente.push(doc);
    byte += dim;
  }
  if (corrente.length) blocchi.push(corrente);
  return blocchi;
}

/* ---------------------------------------------------------------------------
 * Export
 * ------------------------------------------------------------------------- */

function downloadBlob(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// format: 'json' (MongoDB), 'csv' o 'sql' (MySQL).
export async function exportCollection(db, coll, format, { csvMode = 'sicura' } = {}) {
  const lines = [];
  let skip = 0; // ripiego per tabelle MySQL senza chiave primaria
  let after = null; // cursore keyset (Mongo sempre, MySQL con PK)
  let total = 0;
  let header = null;
  // Anche l'export va ancorato al tab d'origine: senza, cambiare connessione a
  // metà scaricamento farebbe arrivare i blocchi successivi da un'altra
  // connessione e il file prodotto conterrebbe dati di due database diversi.
  const origin = captureContext();
  const { tabId } = origin;
  const dbType = origin.st.dbType;
  try {
    for (;;) {
      const res = await emit('collection:export', {
        tabId, db, coll, skip, after, limit: CHUNK, format, csvMode,
      });
      // Il totale (COUNT/countDocuments sull'intera tabella) viaggia solo
      // nella risposta del primo blocco: i successivi lo omettono per non
      // ripetere una scansione costosa che darebbe comunque lo stesso numero.
      // Sovrascriverlo con `undefined` avrebbe rotto sia il messaggio di
      // avanzamento sia la condizione di uscita del ciclo.
      if (res.total != null) total = res.total;
      if (header == null && res.header != null) header = res.header;
      lines.push(...res.lines);
      skip += res.count;
      after = res.nextAfter != null ? res.nextAfter : after;
      toast(`Esportazione di "${coll}"… ${Math.min(skip, total)}/${total}`);
      if (res.count < CHUNK || skip >= total) break;
    }
  } catch (err) {
    toast(`Esportazione fallita: ${err.message}`, true);
    return;
  }

  let text;
  let ext;
  let mime;
  if (format === 'csv') {
    text = (header != null ? header + '\n' : '') + lines.join('\n') + (lines.length ? '\n' : '');
    ext = 'csv';
    mime = 'text/csv;charset=utf-8';
  } else if (format === 'sql') {
    text = lines.join('\n') + (lines.length ? '\n' : '');
    ext = 'sql';
    mime = 'text/plain;charset=utf-8';
  } else {
    // MongoDB: array JSON di documenti in Extended JSON (relaxed).
    text = '[\n' + lines.join(',\n') + '\n]\n';
    ext = 'json';
    mime = 'application/json;charset=utf-8';
  }
  downloadBlob(text, `${db}.${coll}.${ext}`, mime);
  toast(`Esportati ${lines.length} ${isSqlType(dbType) ? 'righe' : 'documenti'} da "${coll}"`);
}

/* ---------------------------------------------------------------------------
 * Import
 * ------------------------------------------------------------------------- */

let importTarget = null; // { db, coll, ctx } — ctx congela il tab di destinazione (vedi openImportModal)
let importing = false;

// Prepara i batch a partire dal testo incollato/caricato, secondo il dbType.
function buildDocs(text, dbType = state.dbType) {
  if (isSqlType(dbType)) {
    // Il preflight analizza e valida l'intero file prima che possa partire il
    // primo batch: anteprima ed esecuzione consumano la stessa rappresentazione.
    return preparaImportCsv(text).documenti;
  }
  // MongoDB: array JSON (o singolo oggetto) in Extended JSON.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON non valido: ${err.message}`);
  }
  const docs = Array.isArray(parsed) ? parsed : [parsed];
  if (!docs.length) throw new Error('Il file non contiene documenti da importare.');
  for (const d of docs) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      throw new Error('Ogni elemento dell\'array deve essere un oggetto JSON.');
    }
  }
  return docs;
}

function setImportProgress(pct, label) {
  $('#import-progress').classList.remove('hidden');
  $('#import-progress-bar').style.width = `${Math.min(100, Math.round(pct))}%`;
  $('#import-progress-label').textContent = label || '';
}

export function openImportModal(db, coll) {
  if (importing) {
    toast('Attendi il completamento dell’import già in corso.', true);
    return;
  }
  // Il contesto (tab + coll-tab) va congelato all'apertura: l'import dura minuti
  // e la modale non blocca l'app, quindi l'utente può cambiare tab mentre i
  // blocchi partono. Senza un tabId esplicito, emit() userebbe il tab ATTIVO al
  // momento di ciascun blocco e le righe finirebbero in un'altra connessione.
  const ctx = captureContext();
  importTarget = { db, coll, dbType: ctx.st.dbType, ctx };
  importing = false;
  const isMysql = isSqlType(importTarget.dbType);
  $('#import-title').textContent = `Importa in "${coll}"`;
  $('#import-subtitle').textContent = isMysql
    ? `Tabella: ${db} ▸ ${coll} — formato CSV con riga di intestazione (nomi colonna).`
    : `Collection: ${db} ▸ ${coll} — formato JSON: array di documenti (Extended JSON supportato, es. {"$oid": ...}).`;
  $('#import-file').value = '';
  $('#import-file').accept = isMysql ? '.csv,text/csv' : '.json,application/json';
  $('#import-text').value = '';
  $('#import-text').placeholder = isMysql
    ? 'id,nome,creato\n1,Mario,2026-01-01 10:00:00'
    : '[\n  { "nome": "Mario", "creato": { "$date": "2026-01-01T10:00:00Z" } }\n]';
  $('#import-progress').classList.add('hidden');
  $('#import-progress-bar').style.width = '0%';
  $('#import-progress-label').textContent = '';
  $('#import-report').classList.add('hidden');
  $('#import-report').innerHTML = '';
  showError('#import-error', '');
  $('#import-run').disabled = false;
  openModal('#import-overlay');
}

async function runImport() {
  if (importing || !importTarget) return;
  showError('#import-error', '');
  $('#import-report').classList.add('hidden');

  const text = $('#import-text').value.trim();
  if (!text) {
    showError('#import-error', 'Nessun contenuto da importare: carica un file o incolla i dati.');
    return;
  }
  let docs;
  try {
    docs = buildDocs(text, importTarget.dbType);
  } catch (err) {
    showError('#import-error', err.message);
    return;
  }

  const { db, coll, ctx } = importTarget;
  // Il tab di destinazione è quello in cui l'utente ha aperto la modale, non
  // quello attivo quando parte il singolo blocco.
  const tabId = ctx && ctx.tabId;
  importing = true;
  // L'import ha già la sua barra di avanzamento, ma il pulsante che l'ha
  // avviato deve smettere di sembrare premibile.
  const fineCaricamento = iniziaCaricamento($('#import-run'), 'Import…');
  let inserted = 0;
  let failed = 0;
  let aborted = false;
  const errors = [];
  try {
    // Blocchi limitati per numero E per dimensione (CDB-34).
    const blocchi = blocchiDiImport(docs);
    let i = 0;
    for (const batch of blocchi) {
      // Tab chiuso (o mai esistito) durante l'import: fermarsi è l'unica scelta
      // corretta — proseguire scriverebbe su una sessione non più identificabile.
      if (tabId && !tabs.list.some((t) => t.id === tabId)) {
        aborted = true;
        errors.push('Import interrotto: la connessione di destinazione è stata chiusa.');
        failed += docs.length - i;
        break;
      }
      setImportProgress((i / docs.length) * 100, `${i}/${docs.length}…`);
      i += batch.length;
      try {
        const res = await emit('collection:import', { tabId, db, coll, docs: batch });
        inserted += res.inserted;
        failed += res.failed;
        for (const e of res.errors || []) {
          if (errors.length < 20) errors.push(e);
        }
      } catch (err) {
        // Blocco interamente fallito (es. connessione persa): conteggia e prosegui.
        failed += batch.length;
        if (errors.length < 20) errors.push(err.message);
      }
    }
  } finally {
    importing = false;
    fineCaricamento();
  }
  setImportProgress(100, `${docs.length}/${docs.length}`);

  // Report finale: conteggio ok/errori e prime cause di errore.
  const report = $('#import-report');
  const word = isSqlType(importTarget.dbType) ? 'righe' : 'documenti';
  let html = `<strong>${inserted}</strong> ${word} su ${docs.length} importati` +
    (failed ? `, <strong class="import-failed">${failed}</strong> con errori.` : '.');
  if (errors.length) {
    html += '<ul>' + errors.map((e) => `<li>${esc(e)}</li>`).join('') + '</ul>';
  }
  report.innerHTML = html;
  report.classList.remove('hidden');
  toast(
    aborted ? 'Import interrotto: connessione di destinazione chiusa'
      : failed ? `Import completato con ${failed} errori`
        : `Importati ${inserted} ${word} in "${coll}"`,
    aborted || !!failed
  );

  // La griglia richiede lo stesso coll-tab; per la sidebar basta che sia ancora
  // attivo il tab di connessione, perché l'albero è condiviso da tutti i coll-tab.
  if (!inserted) return;
  if (ctx.isStillActive() && state.db === db && state.coll === coll) {
    import('./grid.js').then(({ runQuery }) => runQuery({ auto: true })); // refresh post-import
  } else {
    marcaDatiSporchi(ctx, db, coll);
  }
  if (!ctx.tabId || tabs.activeId === ctx.tabId) refreshDbTree();
}

export function initExportImport() {
  $('#import-cancel').addEventListener('click', () => {
    if (!importing) closeModal('#import-overlay');
  });
  $('#import-run').addEventListener('click', runImport);
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { $('#import-text').value = String(reader.result || ''); };
    reader.onerror = () => showError('#import-error', 'Impossibile leggere il file selezionato.');
    reader.readAsText(file);
  });

  // --- Import di interi database ---------------------------------------------
  $('#dbimport-cancel').addEventListener('click', () => {
    if (!dbImporting) {
      dbImportContext = null;
      dbImportAperture++;
      closeModal('#dbimport-overlay');
    }
  });
  $('#dbimport-run').addEventListener('click', runDbImport);
  socket.on('database:import:progress', (operation) => {
    if (!dbImportOperationId || operation.operationId !== dbImportOperationId) return;
    renderDbImportState(operation);
  });
  $('#dbimport-report').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-dbimport-cleanup]');
    if (!button || !dbImportOperationId) return;
    if (!window.confirm('Eliminare definitivamente la copia di recupero e lo staging conservato?')) return;
    const fine = iniziaCaricamento(button, 'Elimino…');
    try {
      const response = await emit('database:import:cleanup', {
        tabId: tabs.activeId || (dbImportContext && dbImportContext.tabId),
        operationId: dbImportOperationId,
      });
      renderDbImportState(response.operation);
    } catch (err) {
      showError('#dbimport-error', err.message);
    } finally { fine(); }
  });
  $('#dbimport-file').addEventListener('change', (e) => {
    const ctx = dbImportContext;
    const apertura = dbImportAperture;
    dbImportData = null;
    dbImportUploadId = null;
    showError('#dbimport-error', '');
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      if (!ctx || ctx !== dbImportContext || apertura !== dbImportAperture) return;
      try {
        // Il file attraversa il limite Socket.IO in blocchi privi di effetti.
        // Soltanto dopo l'ultimo blocco il server lo ricompone e lo valida; le
        // mutazioni restano nell'unica operazione lunga avviata piu sotto.
        const raw = String(reader.result || '');
        const opened = await emit('database:import:upload:start', { tabId: ctx.tabId });
        dbImportUploadId = opened.uploadId;
        const chunkChars = 400000; // <= 1,6 MB anche con caratteri UTF-8 a quattro byte
        let index = 0;
        for (let offset = 0; offset < raw.length; offset += chunkChars) {
          await emit('database:import:upload:chunk', {
            tabId: ctx.tabId, uploadId: dbImportUploadId, index,
            chunk: raw.slice(offset, offset + chunkChars),
          });
          index++;
          setDbImportProgress(
            (offset / Math.max(1, raw.length)) * 100,
            'Caricamento e validazione del file...',
          );
        }
        const validato = await emit('database:import:upload:finish', {
          tabId: ctx.tabId, uploadId: dbImportUploadId,
        });
        if (ctx !== dbImportContext || apertura !== dbImportAperture) return;
        dbImportData = validato.artifact;
        if (!$('#dbimport-target').value.trim()) $('#dbimport-target').value = dbImportData.db || '';
        const docs = dbImportData.collections.reduce((s, c) => s + c.rows, 0);
        const entita = isSqlType(ctx.dbType) ? 'tabelle' : 'collection';
        $('#dbimport-subtitle').textContent =
          `File "${file.name}": database "${dbImportData.db}" (${dbImportData.dbType}), ` +
          `${dbImportData.collections.length} ${entita}, ${docs} ${isSqlType(dbImportData.dbType) ? 'righe' : 'documenti'}.`;
      } catch (err) {
        showError('#dbimport-error', err.message);
      }
    };
    reader.onerror = () => {
      if (ctx === dbImportContext && apertura === dbImportAperture) {
        showError('#dbimport-error', 'Impossibile leggere il file selezionato.');
      }
    };
    reader.readAsText(file);
  });
}

// Voci di menu contestuale per un intero database (sidebar).
export function dbExportImportMenuItems(db) {
  return [
    { label: '⤓ Esporta database (JSON)…', action: () => exportDatabase(db) },
    { label: '⤒ Importa database…', action: openDbImportModal },
  ];
}

/* ---------------------------------------------------------------------------
 * Export/import di INTERI database: un unico file .codedb.json auto-contenuto
 * { formato, versione, dbType, db, collections: [{ name, ddl, indexes, docs }] }
 * con i documenti/righe in Extended JSON (relaxed). L'export riusa i blocchi
 * di collection:export (formato json per entrambi i dbType) più il CREATE
 * TABLE (collection:ddl, MySQL) e gli indici (collection:stats, MongoDB);
 * l'import ricrea schema e indici e invia i dati con collection:import.
 * ------------------------------------------------------------------------- */

const DB_EXPORT_FORMAT = 'codedb-database';
const DB_EXPORT_CONCURRENCY = 3;

// Database di sistema: metadati generati dal server, non dati dell'utente.
// Esportarli produce viste non ricreabili, importarci sopra è distruttivo.
const SYSTEM_DBS = {
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  // Su PostgreSQL il livello "database" della UI è lo SCHEMA (vedi la nota in
  // PostgreSqlStrategy): qui vanno quindi gli schemi di sistema, non i database.
  postgresql: ['information_schema', 'pg_catalog', 'pg_toast'],
  postgres: ['information_schema', 'pg_catalog', 'pg_toast'],
  mongodb: ['admin', 'config', 'local'],
};

function isSystemDb(name, dbType = state.dbType) {
  return (SYSTEM_DBS[dbType] || []).includes(String(name).toLowerCase());
}

export async function exportDatabase(db) {
  const origin = captureContext();
  const { tabId } = origin;
  const dbType = origin.st.dbType;
  const isSql = isSqlType(dbType);
  const entita = isSql ? 'tabelle' : 'collection';
  if (isSystemDb(db, dbType)) {
    toast(`"${db}" è un database di sistema: contiene metadati del server, non è esportabile.`, true);
    return;
  }
  // Export di un intero database: decine di richieste in sequenza, quindi il tab
  // d'origine va congelato qui (vedi nota in testa al modulo).
  let collections;
  try {
    // Solo collection/tabelle "vere": le view sono derivate.
    collections = (await emit('db:collections', { tabId, db })).collections.filter((c) => c.type !== 'view');
  } catch (err) {
    toast(`Esportazione fallita: ${err.message}`, true);
    return;
  }
  // Il file viene assemblato come testo per non ri-parsare i blocchi EJSON.
  let parts = [];
  let exported = 0;
  let objects = null;
  try {
    objects = (await emit('database:schema-objects', { tabId, db })).objects || null;
    const objectCount = Object.values(objects || {}).reduce(
      (sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0,
    );
    if (!collections.length && !objectCount) {
      toast(`Il database "${db}" non contiene ${entita} o oggetti di schema da esportare.`, true);
      return;
    }
    // Ogni worker assembla una stringa JSON autonoma. Il pool ne conserva la
    // posizione originale, quindi le risposte possono arrivare fuori ordine
    // senza cambiare l'artefatto finale. Dentro una singola collezione i blocchi
    // restano sequenziali: `after`/`skip` del successivo dipendono dal precedente.
    const risultati = await eseguiInParalleloOrdinato(collections, async (c) => {
      let ddl = null;
      let indexes = null;
      let postDdl = null;
      let identity = dbType === 'mongodb' ? { kind: 'mongodb-id', columns: ['_id'] } : null;
      if (isSql) {
        ddl = (await emit('collection:ddl', { tabId, db, coll: c.name })).ddl;
        identity = (await emit('collection:identity', { tabId, db, coll: c.name })).identity;
        // Indici e FK viaggiano a parte e vengono applicati in coda all'import:
        // una FK verso una tabella non ancora creata fallirebbe. I DBMS che non
        // li espongono (e i server più vecchi) semplicemente non ne mandano.
        try {
          const aux = await emit('collection:auxddl', { tabId, db, coll: c.name });
          const statements = [...(aux.indexes || []), ...(aux.foreignKeys || [])];
          if (statements.length) postDdl = statements;
        } catch { /* server senza collection:auxddl: export comunque valido */ }
      } else {
        const stats = await emit('collection:stats', { tabId, db, coll: c.name });
        indexes = (stats.indexes || []).filter((i) => i.name !== '_id_');
      }
      const lines = [];
      let skip = 0;
      let after = null;
      let total = 0;
      for (;;) {
        const res = await emit('collection:export', { tabId, db, coll: c.name, skip, after, limit: CHUNK, format: 'json' });
        // Vedi la nota in exportCollection: il totale arriva solo sul primo
        // blocco e va conservato, non riletto da ogni risposta.
        if (res.total != null) total = res.total;
        lines.push(...res.lines);
        skip += res.count;
        after = res.nextAfter != null ? res.nextAfter : after;
        toast(`Esportazione di "${db}"… ${c.name}: ${Math.min(skip, total)}/${total}`);
        if (res.count < CHUNK || skip >= total) break;
      }
      return {
        count: lines.length,
        part: `  { "name": ${JSON.stringify(c.name)}, "ddl": ${JSON.stringify(ddl)}, ` +
        `"identity": ${JSON.stringify(identity)}, "indexes": ${JSON.stringify(indexes)}, ` +
        `"postDdl": ${JSON.stringify(postDdl)}, "docs": [\n    ` +
        lines.join(',\n    ') + '\n  ] }',
      };
    }, DB_EXPORT_CONCURRENCY);
    parts = risultati.map((risultato) => risultato.part);
    exported = risultati.reduce((totale, risultato) => totale + risultato.count, 0);
  } catch (err) {
    toast(`Esportazione fallita: ${err.message}`, true);
    return;
  }

  // `generatore` è una firma di provenienza DICHIARATA (come il campo `tool`
  // dei manifest di backup): dice a chi riceve il file quale programma lo ha
  // prodotto e quando, che è la prima cosa che serve sapere aprendo un export
  // altrui. Non è nascosta e non cambia nulla nel formato — l'import ignora i
  // campi che non conosce, quindi i file vecchi restano validi e i nuovi si
  // aprono anche con le versioni precedenti.
  let generatore = 'CodeDB';
  try {
    const info = await emit('app:info', { tabId });
    if (info && info.version) generatore = `CodeDB ${info.version}`;
  } catch { /* la firma non deve poter far fallire un export */ }

  const text =
    `{ "formato": ${JSON.stringify(DB_EXPORT_FORMAT)}, "versione": 1, ` +
    `"generatore": ${JSON.stringify(generatore)}, "creato": ${JSON.stringify(new Date().toISOString())}, ` +
    `"dbType": ${JSON.stringify(dbType)}, "db": ${JSON.stringify(db)},\n` +
    `"objects": ${JSON.stringify(objects)},\n"collections": [\n` + parts.join(',\n') + '\n] }\n';
  downloadBlob(text, `${db}.codedb.json`, 'application/json;charset=utf-8');
  toast(`Esportato il database "${db}": ${collections.length} ${entita}, ${exported} ${isSql ? 'righe' : 'documenti'}`);
}

/* --- Import di un intero database ----------------------------------------- */

let dbImportData = null; // contenuto validato del file selezionato
let dbImportUploadId = null; // artefatto completo conservato sul server
let dbImporting = false;
let dbImportContext = null;
let dbImportAperture = 0;
let dbImportOperationId = null;

function setDbImportProgress(pct, label) {
  $('#dbimport-progress').classList.remove('hidden');
  $('#dbimport-progress-bar').style.width = `${Math.min(100, Math.round(pct))}%`;
  $('#dbimport-progress-label').textContent = label || '';
}

export function openDbImportModal() {
  if (dbImporting) {
    toast('Attendi il completamento dell’import del database già in corso.', true);
    return;
  }
  const origin = captureContext();
  const dbType = origin.st.dbType;
  dbImportContext = { ...origin, dbType };
  dbImportAperture++;
  dbImportData = null;
  dbImportUploadId = null;
  dbImporting = false;
  $('#dbimport-subtitle').textContent = isSqlType(dbImportContext.dbType)
    ? 'Ricrea tabelle, righe, indici e chiavi esterne in uno schema di destinazione.'
    : 'Ricrea collection, documenti e indici in un database di destinazione.';
  $('#dbimport-file').value = '';
  $('#dbimport-target').value = '';
  $('#dbimport-drop').checked = false;
  $('#dbimport-progress').classList.add('hidden');
  $('#dbimport-progress-bar').style.width = '0%';
  $('#dbimport-progress-label').textContent = '';
  $('#dbimport-report').classList.add('hidden');
  $('#dbimport-report').innerHTML = '';
  showError('#dbimport-error', '');
  $('#dbimport-run').disabled = false;
  openModal('#dbimport-overlay');
  recuperaDbImport().catch((err) => showError('#dbimport-error', err.message));
}

async function recuperaDbImport() {
  const ctx = dbImportContext;
  const apertura = dbImportAperture;
  if (!ctx) return;
  const response = await emit('database:import:list', { tabId: ctx.tabId });
  if (ctx !== dbImportContext || apertura !== dbImportAperture || dbImporting || dbImportUploadId) return;
  const tab = tabs.list.find((item) => item.id === ctx.tabId);
  const connection = tab && tab.connName;
  const candidates = (response.operations || []).filter((operation) =>
    !connection || operation.connection === connection
  ).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  if (!candidates.length) return;
  dbImportOperationId = candidates[0].operationId;
  renderDbImportState(candidates[0]);
  if (candidates[0].status === 'in_corso') {
    dbImporting = true;
    try { await monitorDbImport(dbImportOperationId); }
    finally { dbImporting = false; }
  }
}

async function runDbImport() {
  if (dbImporting) return;
  showError('#dbimport-error', '');
  $('#dbimport-report').classList.add('hidden');
  if (!dbImportData) {
    showError('#dbimport-error', 'Seleziona prima un file .codedb.json valido.');
    return;
  }
  const ctx = dbImportContext;
  if (!ctx || (ctx.tabId && !tabs.list.some((t) => t.id === ctx.tabId))) {
    showError('#dbimport-error', 'La connessione scelta per l’import non è più aperta.');
    return;
  }
  const target = $('#dbimport-target').value.trim();
  if (!target) {
    showError('#dbimport-error', 'Indica il database di destinazione.');
    return;
  }
  if (isSystemDb(target, ctx.dbType)) {
    showError('#dbimport-error', `"${target}" è un database di sistema: scegli un'altra destinazione.`);
    return;
  }
  const drop = $('#dbimport-drop').checked;
  dbImporting = true;
  const fineCaricamento = iniziaCaricamento($('#dbimport-run'), 'Import…');
  try {
    // Anteprima ed esecuzione attraversano lo stesso evento. L'impronta
    // confermata impedisce che il secondo passaggio esegua un piano diverso.
    const preview = await emit('database:import:start', {
      tabId: ctx.tabId, uploadId: dbImportUploadId, targetDb: target, drop, previewOnly: true,
    });
    const plan = preview.plan;
    const identities = plan.collections.map((c) =>
      `${c.name}: ${c.identity ? c.identity.columns.join(', ') : 'nessuna identità stabile'}`
    ).join('\n');
    const strategy = plan.promotion.atomic
      ? 'swap atomico dello schema PostgreSQL'
      : 'staging con copia full di recupero (promozione non atomica)';
    if (!window.confirm(
      `Import database\n\nConnessione: ${plan.connection}\nDestinazione: ${plan.targetDb}`
      + `\nCollection/tabelle: ${plan.collections.length}\nIdentità:\n${identities}`
      + `\nStrategia: ${strategy}\n\nProcedere?`
    )) return;
    const started = await emit('database:import:start', {
      tabId: ctx.tabId, uploadId: dbImportUploadId, targetDb: target, drop,
      expectedFingerprint: plan.fingerprint,
    });
    dbImportOperationId = started.accepted.operationId;
    renderDbImportState(started.accepted);
    fineCaricamento();
    await monitorDbImport(dbImportOperationId);
  } catch (err) {
    showError('#dbimport-error', err.message);
  } finally {
    dbImporting = false;
    fineCaricamento();
  }
}

async function monitorDbImport(operationId) {
  for (;;) {
    const response = await emit('database:import:state', { operationId });
    const operation = response.operation;
    renderDbImportState(operation);
    if (operation.status !== 'in_corso') return operation;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
}

function renderDbImportState(operation) {
  const report = $('#dbimport-report');
  if (!report) return;
  const description = descriviEsitoImport(operation.status);
  const terminal = description.terminal;
  setDbImportProgress(
    terminal ? 100 : Math.min(95, (operation.progress || []).length * 8),
    operation.phase || description.label
  );
  let html = `<strong>${esc(description.label)}</strong>`;
  if (operation.error) html += `<p>${esc(operation.error)}</p>`;
  if (operation.recovery) {
    html += `<p>Copia di recupero conservata: <code>${esc(operation.recovery.id || 'disponibile')}</code>.</p>`;
  }
  if (operation.staging && operation.staging.retained) {
    html += `<p>Staging conservato: <code>${esc(operation.staging.db)}</code>.</p>`;
  }
  if ((operation.recovery || (operation.staging && operation.staging.retained)) && !operation.cleanupAt && terminal) {
    html += '<button type="button" class="ghost" data-dbimport-cleanup>Elimina staging e recupero…</button>';
  } else if (operation.cleanupAt) {
    html += `<p>Staging e recupero eliminati il ${esc(operation.cleanupAt)}.</p>`;
  }
  report.className = description.className;
  report.innerHTML = html;
  report.classList.remove('hidden');
  if (!terminal) return;
  const ok = description.ok;
  toast(description.label, !ok);
  if (ok && dbImportContext) {
    dbImportContext.st.schemaDirty = true;
    if (!dbImportContext.tabId || tabs.activeId === dbImportContext.tabId) {
      dbImportContext.st.schemaDirty = false;
      refreshDbTree();
    }
  }
}

// Voci di menu contestuale per una collection/tabella, condivise tra la
// sidebar (dbtree) e i coll-tab.
export function exportImportMenuItems(db, coll) {
  const items = isSqlType(state.dbType)
    ? [
        { label: '⤓ Esporta CSV (sicuro per fogli di calcolo)', action: () => exportCollection(db, coll, 'csv') },
        { label: '⤓ Esporta CSV letterale', action: () => exportCollection(db, coll, 'csv', { csvMode: 'letterale' }) },
        { label: '⤓ Esporta SQL (INSERT)', action: () => exportCollection(db, coll, 'sql') },
      ]
    : [{ label: '⤓ Esporta JSON', action: () => exportCollection(db, coll, 'json') }];
  items.push({ label: `⤒ Importa nella ${collWord()}…`, action: () => openImportModal(db, coll) });
  return items;
}

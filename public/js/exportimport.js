import { mountArcControls } from '../arc/ui.js';
'use strict';

import { state } from './state.js';
import { $, emit, toast, openModal, closeModal, showError, esc, isSqlType, captureContext, iniziaCaricamento, marcaDatiSporchi } from './utils.js';
import { collWord, refreshDbTree } from './dbtree.js';
import { tabs } from './tabs.js';
import { socket } from './socket.js';
import { descriviEsitoImport } from './import-status.js';
import { preparaImportCsv } from './csv.js';
import { importaBlocco } from './import-batch.js';
import { creaStatoSelezione } from './export-selezione.js';
import { confermaPiano } from './piano-anteprima.js';
import { mappaNomi } from './import-mapping.js';

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
  if (exportWizard) { toast('Un export ? gi? aperto o in corso.', true); return; }
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
  let uncertain = 0;
  let notSent = 0;
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
        const res = await importaBlocco(emit, { tabId, db, coll, docs: batch });
        if (res.status !== 'completato') {
          uncertain += batch.length;
          notSent = docs.length - i;
          errors.push(`Esito da verificare per il blocco ${res.batchId}: ${res.error} Non reimportare queste righe senza verificarne la presenza.`);
          break;
        }
        inserted += res.inserted;
        failed += res.failed;
        for (const e of res.errors || []) {
          if (errors.length < 20) errors.push(e);
        }
      } catch (err) {
        // Nessuna ricevuta affidabile: la scrittura potrebbe essere avvenuta.
        uncertain += batch.length;
        notSent = docs.length - i;
        if (errors.length < 20) errors.push(err.message);
        break;
      }
    }
  } finally {
    importing = false;
    fineCaricamento();
  }
  const processed = inserted + failed;
  setImportProgress((processed / docs.length) * 100, `${processed}/${docs.length} con esito confermato`);

  // Report finale: conteggio ok/errori e prime cause di errore.
  const report = $('#import-report');
  const word = isSqlType(importTarget.dbType) ? 'righe' : 'documenti';
  let html = `<strong>${inserted}</strong> ${word} su ${docs.length} importati` +
    (failed ? `, <strong class="import-failed">${failed}</strong> con errori.` : '.');
  if (uncertain) html += ` <strong>${uncertain}</strong> con esito incerto, da verificare.`;
  if (notSent) html += ` <strong>${notSent}</strong> non inviati.`;
  if (errors.length) {
    html += '<ul>' + errors.map((e) => `<li>${esc(e)}</li>`).join('') + '</ul>';
  }
  report.innerHTML = html;
  mountArcControls(report);
  report.classList.remove('hidden');
  toast(
    uncertain ? 'Import interrotto: alcune righe hanno un esito da verificare'
      : aborted ? 'Import interrotto: connessione di destinazione chiusa'
      : failed ? `Import completato con ${failed} errori`
        : `Importati ${inserted} ${word} in "${coll}"`,
    aborted || !!failed || !!uncertain
  );

  // La griglia richiede lo stesso coll-tab; per la sidebar basta che sia ancora
  // attivo il tab di connessione, perché l'albero è condiviso da tutti i coll-tab.
  if (!inserted && !uncertain) return;
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

  // --- Wizard di export di interi database -----------------------------------
  $('#dbexport-cancel').addEventListener('click', () => {
    exportWizard = null;
    closeModal('#dbexport-overlay');
  });
  $('#dbexport-cerca').addEventListener('input', disegnaAlberoExport);
  $('#dbexport-modalita').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-modalita]');
    if (b && exportWizard) applicaModalitaExport(b.dataset.modalita);
  });
  $('#dbexport-albero').addEventListener('change', (e) => {
    const casella = e.target.closest('input[data-id]');
    if (!casella || !exportWizard) return;
    try {
      exportWizard.sel.imposta(casella.dataset.id, casella.dataset.colonna, casella.checked);
    } catch (err) {
      showError('#dbexport-error', err.message);
      return;
    }
    showError('#dbexport-error', '');
    // Toccare una casella rende la selezione personalizzata: tenere accesa
    // «solo struttura» su una selezione che non lo è più sarebbe un'etichetta
    // che mente, e il piano verrebbe costruito su quella.
    if (exportWizard.modalita !== 'personalizzata') {
      exportWizard.modalita = 'personalizzata';
      for (const b of $('#dbexport-modalita').querySelectorAll('button')) {
        b.setAttribute('aria-pressed', String(b.dataset.modalita === 'personalizzata'));
      }
    }
    disegnaAlberoExport();
  });
  $('#dbexport-run').addEventListener('click', async () => {
    if (!exportWizard || exportWizard.inCorso) return;
    const wizard = exportWizard;
    wizard.inCorso = true;
    const fine = iniziaCaricamento($('#dbexport-run'), 'Anteprima…');
    let risposta;
    try {
      risposta = await pianoExportCorrente();
    } catch (err) {
      showError('#dbexport-error', err.message);
      wizard.inCorso = false;
      return;
    } finally { fine(); }
    if (exportWizard !== wizard) return;
    closeModal('#dbexport-overlay');
    // Ciò che si conferma è ciò che si esegue, e sono lo STESSO oggetto: il
    // piano passa dal riepilogo all'esecuzione senza essere ricostruito.
    if (!await confermaPiano(risposta.plan, { azione: 'Esporta' })) {
      exportWizard = null;
      return;
    }
    try { await eseguiExportDatabase(risposta.plan, wizard); }
    finally { if (exportWizard === wizard) exportWizard = null; }
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
    { label: '⤓ Esporta database…', action: () => exportDatabase(db) },
    { label: '⤒ Importa database…', action: openDbImportModal },
  ];
}

/* ---------------------------------------------------------------------------
 * Export di INTERI database: il server esegue il piano confermato e pubblica
 * un file SQL o EJSON verificato. Il browser segue lo stato e avvia il download
 * HTTP, senza accumulare il database in memoria. L'import CodeDB conserva il
 * proprio percorso con anteprima, staging e recupero.
 * ------------------------------------------------------------------------- */


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

/* --- Wizard di export: scelta del perimetro ------------------------------- */

// Contesto vivo del wizard. `null` quando la modale è chiusa: ogni gestore lo
// controlla, così un clic arrivato su una modale già chiusa non lavora su un
// piano che non è più quello mostrato.
let exportWizard = null;

function disegnaAlberoExport() {
  const w = exportWizard;
  if (!w) return;
  const visibili = new Set(w.sel.cerca($('#dbexport-cerca').value));
  const righe = [`<div class="dbexport-riga intestazione"><span>Oggetto</span>`
    + `<span class="dbexport-cella">Struttura</span><span class="dbexport-cella">Dati</span></div>`];
  for (const o of w.oggetti) {
    if (!visibili.has(o.id)) continue;
    const casella = (colonna, attivo, spento) =>
      `<span class="dbexport-cella"><input type="checkbox" data-id="${esc(o.id)}" data-colonna="${colonna}"`
      + `${attivo ? ' checked' : ''}${spento ? ' disabled' : ''}`
      + ` aria-label="${esc(o.nome)} — ${colonna}" /></span>`;
    righe.push(
      `<div class="dbexport-riga"><span>${esc(o.nome)}<span class="dbexport-tipo">${esc(o.tipo)}</span></span>`
      + casella('struttura', w.sel.stato(o.id, 'struttura') === w.sel.STATI.TUTTO, false)
      // Una vista o una routine non porta righe: la casella si DISABILITA, così
      // lo dice prima del clic invece di accettarlo e non fare nulla.
      + casella('dati', o.portaDati && w.sel.stato(o.id, 'dati') === w.sel.STATI.TUTTO, !o.portaDati)
      + `</div>`
    );
  }
  if (righe.length === 1) righe.push('<p class="dbexport-vuoto">Nessun oggetto corrisponde alla ricerca.</p>');
  $('#dbexport-albero').innerHTML = righe.join('');
  const r = w.sel.riepilogo();
  $('#dbexport-riepilogo').textContent =
    `${r.oggetti} oggetti · ${r.conStruttura} con struttura · ${r.conDati} con dati · ${r.esclusi.length} esclusi`;
}

function applicaModalitaExport(modalita) {
  const w = exportWizard;
  if (!w) return;
  w.modalita = modalita;
  for (const b of $('#dbexport-modalita').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.modalita === modalita));
  }
  // Le tre modalità globali IMPOSTANO la selezione e restano modificabili: se
  // si tocca una casella si passa in «personalizzata», perché una modalità
  // dichiarata che non descrive più la selezione è un'etichetta che mente.
  if (modalita === 'struttura-e-dati') w.sel.selezionaTutto();
  else if (modalita === 'solo-struttura') w.sel.soloStruttura();
  else if (modalita === 'solo-dati') w.sel.soloDati();
  disegnaAlberoExport();
}

/** Chiede al server il piano per la selezione corrente. */
async function pianoExportCorrente() {
  const w = exportWizard;
  const risposta = await emit('database:export:plan', {
    tabId: w.tabId, db: w.db,
    modalita: w.modalita,
    formato: $('#dbexport-formato').value,
    // Solo la modalità personalizzata porta una selezione: nelle altre tre il
    // perimetro lo decide il piano, e mandargliela sarebbe dirgli due volte la
    // stessa cosa con due voci che possono divergere.
    selezione: w.modalita === 'personalizzata' ? w.sel.perPiano() : null,
  });
  return risposta;
}

/**
 * Apre il wizard: il perimetro si sceglie e si VEDE prima di esportare.
 *
 * Il piano lo costruisce il server dal catalogo REALE del database — vincoli
 * dichiarati, dipendenze di view, tabella di un trigger — e non dalle euristiche
 * UML, che indovinano un legame dal nome di una colonna: qui un'ipotesi
 * sbagliata non costa una freccia di troppo in un diagramma, costa una tabella
 * esportata che nessuno ha chiesto o un perimetro che si crede chiuso e non lo è.
 * Da lì arrivano anche le dipendenze aggiunte d'ufficio e i vincoli che non si
 * potranno ricreare, che sono la conseguenza più facile da non vedere di una
 * selezione parziale.
 *
 * Il controllo sui database di sistema resta anche qui per dare un messaggio
 * subito, ma non è più l'unico: viveva SOLO nel browser, quindi chiunque
 * parlasse direttamente col socket poteva chiedere `mysql` o `pg_catalog`.
 */
export async function exportDatabase(db) {
  if (exportWizard?.inCorso) { toast('Un export è già in corso.', true); return; }
  const origin = captureContext();
  const { tabId } = origin;
  const dbType = origin.st.dbType;
  if (isSystemDb(db, dbType)) {
    toast(`"${db}" è un database di sistema: contiene metadati del server, non è esportabile.`, true);
    return;
  }
  let risposta;
  const wizard = { tabId, db, dbType, modalita: 'struttura-e-dati', sel: null, oggetti: [] };
  try {
    exportWizard = wizard;
    risposta = await emit('database:export:plan', { tabId, db, modalita: 'struttura-e-dati' });
  } catch (err) {
    if (exportWizard === wizard) exportWizard = null;
    toast(`Esportazione fallita: ${err.message}`, true);
    return;
  }
  if (exportWizard !== wizard) return;
  // Gli oggetti del wizard sono quelli del CATALOGO, non quelli del primo
  // piano: il piano esclude ciò che non è selezionato, e un oggetto escluso
  // deve restare visibile — altrimenti «solo struttura» farebbe sparire dalla
  // lista tutto ciò che si voleva riaccendere.
  const catalogo = risposta.catalogo || risposta.plan.oggetti;
  exportWizard.oggetti = catalogo.map((o) => ({
    id: o.id, tipo: o.tipo, nome: o.nome, portaDati: o.tipo === 'tabella' || o.tipo === 'collection',
  }));
  exportWizard.sel = creaStatoSelezione(exportWizard.oggetti);
  $('#dbexport-subtitle').textContent =
    `${db} · ${exportWizard.oggetti.length} oggetti nel catalogo (${dbType})`;
  $('#dbexport-motore').textContent = risposta.motore && risposta.motore.backend === 'nativo'
    ? `Motore: nativo (${risposta.motore.nativo.tool}).`
    : `Motore: incorporato. ${(risposta.motore && risposta.motore.motivo) || ''}`;
  $('#dbexport-formato').innerHTML = isSqlType(dbType)
    ? '<option value="sql">Script SQL (.sql)</option><option value="codedb-json">CodeDB EJSON (.codedb.json)</option>'
    : '<option value="codedb-json">CodeDB EJSON (.codedb.json)</option>';
  $('#dbexport-cerca').value = '';
  showError('#dbexport-error', '');
  applicaModalitaExport('struttura-e-dati');
  openModal('#dbexport-overlay');
}

/** Esegue l'export del perimetro confermato. */
async function eseguiExportDatabase(plan, wizard) {
  const { tabId, db } = wizard;
  try {
    const started = await emit('database:export:start', { tabId, fingerprint: plan.fingerprint });
    let operation;
    do {
      await new Promise(resolve => setTimeout(resolve, 750));
      ({ operation } = await emit('database:export:status', { tabId, db, operationId: started.operation.id }));
      if (operation.status === 'fallito') throw new Error(operation.error);
      toast(`Esportazione di "${db}"… ${operation.collection || ''}: ${operation.rows} righe/documenti`);
    } while (operation.status === 'in_corso');
    const link = document.createElement('a');
    link.href = operation.url;
    link.download = operation.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast(`Export verificato: ${operation.collections} tabelle/collection, ${operation.rows} righe/documenti. Download avviato.`);
  } catch (err) {
    toast(`Esportazione fallita: ${err.message}`, true);
  }
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
  $('#dbimport-mapping').classList.add('hidden');
  $('#dbimport-mapping').innerHTML = '';
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

/**
 * Le collisioni di nome, prima di scrivere.
 *
 * Tre cose possono andare storte e sono tutte silenziose se nessuno le elenca:
 * due oggetti diversi che finiscono sullo stesso nome, un nome che su
 * PostgreSQL collide con uno esistente perché il motore abbassa gli
 * identificatori non quotati (`Prova` e `prova` sono la stessa tabella), e un
 * nome che nella destinazione esiste già. La terza la risolve la casella
 * «elimina e ricrea», ma prima va VISTA.
 *
 * Non ferma l'import: sono conseguenze da conoscere, non errori.
 */
async function mostraMappingImport(ctx, target, plan) {
  const pannello = $('#dbimport-mapping');
  pannello.innerHTML = '';
  pannello.classList.add('hidden');
  let esistenti = [];
  try {
    esistenti = (await emit('db:collections', { tabId: ctx.tabId, db: target })).collections.map((c) => c.name);
  } catch {
    // La destinazione può non esistere ancora: è il caso normale di un import
    // in un database nuovo, e non avere nulla con cui collidere non è un guasto.
    esistenti = [];
  }
  const { avvisi } = mappaNomi({
    sorgenti: plan.collections.map((c) => c.name),
    esistenti,
    motore: ctx.dbType,
  });
  if (!avvisi.length) return;
  const testo = {
    'collisione-sorgenti': (a) => `"${a.da}" e "${a.altro}" finirebbero entrambi su "${a.a}".`,
    'fold-maiuscole': (a) => `"${a.a}" e "${a.esistente}" sono la stessa tabella su PostgreSQL (i nomi non quotati vengono abbassati).`,
    'esiste-gia': (a) => `"${a.a}" esiste già nella destinazione.`,
  };
  pannello.innerHTML = avvisi.map((a) => `<li>${esc((testo[a.tipo] || (() => a.tipo))(a))}</li>`).join('');
  pannello.classList.remove('hidden');
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
    // La selezione dichiara che cosa dell'archivio entra e con quale politica,
    // e RIFIUTA qui ciò che non si può eseguire — fondere senza un'identità
    // stabile, chiedere dati che l'archivio non contiene — invece di scoprirlo
    // a metà import, quando la destinazione è già stata toccata.
    await emit('database:import:selezione', {
      tabId: ctx.tabId, uploadId: dbImportUploadId, targetDb: target,
    });
    await mostraMappingImport(ctx, target, plan);
    // Il riepilogo sostituisce un `window.confirm` con la stringa composta a
    // mano qui: che cosa un piano dica sta ora in `riepilogo-piano.js`, uno
    // solo per i tre piani, invece che in ogni punto di chiamata.
    if (!await confermaPiano(plan, { azione: 'Importa' })) return;
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
  mountArcControls(report);
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

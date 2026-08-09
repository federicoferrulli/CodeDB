'use strict';

import { state } from './state.js';
import { $, emit, toast, openModal, closeModal, showError, esc, isSqlType, captureContext, iniziaCaricamento } from './utils.js';
import { collWord, refreshDbTree } from './dbtree.js';
import { tabs } from './tabs.js';

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
 */
function blocchiDiImport(docs) {
  const blocchi = [];
  let corrente = [];
  let byte = 0;
  let misurati = 0;
  let sommaMisurata = 0;

  for (const doc of docs) {
    let dim;
    if (misurati < CAMPIONE_DIM) {
      dim = JSON.stringify(doc).length;
      sommaMisurata += dim;
      misurati += 1;
    } else {
      dim = Math.ceil(sommaMisurata / misurati);
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
export async function exportCollection(db, coll, format) {
  const lines = [];
  let skip = 0; // ripiego per tabelle MySQL senza chiave primaria
  let after = null; // cursore keyset (Mongo sempre, MySQL con PK)
  let total = 0;
  let header = null;
  // Anche l'export va ancorato al tab d'origine: senza, cambiare connessione a
  // metà scaricamento farebbe arrivare i blocchi successivi da un'altra
  // connessione e il file prodotto conterrebbe dati di due database diversi.
  const { tabId } = captureContext();
  try {
    for (;;) {
      const res = await emit('collection:export', { tabId, db, coll, skip, after, limit: CHUNK, format });
      total = res.total;
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
  toast(`Esportati ${lines.length} ${state.dbType === 'mysql' ? 'righe' : 'documenti'} da "${coll}"`);
}

/* ---------------------------------------------------------------------------
 * Import
 * ------------------------------------------------------------------------- */

let importTarget = null; // { db, coll, ctx } — ctx congela il tab di destinazione (vedi openImportModal)
let importing = false;

// Parser CSV minimale (RFC 4180): gestisce virgolette, virgolette raddoppiate
// e a capo dentro i campi.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Ignora le righe completamente vuote.
  return rows.filter((r) => r.some((v) => v !== ''));
}

// Prepara i batch a partire dal testo incollato/caricato, secondo il dbType.
function buildDocs(text) {
  if (state.dbType === 'mysql') {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('CSV vuoto o senza righe di dati: serve una riga di intestazione più almeno una riga.');
    const header = rows[0].map((h) => h.trim());
    if (header.some((h) => !h)) throw new Error('La riga di intestazione del CSV contiene colonne senza nome.');
    return rows.slice(1).map((r) => {
      const obj = {};
      header.forEach((col, i) => {
        const v = r[i];
        obj[col] = v === '' || v === undefined ? null : v; // MySQL converte i tipi dalle stringhe
      });
      return obj;
    });
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
  // Il contesto (tab + coll-tab) va congelato all'apertura: l'import dura minuti
  // e la modale non blocca l'app, quindi l'utente può cambiare tab mentre i
  // blocchi partono. Senza un tabId esplicito, emit() userebbe il tab ATTIVO al
  // momento di ciascun blocco e le righe finirebbero in un'altra connessione.
  importTarget = { db, coll, ctx: captureContext() };
  importing = false;
  const isMysql = state.dbType === 'mysql';
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
    docs = buildDocs(text);
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
  const word = state.dbType === 'mysql' ? 'righe' : 'documenti';
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

  // Aggiorna griglia e sidebar solo se l'utente sta ancora guardando il tab in
  // cui è avvenuto l'import: le due funzioni leggono il workspace condiviso.
  if (!inserted || (ctx && !ctx.isStillActive())) return;
  if (state.db === db && state.coll === coll) {
    import('./grid.js').then(({ runQuery }) => runQuery({ auto: true })); // refresh post-import
  }
  refreshDbTree();
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
    if (!dbImporting) closeModal('#dbimport-overlay');
  });
  $('#dbimport-run').addEventListener('click', runDbImport);
  $('#dbimport-file').addEventListener('change', (e) => {
    dbImportData = null;
    showError('#dbimport-error', '');
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        dbImportData = validateDbExport(String(reader.result || ''));
        if (!$('#dbimport-target').value.trim()) $('#dbimport-target').value = dbImportData.db || '';
        const docs = dbImportData.collections.reduce((s, c) => s + c.docs.length, 0);
        $('#dbimport-subtitle').textContent =
          `File "${file.name}": database "${dbImportData.db}" (${dbImportData.dbType}), ` +
          `${dbImportData.collections.length} ${collWord()}, ${docs} ${state.dbType === 'mysql' ? 'righe' : 'documenti'}.`;
      } catch (err) {
        showError('#dbimport-error', err.message);
      }
    };
    reader.onerror = () => showError('#dbimport-error', 'Impossibile leggere il file selezionato.');
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

function isSystemDb(name) {
  return (SYSTEM_DBS[state.dbType] || []).includes(String(name).toLowerCase());
}

export async function exportDatabase(db) {
  const isSql = isSqlType(state.dbType);
  if (isSystemDb(db)) {
    toast(`"${db}" è un database di sistema: contiene metadati del server, non è esportabile.`, true);
    return;
  }
  // Export di un intero database: decine di richieste in sequenza, quindi il tab
  // d'origine va congelato qui (vedi nota in testa al modulo).
  const { tabId } = captureContext();
  let collections;
  try {
    // Solo collection/tabelle "vere": le view sono derivate.
    collections = (await emit('db:collections', { tabId, db })).collections.filter((c) => c.type !== 'view');
  } catch (err) {
    toast(`Esportazione fallita: ${err.message}`, true);
    return;
  }
  if (!collections.length) {
    toast(`Il database "${db}" non contiene ${collWord()} da esportare.`, true);
    return;
  }

  // Il file viene assemblato come testo per non ri-parsare i blocchi EJSON.
  const parts = [];
  let exported = 0;
  try {
    for (const c of collections) {
      let ddl = null;
      let indexes = null;
      if (isSql) {
        ddl = (await emit('collection:ddl', { tabId, db, coll: c.name })).ddl;
      } else {
        const stats = await emit('collection:stats', { tabId, db, coll: c.name });
        indexes = (stats.indexes || []).filter((i) => i.name !== '_id_');
      }
      const lines = [];
      let skip = 0;
      let after = null;
      for (;;) {
        const res = await emit('collection:export', { tabId, db, coll: c.name, skip, after, limit: CHUNK, format: 'json' });
        lines.push(...res.lines);
        skip += res.count;
        after = res.nextAfter != null ? res.nextAfter : after;
        toast(`Esportazione di "${db}"… ${c.name}: ${Math.min(skip, res.total)}/${res.total}`);
        if (res.count < CHUNK || skip >= res.total) break;
      }
      exported += lines.length;
      parts.push(
        `  { "name": ${JSON.stringify(c.name)}, "ddl": ${JSON.stringify(ddl)}, ` +
        `"indexes": ${JSON.stringify(indexes)}, "docs": [\n    ` +
        lines.join(',\n    ') + '\n  ] }'
      );
    }
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
    const info = await emit('app:info');
    if (info && info.version) generatore = `CodeDB ${info.version}`;
  } catch { /* la firma non deve poter far fallire un export */ }

  const text =
    `{ "formato": ${JSON.stringify(DB_EXPORT_FORMAT)}, "versione": 1, ` +
    `"generatore": ${JSON.stringify(generatore)}, "creato": ${JSON.stringify(new Date().toISOString())}, ` +
    `"dbType": ${JSON.stringify(state.dbType)}, "db": ${JSON.stringify(db)},\n"collections": [\n` +
    parts.join(',\n') + '\n] }\n';
  downloadBlob(text, `${db}.codedb.json`, 'application/json;charset=utf-8');
  toast(`Esportato il database "${db}": ${collections.length} ${collWord()}, ${exported} ${state.dbType === 'mysql' ? 'righe' : 'documenti'}`);
}

/* --- Import di un intero database ----------------------------------------- */

let dbImportData = null; // contenuto validato del file selezionato
let dbImporting = false;

function setDbImportProgress(pct, label) {
  $('#dbimport-progress').classList.remove('hidden');
  $('#dbimport-progress-bar').style.width = `${Math.min(100, Math.round(pct))}%`;
  $('#dbimport-progress-label').textContent = label || '';
}

function validateDbExport(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON non valido: ${err.message}`);
  }
  if (!parsed || parsed.formato !== DB_EXPORT_FORMAT || !Array.isArray(parsed.collections)) {
    throw new Error('Il file non è un export di database di CodeDB (atteso "formato": "codedb-database").');
  }
  if (parsed.dbType !== state.dbType) {
    throw new Error(`Il file è un export ${parsed.dbType}, ma questa connessione è ${state.dbType}.`);
  }
  for (const c of parsed.collections) {
    if (!c || typeof c.name !== 'string' || !Array.isArray(c.docs)) {
      throw new Error('File malformato: ogni collection deve avere "name" e l\'array "docs".');
    }
  }
  return parsed;
}

export function openDbImportModal() {
  dbImportData = null;
  dbImporting = false;
  $('#dbimport-subtitle').textContent = state.dbType === 'mysql'
    ? 'Ricrea tabelle (CREATE TABLE del file) e righe in uno schema di destinazione.'
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
}

async function runDbImport() {
  if (dbImporting) return;
  showError('#dbimport-error', '');
  $('#dbimport-report').classList.add('hidden');
  if (!dbImportData) {
    showError('#dbimport-error', 'Seleziona prima un file .codedb.json valido.');
    return;
  }
  const target = $('#dbimport-target').value.trim();
  if (!target) {
    showError('#dbimport-error', 'Indica il database di destinazione.');
    return;
  }
  if (isSystemDb(target)) {
    showError('#dbimport-error', `"${target}" è un database di sistema: scegli un'altra destinazione.`);
    return;
  }
  const drop = $('#dbimport-drop').checked;
  const isSql = isSqlType(state.dbType);
  const totalDocs = dbImportData.collections.reduce((s, c) => s + c.docs.length, 0) || 1;

  // Import di un intero database: è l'operazione più lunga dell'app (schema +
  // dati + indici, collection per collection). Il tab di destinazione si congela
  // qui, altrimenti un cambio di connessione a metà riverserebbe le collection
  // rimanenti su un altro database (vedi nota in testa al modulo).
  const ctx = captureContext();
  const tabId = ctx.tabId;
  const stillConnected = () => !tabId || tabs.list.some((t) => t.id === tabId);

  dbImporting = true;
  const fineCaricamento = iniziaCaricamento($('#dbimport-run'), 'Import…');
  let inserted = 0;
  let failed = 0;
  let done = 0;
  const errors = [];
  const pushErr = (msg) => { if (errors.length < 20) errors.push(msg); };
  try {
    // SQL: lo schema di destinazione deve esistere (MongoDB lo crea da solo
    // al primo insert). "esiste già" non è un errore.
    if (isSql) {
      try {
        await emit('db:create', { tabId, db: target });
      } catch (err) {
        if (!/esiste già/i.test(err.message)) throw err;
      }
    }

    for (const c of dbImportData.collections) {
      // Connessione di destinazione chiusa a metà import: fermarsi subito.
      if (!stillConnected()) {
        pushErr('Import interrotto: la connessione di destinazione è stata chiusa.');
        break;
      }
      setDbImportProgress((done / totalDocs) * 100, `${c.name}…`);
      try {
        if (drop) {
          await emit('collection:drop', { tabId, db: target, coll: c.name }).catch(() => { /* non esisteva */ });
        }
        if (isSql && c.ddl) {
          // CREATE TABLE dal file; se la tabella esiste già (senza drop) si
          // prosegue con il solo inserimento delle righe.
          await emit('collection:aggregate', { tabId, db: target, coll: c.name, pipeline: c.ddl })
            .catch((err) => {
              if (!/already exists/i.test(err.message)) throw err;
            });
        }
      } catch (err) {
        failed += c.docs.length;
        done += c.docs.length;
        pushErr(`${c.name}: ${err.message}`);
        continue;
      }

      // Stessi blocchi dell'import singolo: limitati anche per BYTE (CDB-34),
      // altrimenti poche righe grandi superano il tetto del messaggio Socket.IO
      // e la connessione cade a metà import.
      let i = 0;
      for (const batch of blocchiDiImport(c.docs)) {
        setDbImportProgress((done / totalDocs) * 100, `${c.name}: ${i}/${c.docs.length}…`);
        i += batch.length;
        try {
          const res = await emit('collection:import', { tabId, db: target, coll: c.name, docs: batch });
          inserted += res.inserted;
          failed += res.failed;
          for (const e of res.errors || []) pushErr(`${c.name}: ${e}`);
        } catch (err) {
          failed += batch.length;
          pushErr(`${c.name}: ${err.message}`);
        }
        done += batch.length;
      }

      // MongoDB: ricrea gli indici della collection (dopo i dati).
      await Promise.all((c.indexes || []).map(async (idx) => {
        try {
          await emit('index:create', {
            tabId, db: target, coll: c.name,
            fields: JSON.stringify(idx.key), unique: !!idx.unique, name: idx.name,
          });
        } catch (err) {
          pushErr(`${c.name}, indice "${idx.name}": ${err.message}`);
        }
      }));
    }
  } catch (err) {
    pushErr(err.message);
  } finally {
    dbImporting = false;
    fineCaricamento();
  }
  setDbImportProgress(100, 'completato');

  const report = $('#dbimport-report');
  const word = isSql ? 'righe' : 'documenti';
  let html = `<strong>${inserted}</strong> ${word} importati in "${esc(target)}"` +
    (failed ? `, <strong class="import-failed">${failed}</strong> con errori.` : '.');
  if (errors.length) {
    html += '<ul>' + errors.map((e) => `<li>${esc(e)}</li>`).join('') + '</ul>';
  }
  report.innerHTML = html;
  report.classList.remove('hidden');
  toast(failed || errors.length ? 'Import del database completato con errori' : `Database "${target}" importato`, !!(failed || errors.length));
  // La sidebar mostra i database del tab attivo: aggiornarla da un altro tab
  // sostituirebbe il suo albero con quello della connessione di destinazione.
  if (ctx.isStillActive()) refreshDbTree();
}

// Voci di menu contestuale per una collection/tabella, condivise tra la
// sidebar (dbtree) e i coll-tab.
export function exportImportMenuItems(db, coll) {
  const items = state.dbType === 'mysql'
    ? [
        { label: '⤓ Esporta CSV', action: () => exportCollection(db, coll, 'csv') },
        { label: '⤓ Esporta SQL (INSERT)', action: () => exportCollection(db, coll, 'sql') },
      ]
    : [{ label: '⤓ Esporta JSON', action: () => exportCollection(db, coll, 'json') }];
  items.push({ label: `⤒ Importa nella ${collWord()}…`, action: () => openImportModal(db, coll) });
  return items;
}

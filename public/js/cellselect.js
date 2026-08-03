'use strict';

import { state } from './state.js';
import { $, emit, displayValue, toast, showContextMenu, idOf, parseEdited, valueType, isPlainObject, isSqlType, isForActiveTab, captureContext, eseguiAOndate } from './utils.js';
import { runQuery, ensureRowRendered } from './grid.js';
import { statistiche, statistichePerColonna, formattaNumero, riassuntoBreve } from './cell-stats.js';

// Selezione di celle stile Excel sulla griglia dati: click, trascinamento
// rettangolare, Shift+click (estende dall'ancora), Ctrl+click (aggiunge/toglie),
// Ctrl+click sull'header (seleziona la colonna), frecce (con Shift estendono),
// Ctrl+A, copia negli appunti (Ctrl+C in TSV; dal menu contestuale anche JSON,
// CSV, Markdown, SQL INSERT), incolla da Excel (Ctrl+V, aggiorna i documenti),
// esportazione CSV della selezione e STATISTICHE dei valori numerici (somma,
// media, mediana, min, max… nella barra di stato e nel pannello 📊, calcolate
// dal modulo puro `cell-stats.js`).
// Lo stato vive per tab in `state.cellSel` (chiavi "riga:colonna" sugli indici
// di state.docs/state.columns), così la selezione sopravvive ai re-render.

function sel() {
  if (!state.cellSel) state.cellSel = { anchor: null, focus: null, cells: new Set() };
  return state.cellSel;
}

const key = (r, c) => `${r}:${c}`;

function cellFromTd(td) {
  return { r: Number(td.dataset.r), c: Number(td.dataset.c) };
}

// Tutte le chiavi del rettangolo con vertici a e b (inclusi).
function rectKeys(a, b) {
  const keys = [];
  for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
    for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) {
      keys.push(key(r, c));
    }
  }
  return keys;
}

export function clearCellSelection() {
  const s = sel();
  s.anchor = null;
  s.focus = null;
  s.cells.clear();
}

// Oltre questa dimensione la selezione non viene analizzata a ogni re-render.
const MAX_CELLE_RIASSUNTO = 20000;

// Ri-applica le classi CSS della selezione dopo un render della griglia,
// scartando le celle ormai fuori dai limiti della pagina corrente.
export function applyCellSelection() {
  const s = sel();
  for (const k of [...s.cells]) {
    const [r, c] = k.split(':').map(Number);
    if (r >= state.docs.length || c >= state.columns.length) s.cells.delete(k);
  }
  if (s.focus && (s.focus.r >= state.docs.length || s.focus.c >= state.columns.length)) {
    s.focus = null;
    s.anchor = null;
  }
  document.querySelectorAll('#grid tbody td[data-c]').forEach((td) => {
    const { r, c } = cellFromTd(td);
    td.classList.toggle('cell-selected', s.cells.has(key(r, c)));
    td.classList.toggle('cell-focus', !!s.focus && s.focus.r === r && s.focus.c === c);
  });
  const info = $('#cell-info');
  if (!info) return;
  if (s.cells.size <= 1) { info.textContent = ''; return; }
  let testo = `${s.cells.size} celle selezionate`;
  // Il riassunto si ricalcola a ogni movimento del trascinamento: oltre la
  // soglia si mostra il solo conteggio e i numeri restano nel pannello 📊,
  // che gira una volta sola.
  if (s.cells.size <= MAX_CELLE_RIASSUNTO) {
    const breve = riassuntoBreve(statistiche(valoriSelezionati()));
    if (breve) testo += ' · ' + breve;
  }
  info.textContent = testo;
}

// Valore testuale della cella come mostrato in griglia.
function cellText(r, c) {
  const doc = state.docs[r];
  const col = state.columns[c];
  if (!doc || col === undefined) return '';
  return doc[col] === undefined ? '' : displayValue(doc[col]).text;
}

// Valore grezzo (forma EJSON) della cella.
function cellRaw(r, c) {
  return state.docs[r]?.[state.columns[c]];
}

// Righe e colonne (ordinate) coinvolte nella selezione.
function selectionGrid() {
  const cells = [...sel().cells].map((k) => k.split(':').map(Number));
  const rows = [...new Set(cells.map(([r]) => r))].sort((a, b) => a - b);
  const cols = [...new Set(cells.map(([, c]) => c))].sort((a, b) => a - b);
  return { rows, cols };
}

// --- Statistiche della selezione -------------------------------------------

// Valori grezzi (EJSON) delle sole celle selezionate, nell'ordine di lettura.
function valoriSelezionati() {
  const { rows, cols } = selectionGrid();
  const has = sel().cells;
  const out = [];
  for (const r of rows) {
    for (const c of cols) {
      if (has.has(key(r, c))) out.push(cellRaw(r, c));
    }
  }
  return out;
}

// Gli stessi valori raggruppati per colonna: una selezione di più colonne va
// analizzata colonna per colonna, perché sommare importi e quantità insieme
// produce un totale che non significa nulla.
function valoriPerColonna() {
  const { rows, cols } = selectionGrid();
  const has = sel().cells;
  return cols.map((c) => ({
    nome: state.columns[c] ?? `col ${c}`,
    valori: rows.filter((r) => has.has(key(r, c))).map((r) => cellRaw(r, c)),
  }));
}

// Valore "grezzo" da copiare: il numero senza separatori italiani, cioè la
// forma che si può incollare in una query, in un foglio di calcolo inglese o in
// del codice. Quello mostrato (`216,2`) lì non sarebbe utilizzabile, quindi il
// pannello offre entrambi: clic = come lo vedi, Ctrl+clic = grezzo.
function grezzoDi(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? '' : String(n);
}

// Righe [etichetta, valore mostrato, valore grezzo] del riepilogo complessivo.
function righeRiepilogo(st) {
  const dec = Math.min(Math.max(st.decimali, 2), 6);
  const num = (v, d) => [formattaNumero(v, d), grezzoDi(v)];
  const conta = (v) => [String(v), String(v)];
  return [
    ['Celle selezionate', ...conta(st.celle)],
    ['Valori numerici', ...conta(st.numerici)],
    ['Non numerici', ...conta(st.nonNumerici)],
    ['Vuoti (null o "")', ...conta(st.vuote)],
    ['Valori distinti', ...conta(st.distinti)],
    ['Somma', ...num(st.somma, st.decimali)],
    ['Media', ...num(st.media, dec)],
    ['Mediana', ...num(st.mediana, dec)],
    ['Minimo', ...num(st.min, st.decimali)],
    ['Massimo', ...num(st.max, st.decimali)],
    ['Deviazione standard (campionaria)', ...num(st.devStd, dec)],
  ];
}

// TSV del pannello, per incollare il riepilogo in un foglio di calcolo.
function statsTsv(st, perCol) {
  const righe = righeRiepilogo(st).map(([k, v]) => `${k}\t${v}`);
  if (perCol.length > 1) {
    righe.push('');
    righe.push(['Colonna', 'n', 'Somma', 'Media', 'Mediana', 'Min', 'Max'].join('\t'));
    for (const c of perCol) {
      const dec = Math.min(Math.max(c.decimali, 2), 6);
      righe.push([
        c.nome, c.numerici,
        formattaNumero(c.somma, c.decimali), formattaNumero(c.media, dec),
        formattaNumero(c.mediana, dec), formattaNumero(c.min, c.decimali),
        formattaNumero(c.max, c.decimali),
      ].join('\t'));
    }
  }
  return righe.join('\n');
}

// Pannello 📊 con il riepilogo della selezione (costruito al volo come la
// modale di duplicazione: non esiste nel DOM finché non serve).
function showCellStats() {
  if (!sel().cells.size) { toast('Seleziona prima delle celle', true); return; }
  const valori = valoriSelezionati();
  const st = statistiche(valori);
  const perCol = statistichePerColonna(valoriPerColonna());

  let overlay = document.getElementById('cellstats-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'cellstats-overlay';
    overlay.className = 'overlay hidden';
    overlay.innerHTML = `
      <div class="modal">
        <h2>📊 Statistiche selezione</h2>
        <p class="hint" style="margin:0 0 8px">Clic su un valore per copiarlo · Ctrl+clic per il valore
          grezzo (senza separatori, da incollare in una query)</p>
        <div id="cellstats-body"></div>
        <div class="modal-actions">
          <button id="cellstats-copy" class="ghost">Copia riepilogo</button>
          <button id="cellstats-close" class="primary">Chiudi</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('cellstats-close').addEventListener('click', () => overlay.classList.add('hidden'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });
    // Copia del singolo valore: un gestore delegato una volta sola, perché il
    // corpo della modale viene riscritto a ogni apertura.
    document.getElementById('cellstats-body').addEventListener('click', (e) => {
      const td = e.target.closest('td[data-copia]');
      if (!td) return;
      const grezzo = (e.ctrlKey || e.metaKey) && td.dataset.grezzo;
      const testo = grezzo || td.dataset.copia;
      if (testo === '' || testo === '—') { toast('Nessun valore da copiare', true); return; }
      copyText(testo, `Copiato: ${testo}`);
    });
  }

  const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  const corpo = document.getElementById('cellstats-body');
  let html = '';
  if (!st.numerici) {
    html += `<p class="hint">Nessun valore numerico nella selezione: date, booleani e testo non
      vengono sommati (sarebbe un totale privo di significato).</p>`;
  }
  // Con più colonne il totale complessivo mescola grandezze diverse (importi e
  // quantità): resta perché è quello che fa un foglio di calcolo, ma va detto
  // che il confronto sensato è la tabella per colonna qui sotto.
  const multiCol = perCol.filter((c) => c.numerici > 0).length > 1;
  if (multiCol) {
    html += '<h3 style="margin:0 0 6px;font-size:0.9rem">Tutte le colonne insieme '
      + '<span class="hint">— somma di grandezze diverse: per il confronto usa la tabella per colonna</span></h3>';
  }
  // Ogni valore è copiabile con un clic: `data-copia` è quello mostrato,
  // `data-grezzo` la forma senza separatori (Ctrl+clic).
  const cellaValore = (mostrato, grezzo) => {
    const suggerimento = grezzo && grezzo !== mostrato
      ? `Clic per copiare «${mostrato}» · Ctrl+clic per ${grezzo}`
      : `Clic per copiare «${mostrato}»`;
    return `<td class="mono copiabile" data-copia="${esc(mostrato)}" data-grezzo="${esc(grezzo || '')}"`
      + ` title="${esc(suggerimento)}">${esc(mostrato)}</td>`;
  };

  html += '<table class="info-table kv-table"><tbody>'
    + righeRiepilogo(st).map(([k, v, g]) => `<tr><td>${esc(k)}</td>${cellaValore(v, g)}</tr>`).join('')
    + '</tbody></table>';
  if (perCol.length > 1) {
    html += '<h3 style="margin:14px 0 6px;font-size:0.9rem">Per colonna</h3>'
      + '<div style="max-height:220px;overflow:auto"><table class="info-table"><thead><tr>'
      + ['Colonna', 'n', 'Somma', 'Media', 'Mediana', 'Min', 'Max'].map((h) => `<th>${h}</th>`).join('')
      + '</tr></thead><tbody>'
      + perCol.map((c) => {
        const dec = Math.min(Math.max(c.decimali, 2), 6);
        const celle = [
          [String(c.numerici), String(c.numerici)],
          [formattaNumero(c.somma, c.decimali), grezzoDi(c.somma)],
          [formattaNumero(c.media, dec), grezzoDi(c.media)],
          [formattaNumero(c.mediana, dec), grezzoDi(c.mediana)],
          [formattaNumero(c.min, c.decimali), grezzoDi(c.min)],
          [formattaNumero(c.max, c.decimali), grezzoDi(c.max)],
        ];
        return `<tr><td>${esc(c.nome)}</td>` + celle.map(([v, g]) => cellaValore(v, g)).join('') + '</tr>';
      }).join('')
      + '</tbody></table></div>';
  }
  if (st.approssimato) {
    html += `<p class="hint" style="margin-top:10px">≈ I valori superano la precisione esatta di un
      numero JavaScript (oltre 2^53 o più di 15 cifre significative): i totali qui sopra sono
      arrotondati. Per un calcolo esatto usa un'aggregazione lato database.</p>`;
  }
  corpo.innerHTML = html;

  const oldCopy = document.getElementById('cellstats-copy');
  const newCopy = oldCopy.cloneNode(true);
  oldCopy.replaceWith(newCopy);
  newCopy.addEventListener('click', () => copyText(statsTsv(st, perCol), 'Riepilogo copiato'));

  overlay.classList.remove('hidden');
}

// TSV della selezione: le celle non selezionate dentro il rettangolo di
// contorno restano vuote, come farebbe Excel con una selezione sparsa.
function buildTsv(withHeaders) {
  const { rows, cols } = selectionGrid();
  const has = sel().cells;
  const lines = rows.map((r) =>
    cols.map((c) => (has.has(key(r, c)) ? cellText(r, c) : '')).join('\t')
  );
  if (withHeaders) lines.unshift(cols.map((c) => state.columns[c] ?? '').join('\t'));
  return lines.join('\n');
}

// JSON della selezione: una cella sola → il valore; una riga → oggetto;
// più righe → array di oggetti. I valori restano in forma EJSON.
function buildJson() {
  const { rows, cols } = selectionGrid();
  const has = sel().cells;
  if (rows.length === 1 && cols.length === 1) {
    const v = state.docs[rows[0]]?.[state.columns[cols[0]]];
    return typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 2);
  }
  const objs = rows.map((r) => {
    const obj = {};
    for (const c of cols) {
      if (has.has(key(r, c))) obj[state.columns[c]] = state.docs[r]?.[state.columns[c]] ?? null;
    }
    return obj;
  });
  return JSON.stringify(objs.length === 1 ? objs[0] : objs, null, 2);
}

function csvField(s) {
  s = String(s);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCsv(withHeaders) {
  const { rows, cols } = selectionGrid();
  const has = sel().cells;
  const lines = rows.map((r) =>
    cols.map((c) => (has.has(key(r, c)) ? csvField(cellText(r, c)) : '')).join(',')
  );
  if (withHeaders) lines.unshift(cols.map((c) => csvField(state.columns[c] ?? '')).join(','));
  return lines.join('\n');
}

function buildMarkdown() {
  const { rows, cols } = selectionGrid();
  const has = sel().cells;
  const mdEsc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const line = (vals) => '| ' + vals.join(' | ') + ' |';
  const out = [
    line(cols.map((c) => mdEsc(state.columns[c] ?? ''))),
    line(cols.map(() => '---')),
    ...rows.map((r) => line(cols.map((c) => (has.has(key(r, c)) ? mdEsc(cellText(r, c)) : '')))),
  ];
  return out.join('\n');
}

function sqlString(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// Letterale SQL (dialetto MySQL) da un valore EJSON.
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return sqlString(v);
  if (isPlainObject(v)) {
    if (v.$oid) return sqlString(v.$oid);
    if (v.$date !== undefined) {
      const iso = displayValue(v).text; // ISO oppure valore grezzo se data invalida
      return sqlString(/^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.slice(0, 10) + ' ' + iso.slice(11, 19) : iso);
    }
    if (v.$numberInt !== undefined || v.$numberLong !== undefined || v.$numberDouble !== undefined) {
      return String(v.$numberInt ?? v.$numberLong ?? v.$numberDouble);
    }
    if (v.$numberDecimal !== undefined) return String(v.$numberDecimal);
  }
  return sqlString(JSON.stringify(v)); // oggetti/array → JSON come stringa
}

function buildSqlInsert() {
  const { rows, cols } = selectionGrid();
  const has = sel().cells;
  const ident = (s) => '`' + String(s).replace(/`/g, '``') + '`';
  const values = rows.map((r) =>
    '(' + cols.map((c) => (has.has(key(r, c)) ? sqlLiteral(cellRaw(r, c)) : 'NULL')).join(', ') + ')'
  );
  return `INSERT INTO ${ident(state.coll || 'tabella')} (${cols.map((c) => ident(state.columns[c])).join(', ')}) VALUES\n`
    + values.join(',\n') + ';';
}

function downloadFile(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Duplica riga -----------------------------------------------------------

// Genera un ObjectId a 24 hex lato client (4B timestamp + 5B random + 3B counter),
// così il duplicato "con chiave" non collide con l'originale (evita E11000).
let oidCounter = Math.floor(Math.random() * 0xffffff);
function generateObjectId() {
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  let rnd = '';
  for (let i = 0; i < 10; i++) rnd += Math.floor(Math.random() * 16).toString(16);
  oidCounter = (oidCounter + 1) % 0x1000000;
  const cnt = oidCounter.toString(16).padStart(6, '0');
  return (ts + rnd + cnt).slice(0, 24);
}

// Apre un modal di conferma con preview/editor JSON del documento da inserire.
// `withKey`: se true mantiene la chiave nel documento; per MongoDB ne genera una
//            NUOVA (l'utente può comunque cambiarla) così il duplicato è valido
//            senza dover modificare a mano l'_id.
//            se false la rimuove (il DB genererà una nuova chiave).
function duplicateRow(rowIndex, withKey) {
  const doc = state.docs[rowIndex];
  if (!doc) { toast('Nessun documento selezionato', true); return; }

  const isSql = isSqlType(state.dbType);
  const rowWord = isSql ? 'riga' : 'documento';

  // Copia profonda escludendo o includendo la chiave primaria.
  const cloned = JSON.parse(JSON.stringify(doc));
  if (!withKey) {
    delete cloned._id; // MongoDB: nuova ObjectId auto; SQL: server genera la PK
  } else if (!isSql && cloned._id && typeof cloned._id === 'object' && cloned._id.$oid) {
    // MongoDB con _id ObjectId: rigenera una chiave nuova per evitare il
    // duplicate key error; resta modificabile dall'utente.
    cloned._id = { $oid: generateObjectId() };
  }
  const initialJson = JSON.stringify(cloned, null, 2);

  // Costruisce il modal on-the-fly (non esiste ancora nel DOM).
  const overlayId = 'duprow-overlay';
  let overlay = document.getElementById(overlayId);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.className = 'overlay hidden';
    overlay.innerHTML = `
      <div class="modal wide">
        <h2 id="duprow-title">Duplica riga</h2>
        <p id="duprow-desc" style="margin:0 0 8px;font-size:13px;color:var(--fg-dim,#888)"></p>
        <textarea id="duprow-json" rows="16" spellcheck="false"></textarea>
        <div id="duprow-error" class="error hidden"></div>
        <div class="modal-actions">
          <button id="duprow-cancel" class="ghost">Annulla</button>
          <button id="duprow-ok" class="primary">Inserisci duplicato</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    document.getElementById('duprow-cancel').addEventListener('click', () => {
      overlay.classList.add('hidden');
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  }

  // Popola e mostra.
  const title = withKey
    ? `Duplica ${rowWord} (con chiave)`
    : `Duplica ${rowWord} (senza chiave)`;
  const desc = withKey
    ? (isSql
        ? `Modifica la chiave nel JSON qui sotto (dev'essere univoca), poi conferma l'inserimento.`
        : `È stata generata una nuova chiave (selezionata qui sotto): modificala se vuoi, poi conferma.`)
    : `Verifica il JSON del duplicato — la chiave è stata rimossa e verrà generata automaticamente.`;
  document.getElementById('duprow-title').textContent = title;
  document.getElementById('duprow-desc').textContent = desc;
  const ta = document.getElementById('duprow-json');
  ta.value = initialJson;
  const errEl = document.getElementById('duprow-error');
  errEl.classList.add('hidden');
  overlay.classList.remove('hidden');
  ta.focus();

  // UX: la textarea deve mostrare la prima riga (dove sta l'_id da cambiare),
  // non restare scrollata dopo il focus. Con chiave, pre-seleziona il valore
  // dell'_id così l'utente può digitare subito la nuova chiave.
  ta.scrollTop = 0;
  if (withKey) {
    // ObjectId: seleziona il valore hex di "$oid"; altrimenti il valore di "_id".
    const m = /"\$oid"\s*:\s*"([0-9a-fA-F]{24})"/.exec(initialJson)
           || /"_id"\s*:\s*/.exec(initialJson);
    if (m && m[1] !== undefined) {
      const start = m.index + m[0].indexOf(m[1]);
      ta.setSelectionRange(start, start + m[1].length);
    } else if (m) {
      let start = m.index + m[0].length;
      // Estende la selezione all'intero valore (stringa fra apici o token grezzo).
      let end = start;
      if (initialJson[start] === '"') {
        end = initialJson.indexOf('"', start + 1);
        end = end === -1 ? initialJson.length : end + 1;
      } else {
        while (end < initialJson.length && !/[,\n}]/.test(initialJson[end])) end++;
      }
      ta.setSelectionRange(start, end);
    } else {
      ta.setSelectionRange(0, 0);
    }
  } else {
    ta.setSelectionRange(0, 0);
  }

  // Sostituisce il listener del bottone OK ad ogni apertura.
  const oldOk = document.getElementById('duprow-ok');
  const newOk = oldOk.cloneNode(true);
  oldOk.replaceWith(newOk);
  newOk.addEventListener('click', () => {
    let parsed;
    try {
      parsed = JSON.parse(ta.value);
    } catch (ex) {
      errEl.textContent = 'JSON non valido: ' + ex.message;
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');
    emit('doc:insert', {
      db: state.db,
      coll: state.coll,
      doc: JSON.stringify(parsed),
    }).then((res) => {
      overlay.classList.add('hidden');
      toast(isSql ? 'Riga duplicata' : 'Documento duplicato');
      // runQuery rilegge dagli input del workspace: solo se il tab è ancora quello.
      if (isForActiveTab(res)) runQuery({ auto: true });
    }).catch((err) => {
      errEl.textContent = friendlyInsertError(err.message);
      errEl.classList.remove('hidden');
    });
  });
}

// Traduce l'errore di chiave duplicata (E11000) in un messaggio comprensibile
// che indica quale indice e quali campi vanno resi univoci prima di duplicare.
function friendlyInsertError(msg) {
  const fallback = msg || 'Errore durante l\'inserimento';
  if (!msg || !/E11000|duplicate key/i.test(msg)) return fallback;
  const idxM = /index:\s*([^\s]+)/i.exec(msg);
  const keyM = /dup key:\s*(\{[\s\S]*\})/i.exec(msg);
  let out = 'Chiave duplicata: esiste già un documento con gli stessi valori';
  if (idxM) out += ` per l'indice unico "${idxM[1]}"`;
  out += '.';
  if (keyM) out += ` Valori in conflitto: ${keyM[1]}.`;
  out += ' Modifica i campi indicati per renderli univoci, poi riprova.';
  return out;
}

function copyToClipboard(text) {
  const n = sel().cells.size;
  copyText(text, n === 1 ? 'Cella copiata' : `${n} celle copiate`);
}

function copyText(text, messaggio) {
  const done = () => toast(messaggio);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => toast('Copia non riuscita', true));
  } else {
    // Fallback per contesti senza API clipboard (es. http non-localhost).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  }
}

function inputFocused() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function gridVisible() {
  return !$('#view-data').classList.contains('hidden') && state.docs.length > 0;
}

// Selezione al mousedown, in base ai modificatori.
function selectFrom(cell, { shift, ctrl }) {
  const s = sel();
  if (shift && s.anchor) {
    s.cells = new Set(rectKeys(s.anchor, cell));
  } else if (ctrl) {
    const k = key(cell.r, cell.c);
    if (s.cells.has(k)) s.cells.delete(k);
    else s.cells.add(k);
    s.anchor = cell;
  } else {
    s.cells = new Set([key(cell.r, cell.c)]);
    s.anchor = cell;
  }
  s.focus = cell;
}

// --- Incolla da Excel -------------------------------------------------------

// Parser TSV degli appunti (formato di Excel/Sheets): le celle che contengono
// TAB o a-capo vengono racchiuse tra virgolette con "" come escape del ".
// Un semplice split('\n')/split('\t') spezzerebbe quelle celle in più
// celle/righe, scrivendo dati corrotti. La macchina a stati qui sotto rispetta
// il quoting; per il testo senza virgolette il risultato è identico allo split.
function parseClipboardGrid(text) {
  const src = String(text).replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } // "" → " letterale
        else inQuotes = false;                          // fine cella quotata
      } else {
        field += ch; // TAB e a-capo dentro le virgolette fanno parte della cella
      }
      continue;
    }
    if (ch === '"' && field === '') inQuotes = true; // virgoletta solo a inizio cella
    else if (ch === '\t') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  row.push(field);
  rows.push(row);
  // Scarta le righe vuote finali (come faceva la versione a split): una riga con
  // la sola cella vuota, tipica del \n di chiusura.
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

// Converte il testo incollato provando a rispettare il tipo del valore
// attuale della cella (numero, data, bool, ObjectId...); altrimenti la
// semantica è quella dell'editor inline generico (parseEdited).
function coercePasted(current, text) {
  const type = valueType(current);
  const t = text.trim();
  if (type === 'number' && t !== '' && !Number.isNaN(Number(t))) return Number(t);
  if (type === 'decimal' && t !== '' && !Number.isNaN(Number(t))) return { $numberDecimal: t };
  if (type === 'bool') {
    if (['true', '1', 'sì', 'si', 'vero'].includes(t.toLowerCase())) return true;
    if (['false', '0', 'no', 'falso'].includes(t.toLowerCase())) return false;
  }
  if (type === 'date') {
    const d = new Date(t);
    if (t !== '' && !Number.isNaN(d.getTime())) return { $date: d.toISOString() };
  }
  if (type === 'oid' && /^[0-9a-fA-F]{24}$/.test(t)) return { $oid: t };
  return parseEdited(text);
}

// Incolla una griglia TSV (formato appunti di Excel) a partire dall'angolo in
// alto a sinistra della selezione, aggiornando i documenti sottostanti.
function pasteIntoGrid(text) {
  const grid = parseClipboardGrid(text || '');
  if (!grid.length) return;
  if ($('#query-mode').value === 'aggregate') {
    toast('Incolla non disponibile in modalità aggregate/SQL Raw', true);
    return;
  }
  const s = sel();
  const { rows: selRows, cols: selCols } = selectionGrid();
  const start = selRows.length ? { r: selRows[0], c: selCols[0] } : s.focus;
  if (!start) {
    toast('Seleziona prima la cella di partenza', true);
    return;
  }

  const updates = [];
  let cellsCount = 0;
  let skipped = 0; // celle fuori pagina, su _id o su righe senza _id
  grid.forEach((line, i) => {
    const doc = state.docs[start.r + i];
    if (!doc || !('_id' in doc)) {
      skipped += line.length;
      return;
    }
    const set = {};
    let any = false;
    line.forEach((value, j) => {
      const col = state.columns[start.c + j];
      if (col === undefined || col === '_id') {
        skipped++;
        return;
      }
      set[col] = coercePasted(doc[col], value);
      any = true;
      cellsCount++;
    });
    if (any) updates.push({ id: idOf(doc), set });
  });

  if (!updates.length) {
    toast('Nessuna cella aggiornabile a partire da qui', true);
    return;
  }
  const docWord = state.dbType === 'mysql' ? 'righe' : 'documenti';
  let msg = `Incollare ${cellsCount} celle in ${updates.length} ${docWord}?`;
  if (skipped) msg += `\n(${skipped} celle verranno ignorate: fuori pagina o sulla colonna _id)`;
  if (!confirm(msg)) return;

  // L'incolla può durare a lungo: il contesto (tab + coll-tab) va catturato ora,
  // non alla risposta, o la selezione e il refresh finirebbero su un'altra
  // tabella se l'utente si sposta nel frattempo.
  const origin = captureContext();
  // Le scritture partono a ONDATE, non tutte insieme (CDB-51): incollare da un
  // foglio di calcolo può produrre centinaia di `doc:update`, e mandarli in un
  // colpo solo riempie la coda del socket e satura il pool di connessioni della
  // sessione — le letture della stessa connessione (e degli altri tab) restano
  // in attesa dietro di esse. Il limite non rallenta i casi piccoli, che
  // rientrano tutti nella prima ondata.
  eseguiAOndate(updates, 8, (u) =>
    emit('doc:update', { db: state.db, coll: state.coll, id: u.id, set: u.set })
  ).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) toast(`${results.length - failed.length} aggiornati, ${failed.length} falliti: ${failed[0].reason.message}`, true);
    else toast(`${cellsCount} celle incollate in ${updates.length} ${docWord}`);
    if (!origin.isStillActive()) return; // le righe sono scritte: nulla da ridipingere qui
    // Lascia selezionata l'area incollata (ri-applicata dal render di runQuery).
    const width = Math.max(...grid.map((l) => l.length));
    s.anchor = { r: start.r, c: start.c };
    s.focus = {
      r: Math.min(start.r + grid.length - 1, state.docs.length - 1),
      c: Math.min(start.c + width - 1, state.columns.length - 1),
    };
    s.cells = new Set(rectKeys(s.anchor, s.focus));
    runQuery({ auto: true }); // refresh post-scrittura (incolla celle)
  });
}

// --- Selezione di intere colonne dall'header --------------------------------

function selectColumn(c, { ctrl, shift }) {
  const s = sel();
  const lastRow = state.docs.length - 1;
  if (lastRow < 0) return;
  const colKeys = rectKeys({ r: 0, c }, { r: lastRow, c });
  if (shift && s.anchor) {
    s.cells = new Set(rectKeys(
      { r: 0, c: Math.min(s.anchor.c, c) },
      { r: lastRow, c: Math.max(s.anchor.c, c) }
    ));
  } else if (ctrl) {
    // Toggle: se la colonna è già tutta selezionata la deseleziona.
    if (colKeys.every((k) => s.cells.has(k))) colKeys.forEach((k) => s.cells.delete(k));
    else colKeys.forEach((k) => s.cells.add(k));
    s.anchor = { r: 0, c };
  } else {
    s.cells = new Set(colKeys);
    s.anchor = { r: 0, c };
  }
  s.focus = { r: 0, c };
}

function focusCellIntoView() {
  const f = sel().focus;
  if (!f) return;
  // In virtualizzazione la riga potrebbe non essere nel DOM: la renderizza.
  ensureRowRendered(f.r);
  const td = document.querySelector(`#grid tbody td[data-r="${f.r}"][data-c="${f.c}"]`);
  td?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function initCellSelect() {
  const tbody = $('#grid tbody');

  // Il riassunto nella barra di stato è anche la porta d'ingresso al pannello:
  // chi vede "Σ …" lì è esattamente chi vuole mediana, distinti e per-colonna.
  const info = $('#cell-info');
  if (info) {
    info.title = 'Statistiche della selezione (mediana, distinti, per colonna…)';
    info.addEventListener('click', () => { if (sel().cells.size) showCellStats(); });
  }

  let dragging = false;
  let dragBase = null; // celle già selezionate prima del drag (Ctrl+trascina = aggiunge)

  tbody.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const td = e.target.closest('td[data-c]');
    if (!td || td.classList.contains('editing')) return;
    const cell = cellFromTd(td);
    const ctrl = e.ctrlKey || e.metaKey;
    selectFrom(cell, { shift: e.shiftKey, ctrl });
    dragging = true;
    dragBase = ctrl ? new Set(sel().cells) : null;
    applyCellSelection();
  });

  tbody.addEventListener('mouseover', (e) => {
    if (!dragging) return;
    const td = e.target.closest('td[data-c]');
    if (!td) return;
    const s = sel();
    if (!s.anchor) return;
    const cell = cellFromTd(td);
    s.focus = cell;
    const rect = rectKeys(s.anchor, cell);
    s.cells = dragBase ? new Set([...dragBase, ...rect]) : new Set(rect);
    applyCellSelection();
  });

  document.addEventListener('mouseup', () => {
    dragging = false;
    dragBase = null;
  });

  // Ctrl/Shift+click sull'header: selezione dell'intera colonna (il click
  // semplice continua a ordinare, vedi renderGrid).
  $('#grid thead').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const th = e.target.closest('th[data-c]');
    if (!th) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl && !e.shiftKey) return;
    e.preventDefault();
    selectColumn(Number(th.dataset.c), { ctrl, shift: e.shiftKey });
    applyCellSelection();
  });

  tbody.addEventListener('contextmenu', (e) => {
    const td = e.target.closest('td[data-c]');
    if (!td) return;
    e.preventDefault();
    const cell = cellFromTd(td);
    // Tasto destro fuori dalla selezione: seleziona la cella cliccata.
    if (!sel().cells.has(key(cell.r, cell.c))) {
      selectFrom(cell, { shift: false, ctrl: false });
      applyCellSelection();
    }
    const { x, y } = { x: e.clientX, y: e.clientY };
    // Sotto-menu drill-down: riapre il menu contestuale con i formati.
    // (setTimeout: il click che chiude il menu padre non deve chiudere anche questo)
    const advanced = () => setTimeout(() => showContextMenu(x, y, [
      { label: 'JSON', action: () => copyToClipboard(buildJson()) },
      { label: 'CSV (con intestazioni)', action: () => copyToClipboard(buildCsv(true)) },
      { label: 'TSV con intestazioni', action: () => copyToClipboard(buildTsv(true)) },
      { label: 'Markdown', action: () => copyToClipboard(buildMarkdown()) },
      { label: 'SQL INSERT (MySQL)', action: () => copyToClipboard(buildSqlInsert()) },
    ]), 0);
    showContextMenu(x, y, [
      { label: 'Copia (Ctrl+C)', action: () => copyToClipboard(buildTsv(false)) },
      { label: 'Copia con intestazioni', action: () => copyToClipboard(buildTsv(true)) },
      { label: 'Copia avanzato ▸', action: advanced },
      '---',
      { label: '📊 Statistiche selezione…', action: showCellStats },
      '---',
      {
        label: 'Duplica riga ▸',
        action: () => setTimeout(() => {
          const { rows } = selectionGrid();
          const r = rows.length ? rows[0] : sel().focus?.r;
          if (r == null) { toast('Seleziona prima una riga', true); return; }
          showContextMenu(x, y, [
            { label: 'Senza chiave (nuova generata)', action: () => duplicateRow(r, false) },
            { label: 'Con chiave personalizzabile',   action: () => duplicateRow(r, true)  },
          ]);
        }, 0),
      },
      '---',
      {
        label: 'Incolla (Ctrl+V)',
        action: () => navigator.clipboard?.readText
          ? navigator.clipboard.readText().then(pasteIntoGrid).catch(() => toast('Appunti non accessibili: usa Ctrl+V', true))
          : toast('Appunti non accessibili: usa Ctrl+V', true),
      },
      '---',
      { label: 'Esporta selezione in CSV…', action: () => downloadFile(`${state.coll || 'selezione'}.csv`, buildCsv(true), 'text/csv') },
    ]);
  });

  // Incolla da Excel: l'evento 'paste' dà accesso agli appunti senza permessi.
  document.addEventListener('paste', (e) => {
    if (inputFocused() || !gridVisible()) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    pasteIntoGrid(text);
  });

  document.addEventListener('keydown', (e) => {
    if (inputFocused() || !gridVisible()) return;
    const s = sel();

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      // Una selezione di testo nativa (es. nella statusbar) ha la precedenza.
      if (s.cells.size === 0 || !document.getSelection().isCollapsed) return;
      e.preventDefault();
      copyToClipboard(buildTsv(false));
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      s.cells = new Set(rectKeys({ r: 0, c: 0 }, { r: state.docs.length - 1, c: state.columns.length - 1 }));
      s.anchor = { r: 0, c: 0 };
      s.focus = { r: state.docs.length - 1, c: state.columns.length - 1 };
      applyCellSelection();
      return;
    }

    if (e.key === 'Escape' && s.cells.size > 0) {
      clearCellSelection();
      applyCellSelection();
      return;
    }

    const deltas = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (e.key in deltas && s.focus) {
      e.preventDefault();
      const [dr, dc] = deltas[e.key];
      const next = {
        r: Math.min(Math.max(s.focus.r + dr, 0), state.docs.length - 1),
        c: Math.min(Math.max(s.focus.c + dc, 0), state.columns.length - 1),
      };
      if (e.shiftKey && s.anchor) {
        s.focus = next;
        s.cells = new Set(rectKeys(s.anchor, next));
      } else {
        selectFrom(next, { shift: false, ctrl: false });
      }
      applyCellSelection();
      focusCellIntoView();
    }
  });
}

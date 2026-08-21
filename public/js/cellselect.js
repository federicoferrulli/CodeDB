'use strict';

import { state } from './state.js';
import { $, emit, displayValue, toast, showContextMenu, idOf, parseEdited, valueType, isPlainObject, isSqlType, captureContext, eseguiAOndate, marcaDatiSporchi } from './utils.js';
import { runQuery, ensureRowRendered, deleteDoc, deleteDocs } from './grid.js';
import { openEditDoc } from './inlineEdit.js';
import { formattaNumero, riassuntoBreve } from './cell-stats.js';
// Il calcolo vero passa da `calcoli.js`: sotto le 50.000 celle gira qui come
// prima, sopra su un Web Worker. Il modulo puro resta la sola implementazione.
import { statisticheAsync, statistichePerColonnaAsync, sequenziatore } from './calcoli.js';
import { statisticheGeo, riassuntoGeoBreve } from './geo-stats.js';
import { apriMappaSelezione } from './geomulti.js';
import { apriGraficoSelezione } from './cellgrafico.js';
// Lo scorrimento automatico ai bordi durante il trascinamento: il calcolo della
// velocità sta in un modulo puro, così è verificabile senza DOM.
import { velocitaAsse, BORDO_DEFAULT } from './scorrimento-bordo.js';
// Come si scrive il nome di una tabella o di una colonna: regola unica,
// condivisa col server (vedi public/js/identificatori.mjs).
import { quotaSempre, quotaQualificato, dialettoDi } from './identificatori.mjs';

// Selezione di celle stile Excel sulla griglia dati: click, trascinamento
// rettangolare, Shift+click (estende dall'ancora), Ctrl+click (aggiunge/toglie),
// Ctrl+click sull'header (seleziona la colonna), frecce (con Shift estendono),
// Ctrl+A, copia negli appunti (Ctrl+C in TSV; dal menu contestuale anche JSON,
// CSV, Markdown, SQL INSERT), incolla da Excel (Ctrl+V, aggiorna i documenti),
// esportazione CSV della selezione, STATISTICHE dei valori numerici (somma,
// media, mediana, min, max… nella barra di stato e nel pannello 📊, calcolate
// dal modulo puro `cell-stats.js`) e GRAFICO delle celle selezionate (📈, che
// disegna con `cellgrafico.js` ciò che `cell-chart.js` deduce dalla selezione).
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
//
// La soglia è rimasta anche dopo il passaggio al Web Worker: il calcolo non
// pesa più sul thread che disegna, ma la copia dei dati verso l'altro thread sì
// — e farla a ogni fotogramma di un trascinamento su mezzo milione di celle
// sarebbe un lavoro inutile. Il pannello 📊, che gira una volta sola, non ha
// alcun tetto: lì i numeri si calcolano sempre, semplicemente altrove.
const MAX_CELLE_RIASSUNTO = 20000;

// Il riassunto è asincrono: durante un trascinamento partono molte richieste e
// l'ultima a rispondere non è per forza l'ultima chiesta.
const seqRiassunto = sequenziatore();

// Vero mentre una selezione si sta trascinando (mouse o dito), compreso il
// tempo in cui la griglia scorre da sola sotto il puntatore. Lo leggono le
// chiamate di `applyCellSelection` che arrivano da fuori, per non pagare il
// riassunto completo a ogni fotogramma.
let trascinandoSelezione = false;

// Ri-applica le classi CSS della selezione dopo un render della griglia,
// scartando le celle ormai fuori dai limiti della pagina corrente.
export function applyCellSelection({ leggero = false } = {}) {
  const s = sel();
  // Chi chiama non sa sempre di essere dentro un trascinamento: mentre la
  // selezione si allarga con lo scorrimento automatico, la griglia rifà da sé
  // la finestra virtuale e ri-applica la selezione (renderVirtualWindow in
  // grid.js). Quella chiamata è "pesante" per definizione, e cadrebbe più volte
  // al secondo proprio sul telefono, dove costa di più. Finché il dito o il
  // mouse tirano, il riassunto resta leggero comunque.
  if (trascinandoSelezione) leggero = true;
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
  const base = `${s.cells.size} celle selezionate`;

  // Una selezione di geometrie non ha numeri da sommare: il riassunto utile è
  // un altro (quante, di che tipo, quanto estese) e sta nello stesso posto.
  // NON durante il trascinamento (`leggero`): misurare lunghezze e aree
  // significa una haversine per lato, e su una colonna di poligoni reali sono
  // decine di migliaia di radici quadrate per fotogramma — cioè la selezione
  // che si muove a scatti mentre la si trascina. A rilascio avvenuto si
  // calcola una volta sola.
  let codaGeo = '';
  if (s.cells.size <= MAX_CELLE_RIASSUNTO && !leggero) {
    const breveGeo = riassuntoGeoBreve(statisticheGeo(vociSelezionate()));
    if (breveGeo) codaGeo = ' · ' + breveGeo;
  }
  // Il conteggio si scrive SUBITO: i numeri possono arrivare da un altro
  // thread un istante dopo, ma l'utente deve vedere immediatamente che la
  // selezione è cambiata.
  info.textContent = base + codaGeo;

  // Il riassunto si ricalcola a ogni movimento del trascinamento: oltre la
  // soglia si mostra il solo conteggio e i numeri restano nel pannello 📊,
  // che gira una volta sola.
  if (s.cells.size > MAX_CELLE_RIASSUNTO) return;

  const token = seqRiassunto.nuovo();
  statisticheAsync(valoriSelezionati()).then((st) => {
    // Selezione cambiata nel frattempo: questo risultato descrive celle che non
    // sono più quelle scelte, e scriverlo sarebbe peggio del silenzio.
    if (!seqRiassunto.attuale(token)) return;
    const breve = riassuntoBreve(st);
    info.textContent = base + (breve ? ' · ' + breve : '') + codaGeo;
  }).catch(() => {
    // Qui il silenzio è la risposta giusta: il conteggio delle celle è già
    // scritto, e un errore in una riga di stato che si aggiorna da sola
    // sarebbe rumore su un'informazione accessoria.
  });
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

// Le stesse celle con la loro PROVENIENZA (colonna e riga): la mappa della
// selezione deve poter dire da dove viene ogni forma disegnata, altrimenti
// trovare il dato sbagliato che si è appena visto in mezzo all'oceano
// significherebbe cercarlo a mano nella griglia.
function vociSelezionate() {
  const { rows, cols } = selectionGrid();
  const has = sel().cells;
  const out = [];
  for (const r of rows) {
    for (const c of cols) {
      if (has.has(key(r, c))) out.push({ valore: cellRaw(r, c), colonna: state.columns[c] ?? '', riga: r });
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
async function showCellStats() {
  if (!sel().cells.size) { toast('Seleziona prima delle celle', true); return; }
  const valori = valoriSelezionati();
  // Qui non c'è nessun tetto: su una selezione enorme i due calcoli finiscono
  // sul Web Worker (vedi calcoli.js) e la finestra resta viva nel frattempo.
  const [st, perCol] = await Promise.all([
    statisticheAsync(valori),
    statistichePerColonnaAsync(valoriPerColonna()),
  ]);

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
          <button id="cellstats-chart" class="ghost">📈 Grafico</button>
          <button id="cellstats-copy" class="ghost">Copia riepilogo</button>
          <button id="cellstats-close" class="primary">Chiudi</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('cellstats-close').addEventListener('click', () => overlay.classList.add('hidden'));
    // Chi guarda i numeri della selezione è esattamente chi potrebbe volerne la
    // forma: il grafico si apre da qui senza rifare la strada dal menu del tasto
    // destro. Il pannello si chiude, altrimenti resterebbe sotto la finestra del
    // grafico con i suoi numeri visibili ai bordi.
    document.getElementById('cellstats-chart').addEventListener('click', () => {
      overlay.classList.add('hidden');
      mostraGraficoSelezione();
    });
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

// --- Mappa della selezione --------------------------------------------------

// Quante geometrie ci sono nella selezione (per decidere cosa offrire nel menu
// e dove porta il clic sulla barra di stato).
function contaGeometrieSelezionate() {
  return statisticheGeo(vociSelezionate()).totale;
}

// Titolo comune alle finestre che mostrano la selezione (mappa e grafico): da
// dove vengono questi dati, senza scrivere venti nomi di colonna.
function titoloSelezione() {
  const { cols } = selectionGrid();
  const nomi = cols.map((c) => state.columns[c]).filter(Boolean);
  return [state.coll, nomi.length <= 3 ? nomi.join(', ') : `${nomi.length} colonne`].filter(Boolean).join(' · ');
}

function mostraMappaSelezione() {
  if (!sel().cells.size) { toast('Seleziona prima delle celle', true); return; }
  apriMappaSelezione({ voci: vociSelezionate(), titolo: titoloSelezione() });
}

// --- Grafico della selezione ------------------------------------------------

function mostraGraficoSelezione() {
  if (!sel().cells.size) { toast('Seleziona prima delle celle', true); return; }
  apriGraficoSelezione({ voci: vociSelezionate(), titolo: titoloSelezione() });
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
    const obj = Object.create(null);
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
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Letterale SQL standard da un valore EJSON, valido su MySQL e PostgreSQL.
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
  // Come si scrive un identificatore lo sa un modulo solo, condiviso col
  // server: qui si quota SEMPRE, perche' l'INSERT finisce negli appunti e da
  // li' in un editor qualsiasi, dove non si sa che nome incontrera'.
  const postgres = dialettoDi(state.dbType) === 'postgresql';
  const ident = (s) => quotaSempre(s, state.dbType || 'mysql');
  const table = quotaQualificato(
    [postgres ? state.db : null, state.coll || 'tabella'],
    state.dbType || 'mysql'
  );
  const values = rows.map((r) =>
    '(' + cols.map((c) => (has.has(key(r, c)) ? sqlLiteral(cellRaw(r, c)) : 'NULL')).join(', ') + ')'
  );
  return 'INSERT INTO ' + table + ' (' + cols.map((c) => ident(state.columns[c])).join(', ') + ') VALUES\n'
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
//
// La copia identica di una riga non e' inseribile appena c'e' una chiave: prima
// toccava all'utente togliere l'`_id` a mano, o indovinare quale colonna unica
// stava facendo fallire l'INSERT, davanti a un editor JSON. Ora il documento da
// inserire lo calcola il server (`doc:duplicate` -> `duplicatePlan`), che i
// vincoli li legge dal database:
//   - senza chiavi: primaria e colonne uniche generate dal DBMS, azzerate o
//     ricalcolate;
//   - con chiavi:   resta tutto tranne la primaria, che e' sempre nuova.
// L'editor rimane come terza voce, per chi vuole comunque metterci mano.

function parolaRiga(isSql, n) {
  if (isSql) return n === 1 ? 'riga' : 'righe';
  return n === 1 ? 'documento' : 'documenti';
}

// Le note del server (chiavi svuotate, valori ricalcolati, avvisi) sono la sola
// spiegazione di che cosa e' cambiato rispetto all'originale: senza, il
// duplicato sembra identico e non lo e'.
function messaggioEsito(testa, note) {
  const elenco = [...note].slice(0, 3);
  return elenco.length ? `${testa} — ${elenco.join(' ')}` : testa;
}

/**
 * Duplica subito le righe indicate, senza passare da un editor.
 * Una richiesta per volta e in ordine: il valore nuovo di una chiave si calcola
 * dal MAX gia' presente, e due duplicati in parallelo lo leggerebbero uguale.
 */
function duplicaRighe(docs, conChiavi) {
  if (!docs.length) { toast('Nessuna riga selezionata', true); return; }
  const origin = captureContext();
  const { tabId, st } = origin;
  const bersaglio = { tabId, db: st.db, coll: st.coll };
  const isSql = isSqlType(st.dbType);
  const note = new Set();
  let fatte = 0;

  const passo = (i) => {
    if (i >= docs.length) return Promise.resolve();
    return emit('doc:duplicate', {
      ...bersaglio,
      doc: JSON.stringify(docs[i]),
      conChiavi,
    }).then((res) => {
      fatte++;
      for (const n of res.note || []) note.add(n);
      return passo(i + 1);
    });
  };

  passo(0).then(() => {
    const suffisso = fatte === 1 ? (isSql ? 'a' : 'o') : (isSql ? 'e' : 'i');
    toast(messaggioEsito(`${fatte} ${parolaRiga(isSql, fatte)} duplicat${suffisso}`, note));
  }).catch((err) => {
    // Parziale: le prime sono gia' state scritte, dirlo evita che l'utente
    // ritenti dall'inizio e si ritrovi con dei doppioni in piu'.
    const testa = fatte
      ? `Duplicate ${fatte} di ${docs.length}, poi errore: ${friendlyInsertError(err.message)}`
      : friendlyInsertError(err.message);
    toast(testa, true);
  }).then(() => {
    if (!fatte) return;
    // runQuery rilegge dagli input del workspace: solo se il tab e' ancora quello.
    if (origin.isStillActive()) runQuery({ auto: true });
    else marcaDatiSporchi(origin, bersaglio.db, bersaglio.coll);
  });
}

/**
 * Duplica con revisione: il server calcola lo stesso documento delle due voci
 * dirette (`soloAnteprima`), l'utente lo corregge e conferma. La casella
 * "mantieni le altre chiavi" ricalcola l'anteprima, perche' la differenza fra
 * le due modalita' la decide il server, non il testo nella textarea.
 */
function duplicaConEditor(doc, conChiaviIniziale) {
  const origin = captureContext();
  const { tabId, st } = origin;
  const bersaglio = { tabId, db: st.db, coll: st.coll };
  const isSql = isSqlType(st.dbType);
  const rowWord = parolaRiga(isSql, 1);

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
        <label style="display:flex;gap:6px;align-items:center;margin:0 0 8px;font-size:13px">
          <input type="checkbox" id="duprow-chiavi"> Mantieni le altre chiavi (cambia solo la primaria)
        </label>
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

  const ta = document.getElementById('duprow-json');
  const errEl = document.getElementById('duprow-error');
  const descEl = document.getElementById('duprow-desc');
  const chiaviEl = document.getElementById('duprow-chiavi');
  document.getElementById('duprow-title').textContent = `Duplica ${rowWord}`;
  chiaviEl.checked = conChiaviIniziale === true;
  errEl.classList.add('hidden');
  ta.value = '';
  overlay.classList.remove('hidden');

  // Anteprima: la calcola il server. Finche' non arriva, la textarea resta
  // vuota e disabilitata - un JSON modificabile che poi viene sovrascritto
  // dalla risposta farebbe perdere le modifiche appena scritte.
  const caricaAnteprima = () => {
    ta.disabled = true;
    descEl.textContent = 'Calcolo del duplicato…';
    return emit('doc:duplicate', {
      ...bersaglio,
      doc: JSON.stringify(doc),
      conChiavi: chiaviEl.checked,
      soloAnteprima: true,
    }).then((res) => {
      ta.disabled = false;
      ta.value = JSON.stringify(JSON.parse(res.doc), null, 2);
      descEl.textContent = messaggioEsito("Controlla il duplicato, poi conferma l'inserimento.", res.note || []);
      ta.scrollTop = 0;
      ta.focus();
      ta.setSelectionRange(0, 0);
    }).catch((err) => {
      ta.disabled = false;
      descEl.textContent = '';
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    });
  };

  chiaviEl.onchange = () => { errEl.classList.add('hidden'); caricaAnteprima(); };
  caricaAnteprima();

  // Sostituisce il listener del bottone OK ad ogni apertura. Il bersaglio e'
  // congelato all'APERTURA, non letto al clic (stesso motivo di CDB-A18): la
  // modale resta aperta quanto l'utente vuole e nel frattempo puo' cambiare
  // tab, mentre `state` punta sempre a quello attivo.
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
      ...bersaglio,
      doc: JSON.stringify(parsed),
    }).then(() => {
      overlay.classList.add('hidden');
      toast(isSql ? 'Riga duplicata' : 'Documento duplicato');
      if (origin.isStillActive()) runQuery({ auto: true });
      else marcaDatiSporchi(origin, bersaglio.db, bersaglio.coll);
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
    const set = Object.create(null);
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
  const docWord = isSqlType(state.dbType) ? 'righe' : 'documenti';
  let msg = `Incollare ${cellsCount} celle in ${updates.length} ${docWord}?`;
  if (skipped) msg += `\n(${skipped} celle verranno ignorate: fuori pagina o sulla colonna _id)`;
  if (!confirm(msg)) return;

  // L'incolla può durare a lungo: il contesto (tab + coll-tab) va catturato ora,
  // non alla risposta, o la selezione e il refresh finirebbero su un'altra
  // tabella se l'utente si sposta nel frattempo.
  const origin = captureContext();
  // Il BERSAGLIO va congelato insieme al contesto, non riletto a ogni richiesta
  // (CDB-A18). `state` è un Proxy sul tab ATTIVO e `emit()` inietta il tab
  // attivo al momento della chiamata: siccome le ondate distribuiscono le
  // scritture nel tempo, cambiare tab a metà incolla dirottava le rimanenti su
  // un'altra connessione, con gli id presi però dalle righe di questa. È lo
  // stesso motivo per cui exportimport.js passa un tabId esplicito a ogni blocco.
  const { tabId, st } = origin;
  const bersaglio = { tabId, db: st.db, coll: st.coll };
  // Le scritture partono a ONDATE, non tutte insieme (CDB-51): incollare da un
  // foglio di calcolo può produrre centinaia di `doc:update`, e mandarli in un
  // colpo solo riempie la coda del socket e satura il pool di connessioni della
  // sessione — le letture della stessa connessione (e degli altri tab) restano
  // in attesa dietro di esse. Il limite non rallenta i casi piccoli, che
  // rientrano tutti nella prima ondata.
  eseguiAOndate(updates, 8, (u) =>
    emit('doc:update', { ...bersaglio, id: u.id, set: u.set })
  ).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) toast(`${results.length - failed.length} aggiornati, ${failed.length} falliti: ${failed[0].reason.message}`, true);
    else toast(`${cellsCount} celle incollate in ${updates.length} ${docWord}`);
    if (!origin.isStillActive()) {
      marcaDatiSporchi(origin, bersaglio.db, bersaglio.coll);
      return; // le righe sono scritte: nulla da ridipingere qui
    }
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
    info.title = 'Statistiche della selezione (mediana, distinti, per colonna…) · con le geometrie apre la mappa';
    info.addEventListener('click', () => {
      if (!sel().cells.size) return;
      // Su una selezione di sole geometrie il pannello 📊 non avrebbe nulla da
      // dire (nessun numero da sommare): il seguito naturale del riassunto
      // "🗺 12 Polygon · …" è la mappa, non una tabella di trattini.
      statisticheAsync(valoriSelezionati()).then((st) => {
        if (!st.numerici && contaGeometrieSelezionate()) mostraMappaSelezione();
        else showCellStats();
      }).catch((err) => {
        // Un calcolo fallito non deve restare una promessa rifiutata e basta:
        // l'utente ha cliccato e si aspetta una risposta, anche se è un errore.
        toast(`Statistiche non calcolabili: ${err.message}`, true);
      });
    });
  }

  let dragging = false;
  let dragBase = null; // celle già selezionate prima del drag (Ctrl+trascina = aggiunge)

  /* --------- Scorrimento automatico ai bordi durante il trascinamento -------
   * Trascinando fino al bordo della griglia la selezione si fermava con la
   * parte visibile: per prendere le righe sotto bisognava rilasciare, scorrere
   * e ripartire con Shift+click. Finché il puntatore resta sul bordo (o oltre,
   * fuori dalla griglia) il contenitore scorre da solo e la selezione segue.
   *
   * La posizione del puntatore va tenuta a parte perché `mouseover` non basta:
   * col mouse fermo sul bordo non arriva più nessun evento, ma lo scorrimento
   * deve continuare; ed è lo scorrimento stesso a portare nuove celle sotto al
   * cursore, quindi la selezione si estende dal ciclo, non dagli eventi.
   * ------------------------------------------------------------------------- */

  let puntatore = null; // ultima posizione nota del puntatore che trascina
  let raf = 0;
  // La fascia sensibile dipende da COSA trascina. Col dito serve più larga: il
  // polpastrello copre una quarantina di pixel, quindi con la fascia del mouse
  // lo scorrimento partirebbe solo quando il dito ha già passato il bordo — e
  // lì sotto non si vede più nulla di ciò che si sta selezionando.
  let bordo = BORDO_DEFAULT;
  const BORDO_DITO = 72;
  // Soglia oltre la quale un tocco è un trascinamento e non più una pressione
  // (grid.js usa la stessa per la sua decisione speculare).
  const TOLLERANZA_DITO_PX = 10;

  const contenitore = () => tbody.closest('.grid-wrap');

  // Estende la selezione alla cella sotto al puntatore. Le coordinate vengono
  // riportate dentro l'area utile: fuori dalla griglia `elementFromPoint` non
  // troverebbe nulla, e sotto l'intestazione (che è `sticky`) troverebbe un
  // `th`, non la cella che quel punto copre.
  function estendiAlPuntatore() {
    if (!puntatore) return;
    const box = contenitore();
    if (!box) return;
    const s = sel();
    if (!s.anchor) return;
    const r = box.getBoundingClientRect();
    const rt = tbody.getBoundingClientRect();
    const thead = $('#grid thead');
    const altoUtile = Math.max(r.top + 1, thead ? thead.getBoundingClientRect().bottom + 1 : r.top + 1);
    const x = Math.min(Math.max(puntatore.x, r.left + 1), r.right - 1);
    const y = Math.min(Math.max(puntatore.y, altoUtile), Math.min(r.bottom - 1, rt.bottom - 1));
    // `elementsFromPoint` al plurale: col dito capita di trascinare sopra
    // qualcosa che sta davanti alla griglia (la barra inferiore del mobile, un
    // pannello sovrapposto). Al singolare si otterrebbe quello, e la selezione
    // smetterebbe di seguire proprio mentre la griglia scorre; qui si prende la
    // prima cella nella pila, che è la cella che quel punto copre davvero.
    const pila = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
    let td = null;
    for (const el of pila) {
      const cand = el && el.closest && el.closest('td[data-c]');
      if (cand && tbody.contains(cand)) { td = cand; break; }
    }
    if (!td) return; // riga virtuale non ancora resa: al prossimo fotogramma
    const cella = cellFromTd(td);
    if (s.focus && s.focus.r === cella.r && s.focus.c === cella.c) return;
    s.focus = cella;
    const rect = rectKeys(s.anchor, cella);
    s.cells = dragBase ? new Set([...dragBase, ...rect]) : new Set(rect);
    applyCellSelection({ leggero: true }); // il riassunto geografico a fine gesto
  }

  function passo() {
    raf = 0;
    if (!trascinamentoVivo() || !puntatore) { puntatore = null; return; }
    const box = contenitore();
    if (!box) return;
    const r = box.getBoundingClientRect();
    const dx = velocitaAsse(puntatore.x, r.left, r.right, { bordo });
    const dy = velocitaAsse(puntatore.y, r.top, r.bottom, { bordo });
    // Puntatore lontano dai bordi: il ciclo si sospende invece di girare a
    // vuoto trenta volte al secondo (su un telefono è batteria). Lo riaccende
    // il prossimo movimento — che è l'unico modo di tornare sul bordo.
    if (!dx && !dy) return;
    const sx = box.scrollLeft, sy = box.scrollTop;
    box.scrollLeft += dx;
    box.scrollTop += dy;
    // Se il contenitore era già a fondo corsa non è cambiato nulla: inutile
    // ricalcolare la selezione. Il ciclo però continua: con lo scorrimento
    // infinito il fondo di adesso non è il fondo di fra un secondo.
    if (box.scrollLeft !== sx || box.scrollTop !== sy) estendiAlPuntatore();
    raf = requestAnimationFrame(passo);
  }

  const trascinamentoVivo = () => dragging || !!dito;

  // Aggiorna la posizione nota e riaccende il ciclo se era sospeso.
  //
  // `avvia` è falso alla pressione iniziale: cliccare (o toccare) una cella che
  // sta già vicino al bordo non deve far scappare la griglia. Lo scorrimento è
  // una conseguenza del TRASCINARE fin sul bordo, quindi comincia al primo
  // movimento vero, non alla pressione.
  function aggiornaPuntatore(e, avvia = true) {
    puntatore = { x: e.clientX, y: e.clientY };
    if (avvia && !raf && trascinamentoVivo()) raf = requestAnimationFrame(passo);
  }

  function fermaScorrimento() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    puntatore = null;
  }

  // Il mouse va seguito su `document`: uscendo dalla griglia (che è proprio il
  // caso in cui serve scorrere) `tbody` non riceve più nulla.
  document.addEventListener('mousemove', (e) => {
    if (dragging) aggiornaPuntatore(e);
  });

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
    trascinandoSelezione = true;
    bordo = BORDO_DEFAULT;
    aggiornaPuntatore(e, false);
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
    applyCellSelection({ leggero: true });
  });

  const fineMouse = () => {
    // Il riassunto geografico è stato saltato durante il trascinamento (troppo
    // caro per fotogramma): ora che la selezione è ferma si completa.
    if (!dragging) return;
    dragging = false;
    trascinandoSelezione = !!dito;
    applyCellSelection();
    dragBase = null;
    fermaScorrimento();
  };
  document.addEventListener('mouseup', fineMouse);

  /* ------------------ Trascinamento col dito (mobile) ------------------- *
   * Il trascinamento sopra usa `mousedown`/`mouseover`, che col dito non
   * arrivano: il browser emula il mouse solo al RILASCIO di un tocco fermo, e
   * `mouseover` durante uno scorrimento non lo emette affatto. Su un telefono
   * la selezione rettangolare quindi non esisteva.
   *
   * IL PROBLEMA VERO NON È LEGGERE IL DITO, È NON RUBARE LO SCORRIMENTO. In una
   * griglia di dati il trascinamento è il modo con cui si scorre la tabella:
   * assegnarlo alla selezione la renderebbe immobile, che è molto peggio del
   * problema che risolve.
   *
   * Da qui la regola: si estende la selezione solo partendo da una cella GIÀ
   * selezionata. Ovunque altro il dito scorre come sempre. È lo stesso
   * significato del tocco prolungato (vedi grid.js): si tocca una cella per
   * sceglierla, e da lì la si allarga. Il consenso a non scorrere si dà in CSS
   * (`touch-action: none` sulle sole celle selezionate), perché una volta che il
   * browser ha iniziato a scorrere nessun preventDefault lo ferma più.
   * --------------------------------------------------------------------- */

  let dito = null;

  tbody.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return; // il mouse ha già il suo percorso
    const td = e.target.closest('td[data-c]');
    if (!td || td.classList.contains('editing')) return;
    // Solo da dentro la selezione: altrimenti questo tocco è uno scorrimento,
    // un tocco singolo o l'inizio di una pressione lunga.
    if (!sel().cells.has(key(Number(td.dataset.r), Number(td.dataset.c)))) return;
    dito = { id: e.pointerId, mosso: false, x0: e.clientX, y0: e.clientY };
    sel().anchor = sel().anchor || cellFromTd(td);
    // CATTURA ESPLICITA SUL `tbody`, ed è ciò che rende usabile lo scorrimento
    // automatico col dito. Un tocco è già catturato implicitamente, ma DAL `td`
    // iniziale: appena la griglia scorre, la virtualizzazione rifà la finestra
    // visibile (`tbody.innerHTML = ''` in grid.js) e quel `td` esce dal
    // documento. Con il bersaglio staccato gli eventi non risalgono più fin
    // qui: il gesto si spezzava a metà e, peggio, non arrivava nemmeno il
    // `pointerup` — il ciclo avrebbe continuato a scorrere a dito alzato. Il
    // `tbody` invece è sempre lo stesso elemento: viene svuotato, mai sostituito.
    try { tbody.setPointerCapture(e.pointerId); } catch { /* fuori dal DOM o id già rilasciato */ }
    bordo = BORDO_DITO;
    aggiornaPuntatore(e, false);
  });

  tbody.addEventListener('pointermove', (e) => {
    if (!dito || e.pointerId !== dito.id) return;
    // Un dito appoggiato non sta mai davvero fermo. Sotto la soglia il gesto è
    // ancora una PRESSIONE, e sulla selezione la pressione lunga è l'unico modo
    // di aprire il menu contestuale col dito (copia, statistiche, grafico): far
    // scattare qui il trascinamento per due pixel di tremolio lo toglierebbe.
    // È la stessa tolleranza con cui grid.js decide la stessa cosa.
    if (!dito.mosso
      && Math.abs(e.clientX - dito.x0) <= TOLLERANZA_DITO_PX
      && Math.abs(e.clientY - dito.y0) <= TOLLERANZA_DITO_PX) return;
    dito.mosso = true;
    trascinandoSelezione = true;
    // `elementFromPoint` e non `e.target`: durante un trascinamento tattile il
    // bersaglio resta la cella iniziale (cattura del puntatore), quindi seguire
    // `e.target` selezionerebbe sempre e solo quella. È la stessa lettura che
    // fa lo scorrimento automatico, quindi la si riusa: aggiornata la
    // posizione, `estendiAlPuntatore` fa il resto.
    aggiornaPuntatore(e);
    estendiAlPuntatore();
  });

  const fineDito = (e) => {
    if (!dito) return;
    if (e && e.pointerId !== undefined && e.pointerId !== dito.id) return;
    const mosso = dito.mosso;
    if (e && e.pointerId !== undefined) {
      try { tbody.releasePointerCapture(e.pointerId); } catch { /* già rilasciata */ }
    }
    dito = null;
    trascinandoSelezione = dragging;
    // Dopo aver spento il flag: ora il riassunto completo (geometrie comprese)
    // si calcola davvero, che è il senso di farlo a gesto finito.
    if (mosso) applyCellSelection();
    fermaScorrimento();
  };
  tbody.addEventListener('pointerup', fineDito);
  tbody.addEventListener('pointercancel', fineDito);
  // Rete di sicurezza: se il gesto finisce senza che ce ne accorgiamo (finestra
  // che perde il fuoco, app messa in secondo piano, cattura persa per una
  // ragione qualsiasi), il ciclo di scorrimento non deve restare acceso.
  const abbandona = () => { fineDito(); fineMouse(); };
  window.addEventListener('blur', abbandona);
  document.addEventListener('visibilitychange', () => { if (document.hidden) abbandona(); });

  // Trascinando piano, la pressione supera comunque la soglia del sistema e il
  // browser emette `contextmenu` a metà gesto: il menu si aprirebbe sopra una
  // selezione che si sta ancora tirando. In cattura, quindi prima del gestore
  // che apre il menu qui sotto.
  tbody.addEventListener('contextmenu', (e) => {
    if (!dito || !dito.mosso) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // Ctrl+click sull'header: selezione dell'intera colonna (il click semplice
  // continua a ordinare, vedi renderGrid). Shift+clic NON seleziona: è
  // l'ordinamento multi-colonna (aggiunge la colonna al sort, vedi renderGrid).
  $('#grid thead').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const th = e.target.closest('th[data-c]');
    if (!th) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    e.preventDefault();
    selectColumn(Number(th.dataset.c), { ctrl, shift: false });
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
    // La voce della mappa compare solo se c'è davvero una geometria selezionata:
    // su una tabella senza colonne spaziali sarebbe una voce che non fa nulla.
    const geometrie = contaGeometrieSelezionate();
    // Azioni sulla riga: erano due bottoncini in una colonna fissa della griglia,
    // ora stanno qui (la colonna rubava spazio su ogni riga per due comandi rari).
    // Bersaglio: le righe della selezione, altrimenti la riga della cella cliccata.
    const righeSel = selectionGrid().rows;
    const righe = (righeSel.length ? righeSel : [cell.r])
      .map((r) => state.docs[r])
      .filter((d) => d && '_id' in d);
    const azioniRiga = [];
    if (righe.length === 1) {
      azioniRiga.push({ label: '✎ Modifica riga…', action: () => openEditDoc(righe[0]) });
    }
    if (righe.length) {
      azioniRiga.push({
        label: righe.length === 1 ? '🗑 Elimina riga' : `🗑 Elimina le ${righe.length} righe selezionate`,
        action: () => (righe.length === 1 ? deleteDoc(righe[0]) : deleteDocs(righe)),
      });
      azioniRiga.push('---');
    }
    showContextMenu(x, y, [
      ...azioniRiga,
      { label: 'Copia (Ctrl+C)', action: () => copyToClipboard(buildTsv(false)) },
      { label: 'Copia con intestazioni', action: () => copyToClipboard(buildTsv(true)) },
      { label: 'Copia avanzato ▸', action: advanced },
      '---',
      { label: '📊 Statistiche selezione…', action: showCellStats },
      { label: '📈 Grafico della selezione…', action: mostraGraficoSelezione },
      ...(geometrie ? [{
        label: `🗺 Mostra ${geometrie === 1 ? 'la geometria' : `le ${geometrie} geometrie`} su mappa…`,
        action: mostraMappaSelezione,
      }] : []),
      ...(righe.length ? ['---', {
        // Le due voci dirette inseriscono davvero: il documento lo calcola il
        // server dai vincoli della tabella, non c'e' nulla da compilare a mano.
        label: righe.length === 1 ? '⧉ Duplica riga ▸' : `⧉ Duplica le ${righe.length} righe ▸`,
        action: () => setTimeout(() => showContextMenu(x, y, [
          { label: 'Senza chiavi (le genera il database)', action: () => duplicaRighe(righe, false) },
          { label: 'Con chiavi (nuova chiave primaria)',   action: () => duplicaRighe(righe, true) },
          '---',
          { label: 'Duplica e modifica…', action: () => duplicaConEditor(righe[0], true) },
        ]), 0),
      }] : []),
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

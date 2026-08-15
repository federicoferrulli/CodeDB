import { state } from './state.js';
import { socket } from './socket.js';
import { $, emit, esc, toast, openModal, closeModal, isSqlType, showError, conCaricamento, captureContext, marcaDatiSporchi } from './utils.js';
import { isGeometry, geometryLabel, openGeoEditor } from './geomap.js';
import { runQuery } from './grid.js';
import { agganciaLint, aggiornaLint, collegaStrumentiJson } from './json-lint.js';

let insertRows = [];
let insertJsonTouched = false;

// Tipi di colonna geometrici, negli stessi nomi in cui arrivano da
// `collection:stats`: MySQL manda COLUMN_TYPE ("point", "geometry"),
// PostgreSQL l'udt ("geometry", "geography"), MongoDB il tipo dedotto dal
// campione ("geojson", vedi bsonTypeOf in MongoDbStrategy).
const TIPI_GEO = new Set([
  'geojson', 'geometry', 'geography', 'point', 'linestring', 'polygon',
  'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection',
]);

export function insertKindOf(typeName, dbType = state.dbType) {
  const t = String(typeName || '').toLowerCase();
  if (TIPI_GEO.has(t)) return 'geo';
  if (isSqlType(dbType)) {
    if (/^tinyint\(1\)|^bool/.test(t)) return 'bool';
    if (/^decimal|^numeric/.test(t)) return 'decimal';
    if (/^(?:tinyint|smallint|mediumint|int|integer|bigint|float|double|double precision|real|year|smallserial|serial|bigserial)(?:\b|\()/.test(t)) return 'number';
    if (/^datetime|^timestamp/.test(t)) return 'datetime';
    if (/^date$/.test(t)) return 'date';
    if (/^json/.test(t)) return 'json';
    return 'text';
  }
  if (t === 'int' || t === 'double' || t === 'long') return 'number';
  if (t === 'decimal') return 'decimal';
  if (t === 'date') return 'datetime';
  if (t === 'boolean') return 'bool';
  if (t === 'objectid') return 'oid';
  if (t === 'array' || t === 'object') return 'json';
  return 'text';
}

// Etichetta del pulsante-geometria: dice cosa c'è dentro senza aprire la mappa.
function etichettaGeo(btn) {
  let geo = null;
  try { geo = btn.value ? JSON.parse(btn.value) : null; } catch { /* testo non valido */ }
  btn.textContent = isGeometry(geo) ? `🗺 ${geometryLabel(geo).replace(/^▦ /, '')}` : '🗺 Disegna sulla mappa…';
}

export function insertInputFor(kind) {
  // Geometria: il "campo" è un pulsante che apre la mappa e custodisce il
  // GeoJSON in `value` — così il resto del form (lettura, cambio tipo,
  // rimozione riga) continua a trattarlo come un input qualsiasi.
  if (kind === 'geo') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost geo-pick';
    btn.value = '';
    etichettaGeo(btn);
    btn.addEventListener('click', () => {
      let corrente = null;
      try { corrente = btn.value ? JSON.parse(btn.value) : null; } catch { /* si riparte da zero */ }
      openGeoEditor({
        value: corrente,
        campo: insertNomeCampo(btn),
        onSave: (geo) => {
          btn.value = JSON.stringify(geo);
          etichettaGeo(btn);
        },
      });
    });
    return btn;
  }

  if (kind === 'bool') {
    const s = document.createElement('select');
    for (const v of ['', 'true', 'false']) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === '' ? '(vuoto)' : v;
      s.appendChild(o);
    }
    return s;
  }
  const i = document.createElement('input');
  if (kind === 'number') { i.type = 'number'; i.step = 'any'; }
  else if (kind === 'datetime') {
    i.type = 'datetime-local';
    i.step = '0.001';
    // L'ora si scrive e si legge in UTC, come nella griglia (CDB-15): il
    // controllo del browser suggerisce l'ora locale, quindi va detto.
    i.title = 'Ora UTC, come nella griglia (non l\'ora locale del computer)';
    i.setAttribute('aria-label', 'Data e ora in UTC');
    i.classList.add('input-utc');
  }
  else if (kind === 'date') { i.type = 'date'; }
  else {
    i.type = 'text';
    if (kind === 'oid') i.placeholder = '24 caratteri esadecimali';
    if (kind === 'json') i.placeholder = 'JSON, es. {"a": 1} oppure [1, 2]';
  }
  i.spellcheck = false;
  return i;
}

export function addInsertRow(opts) {
  const tr = document.createElement('tr');
  const row = {
    tr,
    kind: opts.kind || 'text',
    input: null,
    nameInput: null,
    fixedName: opts.name || null,
    auto: !!opts.auto,
    required: !!opts.required,
  };

  const nameTd = document.createElement('td');
  if (opts.nameEditable) {
    row.nameInput = document.createElement('input');
    row.nameInput.type = 'text';
    row.nameInput.placeholder = 'nome campo';
    row.nameInput.spellcheck = false;
    nameTd.appendChild(row.nameInput);
  } else {
    nameTd.innerHTML = `<span class="mono">${esc(opts.name)}</span>` +
      (opts.required ? '<span class="req" title="Obbligatorio: NOT NULL senza default"> *</span>' : '');
  }
  tr.appendChild(nameTd);

  const typeTd = document.createElement('td');
  typeTd.className = 'insert-type';
  if (opts.nameEditable) {
    const sel = document.createElement('select');
    const kinds = [['text', 'testo'], ['number', 'numero'], ['bool', 'booleano'],
                   ['datetime', 'data (UTC)'], ['oid', 'ObjectId'], ['json', 'JSON'],
                   // Su MongoDB il tipo di un campo NUOVO non è deducibile da
                   // nessuno schema: la geometria va potuta scegliere a mano.
                   ['geo', 'geometria (mappa)']];
    for (const [v, label] of kinds) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      row.kind = sel.value;
      const fresh = insertInputFor(row.kind);
      row.input.replaceWith(fresh);
      row.input = fresh;
    });
    typeTd.appendChild(sel);
  } else {
    typeTd.innerHTML = `<span class="dim">${esc(opts.typeLabel || '')}</span>`;
  }
  tr.appendChild(typeTd);

  const valTd = document.createElement('td');
  valTd.className = 'insert-value';
  if (row.auto) {
    const i = document.createElement('input');
    i.type = 'text';
    i.disabled = true;
    i.placeholder = '(auto)';
    row.input = i;
  } else {
    row.input = insertInputFor(row.kind);
  }
  valTd.appendChild(row.input);
  tr.appendChild(valTd);

  const delTd = document.createElement('td');
  delTd.className = 'row-actions';
  if (opts.removable) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del-btn';
    del.textContent = '✕';
    del.title = 'Rimuovi campo';
    del.addEventListener('click', () => {
      tr.remove();
      insertRows = insertRows.filter((r) => r !== row);
    });
    delTd.appendChild(del);
  }
  tr.appendChild(delTd);

  $('#insert-form tbody').appendChild(tr);
  insertRows.push(row);
  return row;
}

// Nome del campo a cui appartiene un controllo del form: serve solo per il
// titolo dell'editor geografico.
function insertNomeCampo(el) {
  const row = insertRows.find((r) => r.input === el);
  if (!row) return '';
  return row.nameInput ? row.nameInput.value.trim() : (row.fixedName || '');
}

export function insertRowValue(row, dbType = insertContext ? insertContext.dbType : state.dbType) {
  const raw = row.input.value;
  const t = String(raw == null ? '' : raw).trim();
  if (t === '') return undefined;
  switch (row.kind) {
    case 'number': {
      const n = Number(t);
      if (Number.isNaN(n)) throw new Error('numero non valido');
      return n;
    }
    case 'decimal':
      return isSqlType(dbType) ? t : { $numberDecimal: t };
    case 'bool':
      return t === 'true';
    case 'datetime': {
      const d = new Date(t + 'Z');
      if (Number.isNaN(d.getTime())) throw new Error('data non valida');
      return { $date: d.toISOString() };
    }
    case 'date':
      return t;
    case 'oid':
      if (!/^[0-9a-fA-F]{24}$/.test(t)) throw new Error('ObjectId non valido (24 caratteri esadecimali)');
      return { $oid: t };
    case 'geo': {
      let geo;
      try { geo = JSON.parse(t); } catch { throw new Error('geometria non valida (JSON illeggibile)'); }
      if (!isGeometry(geo)) throw new Error('geometria non valida: serve un GeoJSON { type, coordinates }');
      return geo;
    }
    case 'json':
      // Il motivo del parser va riportato: su un JSON scritto a mano "non
      // valido" da solo non dice dove guardare, mentre il messaggio nativo
      // indica la posizione del carattere che ha fatto fallire la lettura.
      try { return JSON.parse(t); } catch (e) { throw new Error(`JSON non valido: ${e.message}`); }
    default:
      return raw;
  }
}

export function buildInsertDoc() {
  const doc = Object.create(null);
  for (const row of insertRows) {
    if (row.auto) continue;
    const name = row.nameInput ? row.nameInput.value.trim() : row.fixedName;
    if (!name) {
      if (String(row.input.value).trim() !== '') throw new Error('C\'è un campo con un valore ma senza nome.');
      continue;
    }
    let value;
    try {
      value = insertRowValue(row);
    } catch (err) {
      throw new Error(`Campo "${name}": ${err.message}`);
    }
    if (value === undefined) {
      if (row.required) throw new Error(`Il campo "${name}" è obbligatorio (NOT NULL senza default).`);
      continue;
    }
    if (Object.hasOwn(doc, name)) throw new Error(`Campo duplicato: "${name}".`);
    doc[name] = value;
  }
  return doc;
}

export function selectInsertTab(name) {
  if (name === 'json' && !insertJsonTouched && !$('#insert-tab-form').classList.contains('hidden')) {
    try {
      $('#insert-json').value = JSON.stringify(buildInsertDoc(), null, 2);
    } catch { /* ignore */ }
  }
  document.querySelectorAll('[data-instab]').forEach((t) => t.classList.toggle('active', t.dataset.instab === name));
  $('#insert-tab-form').classList.toggle('hidden', name !== 'form');
  $('#insert-tab-json').classList.toggle('hidden', name !== 'json');
}

let insertContext = null;
// Numero di apertura della modale (CDB-14). `insertRows` è una variabile di
// modulo azzerata a ogni apertura e popolata da una risposta asincrona: se si
// chiude e riapre la modale su un'altra collection prima che la prima risposta
// arrivi, quelle righe finiscono nel form NUOVO — campi di un'altra tabella,
// pronti per essere scritti. Il contatore fa scartare le risposte sorpassate.
let insertAperture = 0;

export function openInsertDocForContext(ctx = null) {
  // Il bersaglio si congela all'APERTURA (CDB-A18). Senza contesto esplicito lo
  // si sintetizza dal tab corrente invece di rileggere `state` al salvataggio:
  // la modale resta aperta quanto vuole l'utente, che nel frattempo può
  // cambiare tab, e `state` è un Proxy sul tab ATTIVO — il documento sarebbe
  // finito nella collection sbagliata, senza alcun segnale.
  if (ctx) {
    insertContext = ctx;
  } else {
    const origin = captureContext();
    insertContext = Object.assign(origin, {
      db: state.db,
      coll: state.coll,
      dbType: state.dbType,
    });
  }
  const apertura = ++insertAperture;
  const { db, coll, tabId, dbType } = insertContext;
  const isSql = isSqlType(dbType);

  $('#insert-title').textContent = isSql ? 'Nuova riga' : 'Nuovo documento';
  $('#insert-json').value = '{\n  \n}';
  // La barra del linting appartiene al documento precedente: si riparte muti.
  const lintEl = $('#insert-json-lint');
  if (lintEl) { lintEl.classList.add('hidden'); lintEl.textContent = ''; }
  insertJsonTouched = false;
  insertRows = [];
  $('#insert-form tbody').innerHTML = '';
  $('#insert-form-empty').classList.add('hidden');
  $('#insert-addfield').classList.toggle('hidden', isSql);
  $('#insert-error').classList.add('hidden');
  selectInsertTab('form');
  openModal('#insert-overlay');

  emit('collection:stats', { tabId, db, coll }).then((res) => {
    if (apertura !== insertAperture) return; // modale riaperta nel frattempo (CDB-14)
    for (const f of (res.fields || [])) {
      if (f.name === '_id' && !isSql) continue;
      const mainType = (f.types || []).find((t) => t !== 'null') || 'null';
      addInsertRow({
        name: f.name,
        typeLabel: (f.types || []).join(', '),
        kind: insertKindOf(mainType, dbType),
        auto: !!f.autoIncrement,
        required: isSql && !f.nullable && f.default == null && !f.autoIncrement,
      });
    }
    if (!insertRows.length) $('#insert-form-empty').classList.remove('hidden');
    const first = insertRows.find((r) => !r.auto);
    if (first) first.input.focus();
  }).catch((err) => {
    if (apertura !== insertAperture) return;
    // Lo schema non è arrivato (CDB-13). Prima qui c'era solo un toast: la
    // modale restava aperta e VUOTA e, su SQL, senza nemmeno il pulsante
    // "aggiungi campo" — quindi inserire una riga diventava impossibile, con la
    // sola spiegazione di un messaggio che spariva in tre secondi. Lo schema
    // serve per la comodità dei campi precompilati, non per scrivere: si dice
    // cosa è successo e si apre la via manuale (nomi di campo digitabili, e la
    // scheda JSON resta sempre disponibile).
    toast(`Schema non disponibile: ${err.message}`, true);
    showError('#insert-error',
      'Non è stato possibile leggere le colonne di questa tabella: '
      + `${err.message}. Puoi comunque inserire i valori a mano, aggiungendo i campi `
      + 'uno a uno oppure scrivendo il documento nella scheda JSON.');
    $('#insert-addfield').classList.remove('hidden');
    $('#insert-form-empty').classList.remove('hidden');
  });
}

export function initInsert() {
  document.querySelectorAll('[data-instab]').forEach((tab) =>
    tab.addEventListener('click', () => selectInsertTab(tab.dataset.instab))
  );

  $('#insert-json').addEventListener('input', () => { insertJsonTouched = true; });

  // Il documento si controlla MENTRE si scrive: prima l'errore di sintassi
  // usciva solo premendo "Inserisci", e il messaggio arrivava dal driver senza
  // dire a quale riga guardare.
  const jsonArea = $('#insert-json');
  const jsonLint = $('#insert-json-lint');
  agganciaLint(jsonArea, jsonLint);
  collegaStrumentiJson(jsonArea, jsonLint, '#insert-json-format', '#insert-json-minify');

  $('#insert-addfield').addEventListener('click', () => {
    $('#insert-form-empty').classList.add('hidden');
    const row = addInsertRow({ nameEditable: true, kind: 'text', removable: true });
    row.nameInput.focus();
  });

  $('#insert-btn').addEventListener('click', () => {
    openInsertDocForContext(null);
  });

  $('#insert-cancel').addEventListener('click', () => closeModal('#insert-overlay'));

  $('#insert-save').addEventListener('click', () => {
    const usingForm = !$('#insert-tab-form').classList.contains('hidden');
    let docText;
    if (usingForm) {
      try {
        docText = JSON.stringify(buildInsertDoc());
      } catch (err) {
        const el = $('#insert-error');
        el.textContent = err.message;
        el.classList.remove('hidden');
        return;
      }
    } else {
      // Un documento sintatticamente rotto non vale un giro di rete: l'errore
      // del driver direbbe molto meno di riga e colonna.
      const esito = aggiornaLint($('#insert-json'), $('#insert-json-lint'));
      if (esito && !esito.ok) {
        const el = $('#insert-error');
        el.textContent = `Riga ${esito.riga}, colonna ${esito.colonna}: ${esito.messaggio}`;
        el.classList.remove('hidden');
        return;
      }
      docText = $('#insert-json').value;
    }
    // Bersaglio congelato all'apertura della modale, mai riletto da `state`.
    const ctx = insertContext;
    const { tabId, db, coll, dbType } = ctx || {};

    // Un inserimento premuto due volte sono due documenti: qui lo stato di
    // attesa non è cortesia, è la protezione dal doppio invio.
    conCaricamento($('#insert-save'), () => emit('doc:insert', {
      tabId,
      db,
      coll,
      doc: docText,
    }), 'Inserisco…').then(() => {
      closeModal('#insert-overlay');
      toast(isSqlType(dbType) ? 'Riga inserita' : 'Documento inserito');
      if (ctx && ctx.onSaveSuccess) {
        ctx.onSaveSuccess();
      } else if (ctx && ctx.isStillActive && ctx.isStillActive()) {
        // runQuery legge gli input del workspace: ha senso solo se il tab che ha
        // inserito è ancora quello mostrato.
        runQuery({ auto: true }); // refresh post-scrittura
      } else {
        marcaDatiSporchi(ctx, db, coll);
      }
    }).catch((err) => {
      const errorEl = $('#insert-error');
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  });
}

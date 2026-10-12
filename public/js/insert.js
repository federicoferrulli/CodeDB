import { state } from './state.js';
import { $, emit, esc, toast, openModal, closeModal, isSqlType, showError, conCaricamento, captureContext, marcaDatiSporchi, lucideIconHtml as ICO, refreshLucideIcons } from './utils.js';
import { openGeoEditor } from './geomap.js';
import { tipoGeoJsonDaTipoColonna, colonnaGeometrica } from './geojson.js';
import { runQuery } from './grid.js';
import { agganciaLint, aggiornaLint, collegaStrumentiJson } from './json-lint.js';
import { testoNumeroEsatto } from './valori-esatti.js';
import { caricaRelazioni } from './fk-cache.js';
import { apriPannelloFk, chiudiPannelloFk, pannelloFkAperto, pannelloFkMobile } from './fk-vista.js';
import { setDaRelazione, bersaglioRelazione, VINCOLO } from './fk-relazioni.js';
import { createArcInput, createArcTextarea, createArcButton, createArcSelect, updateArcSelect, controlElement } from '../arc/ui.js';
import { proteggiModifiche } from './utils.js';
import { tabs } from './tabs.js';
import { tipiBson, guidaTipo, valoreInserimento } from './insert-types.js';
import { campiJson, leggiJsonEsatto } from './insert-json.mjs';

let insertRows = [];
let insertJsonTouched = false;

export function insertKindOf(typeName, dbType = state.dbType) {
  const t = String(typeName || '').toLowerCase();
  if (isSqlType(dbType)) {
    if (/\[\]$/.test(t)) return 'native';
    if (dbType === 'postgresql' && /^(point|line|lseg|box|path|polygon|circle)$/.test(t)) return 'pggeo';
    if (colonnaGeometrica({ type: t })) return 'geo';
    if (/^bool/.test(t)) return 'bool';
    if (/^(?:bytea|(?:tiny|medium|long)?blob|(?:var)?binary)\b/.test(t)) return 'bytes';
    if (/^(?:bit|varbit)\b/.test(t)) return 'bits';
    if (/^(decimal|numeric)/.test(t)) return 'decimal';
    if (/^(tinyint|smallint|mediumint|int|integer|bigint|float|double|real|year|smallserial|serial|bigserial)(?:\b|\()/.test(t)) return 'number';
    if (/^(datetime|timestamp|time|interval)/.test(t)) return 'temporal';
    if (t === 'date') return 'date';
    if (/^jsonb?$/.test(t)) return 'json';
    return /^(char|varchar|text|tinytext|mediumtext|longtext|enum|set|citext)\b/.test(t) ? 'text' : 'native';
  }
  if (colonnaGeometrica({ type: t })) return 'geo';
  if (t === 'date') return 'datetime';
  if (t === 'boolean') return 'bool';
  if (t === 'objectid') return 'oid';
  if (t === 'array' || t === 'object') return 'json';
  if (t === 'bsonregexp' || t === 'regexp') return 'regex';
  if (t === 'bsonsymbol') return 'symbol';
  return tipiBson.some(([kind]) => kind === t) ? t : 'text';
}

export function insertInputFor(kind, { typeName = '', enumValues = null } = {}) {
  if (kind === 'bool') return createArcSelect({ label: 'Valore booleano', options: [
    { value: '', label: 'Scegli un valore' }, { value: 'true', label: 'true' }, { value: 'false', label: 'false' },
  ] });
  if (enumValues?.length) return createArcSelect({ label: 'Valore enumerato', options: [
    { value: '', label: 'Scegli un valore' }, ...enumValues.map((label, i) => ({ value: String(i), label: label === '' ? '(testo vuoto)' : label })),
  ] });
  const [placeholder, hint] = guidaTipo(kind, typeName);
  const integer = kind === 'number' && /^(tinyint|smallint|mediumint|int|integer|year)(?:\b|\()/i.test(typeName);
  const multiline = ['text', 'native', 'pggeo', 'geo', 'json', 'code', 'scope', 'symbol', 'binary', 'regex', 'timestamp', 'dbpointer', 'bytes'].includes(kind);
  const input = multiline ? createArcTextarea({ rows: 1, placeholder }) : createArcInput({ type: integer ? 'number' : 'text', placeholder });
  if (integer) input.step = '1';
  input.spellcheck = false;
  input.title = hint;
  if (kind === 'datetime' || kind === 'date' || (kind === 'temporal' && /^(?:datetime|timestamp)/i.test(typeName))) input.dataset.arcDateNative = kind === 'date' ? 'date' : 'datetime';
  if (kind === 'geo') input.dataset.geoType = tipoGeoJsonDaTipoColonna(typeName) || '';
  if (['undefined', 'minkey', 'maxkey'].includes(kind)) { input.readOnly = true; input.placeholder = hint; }
  return input;
}

export function addInsertRow(opts) {
  const tr = document.createElement('tr');
  const row = {
    tr, kind: opts.kind || 'text', input: null, nameInput: null, fixedName: opts.name ?? null,
    auto: !!opts.auto, required: !!opts.required, numericMeta: opts.numericMeta || {},
    dbType: opts.dbType || insertContext?.dbType || state.dbType,
    typeName: opts.typeName || '', nullable: opts.nullable !== false, mode: 'pristine',
    autoIncrement: !!opts.autoIncrement,
    enumValues: opts.enumValues || null,
    fkRelazione: null, fkCollegato: false, fkValore: undefined, haFkScelto: false, saltaProssimoFocus: false,
  };
  const nameTd = document.createElement('td');
  nameTd.className = 'insert-name';
  if (opts.nameEditable) {
    row.nameInput = createArcInput({ 'aria-label': 'Nome del campo', placeholder: 'nome campo' });
    row.nameInput.spellcheck = false;
    nameTd.appendChild(controlElement(row.nameInput));
  } else {
    nameTd.innerHTML = `<span class="mono">${esc(opts.name)}</span>` +
      (opts.required ? '<span class="req" title="Obbligatorio: NOT NULL senza default"> *</span>' : '');
  }
  tr.appendChild(nameTd);
  const typeTd = document.createElement('td');
  typeTd.className = 'insert-type';
  if (opts.nameEditable || !isSqlType(row.dbType)) {
    const kinds = isSqlType(row.dbType) ? [['text', 'Testo / formato nativo'], ['json', 'JSON'], ['bytes', 'Binario'], ['bool', 'Booleano']] : tipiBson;
    row.typeSelect = createArcSelect({ label: 'Tipo del campo', value: row.kind, options: kinds.map(([value, label]) => ({ value, label })) });
    row.typeSelect.addEventListener('change', () => {
      const previous = row.input.value;
      row.kind = row.typeSelect.value;
      const fresh = insertInputFor(row.kind);
      fresh.value = previous;
      fresh.setAttribute('aria-label', `Valore ${nomeCampoRiga(row) || 'del campo'}`);
      fresh.setAttribute('aria-describedby', row.hint.id);
      controlElement(row.input).replaceWith(controlElement(fresh));
      row.input = fresh;
      row.input.disabled = row.mode === 'null';
      row.haFkScelto = false;
      collegaValoreRiga(row);
      row.hint.textContent = guidaTipo(row.kind)[1];
      row.mapButton?.classList.toggle('hidden', row.kind !== 'geo');
    });
    typeTd.appendChild(controlElement(row.typeSelect));
  } else {
    typeTd.innerHTML = `<span class="insert-type-label">${esc(opts.typeLabel || '')}</span>`;
  }
  tr.appendChild(typeTd);
  const valTd = document.createElement('td');
  valTd.className = 'insert-value';
  row.input = insertInputFor(row.kind, { typeName: row.typeName, enumValues: row.enumValues });
  row.input.disabled = row.auto;
  if (row.auto) row.input.placeholder = 'Calcolato dal database';
  row.input.setAttribute('aria-label', `Valore ${opts.name || 'del campo'}`);
  valTd.appendChild(controlElement(row.input));
  if (row.kind === 'geo' || (row.kind === 'pggeo' && tipoGeoJsonDaTipoColonna(row.typeName)) || !isSqlType(row.dbType)) {
    const map = createArcButton({ className: 'ghost insert-map', 'aria-label': `Disegna ${opts.name || 'il campo'} sulla mappa` });
    map.innerHTML = `${ICO('map')} Mappa`;
    map.classList.toggle('hidden', !['geo', 'pggeo'].includes(row.kind));
    map.addEventListener('click', () => {
      let value = null;
      try { value = JSON.parse(row.input.value); } catch { /* il testo nativo resta nel campo */ }
      openGeoEditor({ value, campo: nomeCampoRiga(row), tipoSuggerito: tipoGeoJsonDaTipoColonna(row.typeName), onSave: geo => {
        row.input.value = JSON.stringify(geo);
        row.input.dispatchEvent(new Event('input', { bubbles: true }));
      } });
    });
    row.mapButton = controlElement(map);
    valTd.appendChild(row.mapButton);
  }
  row.hint = document.createElement('small');
  row.hint.className = 'insert-hint';
  row.hint.textContent = row.auto ? 'Valore calcolato dal database.' : opts.autoIncrement ? 'Generato automaticamente; puoi anche specificare un valore.' : opts.default != null ? `Predefinito: ${opts.default}` : guidaTipo(row.kind, row.typeName)[1];
  row.hint.id = `insert-hint-${insertAperture}-${insertRows.length}-${Date.now()}`;
  row.input.setAttribute('aria-describedby', row.hint.id);
  valTd.appendChild(row.hint);
  tr.appendChild(valTd);
  const actions = document.createElement('td');
  actions.className = 'row-actions';
  row.modeSelect = createArcSelect({ label: `Stato ${opts.name || 'del campo'}`, value: 'omit', disabled: row.auto,
    options: [{ value: 'omit', label: isSqlType(row.dbType) ? 'Predefinito' : 'Ometti' }, { value: 'value', label: 'Valore' }, ...(row.nullable ? [{ value: 'null', label: 'NULL' }] : [])] });
  if (row.auto) updateArcSelect(row.modeSelect, { disabled: true });
  row.modeSelect.addEventListener('change', () => {
    row.mode = row.modeSelect.value;
    row.haFkScelto = false;
    row.input.disabled = row.auto || row.mode === 'null';
    tr.dataset.mode = row.mode;
    if (row.mapButton) row.mapButton.inert = row.mode === 'null';
  });
  actions.appendChild(controlElement(row.modeSelect));
  if (opts.removable) {
    const del = createArcButton({ className: 'del-btn', 'aria-label': 'Rimuovi campo' });
    del.innerHTML = ICO('x');
    del.addEventListener('click', () => {
      if (pannelloFkAperto(row.input)) chiudiPannelloFk();
      tr.remove(); insertRows = insertRows.filter(r => r !== row);
    });
    actions.appendChild(controlElement(del));
  }
  tr.appendChild(actions);
  $('#insert-form tbody').appendChild(tr);
  insertRows.push(row);
  collegaValoreRiga(row);
  refreshLucideIcons(tr);
  return row;
}

function collegaValoreRiga(row) {
  const change = () => {
    row.mode = 'value'; row.modeSelect.value = 'value'; row.tr.dataset.mode = 'value';
    row.haFkScelto = false; row.input.removeAttribute('aria-invalid');
    row.tr.classList.remove('insert-invalid');
  };
  row.input.addEventListener('input', change);
  row.input.addEventListener('change', change);
}

export function insertRowValue(row, dbType = insertContext?.dbType || state.dbType) {
  if (row.haFkScelto) return row.fkValore;
  if (row.mode === 'null') return null;
  if (row.mode === 'omit') return undefined;
  const raw = String(row.input.value ?? '');
  if ((row.mode === 'pristine' || row.mode == null) && raw === '') return undefined;
  if (row.enumValues) {
    if (raw === '' || !Object.hasOwn(row.enumValues, raw)) throw new Error('Scegli un valore enumerato.');
    return row.enumValues[Number(raw)];
  }
  return valoreInserimento(raw, row.kind, { ...row.numericMeta, dbType: row.dbType || dbType }, isSqlType(row.dbType || dbType));
}

export function buildInsertDoc({ validateRequired = true } = {}) {
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
      row.input.setAttribute('aria-invalid', 'true');
      row.tr.classList.add('insert-invalid');
      row.input.focus();
      throw new Error(`Campo "${name}": ${err.message}`);
    }
    if (value === undefined) {
      if (row.required && validateRequired) { row.input.setAttribute('aria-invalid', 'true'); row.input.focus(); throw new Error(`Il campo "${name}" è obbligatorio (NOT NULL senza default).`); }
      continue;
    }
    if (Object.hasOwn(doc, name)) throw new Error(`Campo duplicato: "${name}".`);
    doc[name] = value;
  }
  return doc;
}

export function selectInsertTab(name, sync = true) {
  try {
    const formVisible = !$('#insert-tab-form').classList.contains('hidden');
    if (sync && name === 'json' && formVisible) {
      $('#insert-json').value = JSON.stringify(buildInsertDoc({ validateRequired: false }), null, 2);
      insertJsonTouched = false;
    }
    if (sync && name === 'form' && !formVisible && insertJsonTouched) {
      const fields = campiJson($('#insert-json').value);
      const sql = isSqlType(insertContext?.dbType);
      const assignments = [...fields].map(([field, raw]) => {
        let row = rigaPerCampo(field);
        if (row?.auto) throw new Error(`Il campo "${field}" è calcolato: omettilo dal JSON.`);
        const value = sql && row?.kind === 'json' && raw !== 'null' ? (raw[0] === '"' ? JSON.parse(raw) : raw)
          : sql && /^-?\d/.test(raw) ? raw : leggiJsonEsatto(raw);
        return { field, row, value };
      });
      for (const row of insertRows) { row.mode = 'omit'; row.modeSelect.value = 'omit'; row.haFkScelto = false; row.input.value = ''; row.input.disabled = row.auto; }
      for (const item of assignments) {
        if (!item.row) {
          item.row = addInsertRow({ name: item.field, nameEditable: true, removable: true, kind: typeof item.value === 'object' ? 'json' : 'text' });
          item.row.nameInput.value = item.field;
        }
        impostaValoreFk(item.row, item.value);
      }
      insertJsonTouched = false;
    }
  } catch (err) {
    showError('#insert-error', err.message);
    return false;
  }
  if (name === 'json') {
    // Il pannello appartiene a un campo del modulo: sulla scheda JSON sarebbe
    // orfano sopra un editor libero. La bozza resta, il pannello no.
    if (pannelloApertoDaInsert()) chiudiPannelloFk();
  }
  document.querySelectorAll('[data-instab]').forEach((t) => t.classList.toggle('active', t.dataset.instab === name));
  $('#insert-tab-form').classList.toggle('hidden', name !== 'form');
  $('#insert-tab-json').classList.toggle('hidden', name !== 'json');
  return true;
}

/* ---------------- Chiavi esterne nel form di inserimento ----------------
 * Nel form «Nuova riga» un campo con FK permette di cercare e scegliere una
 * riga della tabella riferita con lo stesso pannello dell'editing in griglia
 * (`fk-vista.js`). Differenze rispetto all'edit, che qui contano:
 *  - il callback compila solo la BOZZA: mai `doc:update`, `doc:insert` o il
 *    salvataggio inline — si salva una volta sola con «Inserisci»;
 *  - una FK composta compila insieme tutte le colonne locali del vincolo;
 *  - il valore scelto viaggia come EJSON esatto sulla riga del form, perché il
 *    controllo testuale non rappresenta fedelmente BIGINT oltre 2^53, ObjectId,
 *    date, null e stringa vuota. Una digitazione manuale invalida la copia.
 * ------------------------------------------------------------------------- */

// Relazioni dell'apertura corrente (Map campo → relazione) oppure null mentre
// mancano. Come `insertRows`, valgono solo per `insertAperture` corrente.
let insertRelazioni = null;

function nomeCampoRiga(row) {
  return row.nameInput ? row.nameInput.value.trim() : (row.fixedName || '');
}

function rigaPerCampo(nome) {
  return insertRows.find((r) => nomeCampoRiga(r) === nome) || null;
}

function overlayInsertAperta(apertura) {
  return apertura === insertAperture
    && !$('#insert-overlay').classList.contains('hidden');
}

/** Il pannello aperto appartiene a un campo di questo form? */
function pannelloApertoDaInsert() {
  return insertRows.some((r) => r.input && pannelloFkAperto(r.input));
}

/** Testo da mostrare nel controllo per un valore EJSON già tipizzato. */
function testoPerControllo(row, v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const inner = { binary: '$binary', regex: '$regularExpression', timestamp: '$timestamp', dbpointer: '$dbPointer' }[row.kind];
    if (inner && Object.hasOwn(v, inner)) return JSON.stringify(v[inner]);
    if (row.kind === 'code' && typeof v.$code === 'string') return v.$code;
    if (row.kind === 'symbol' && typeof v.$symbol === 'string') return v.$symbol;
    if (row.kind === 'uuid' && v.$uuid) return v.$uuid;
    if (row.kind === 'bytes' && v.$binary) return [...atob(v.$binary.base64)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    if (row.kind === 'bits' && row.dbType === 'mysql') return BigInt(testoNumeroEsatto(v)).toString(2);
    if (typeof v.$oid === 'string') return v.$oid;
    if (v.$numberLong !== undefined || v.$numberDecimal !== undefined
      || v.$numberInt !== undefined || v.$numberDouble !== undefined) {
      return testoNumeroEsatto(v);
    }
    if (v.$date !== undefined) {
      if (v.$date && typeof v.$date === 'object' && v.$date.$numberLong !== undefined) return String(v.$date.$numberLong);
      if (typeof v.$date === 'string') return v.$date;
      const grezzo = (v.$date && typeof v.$date === 'object' && v.$date.$numberLong !== undefined)
        ? Number(v.$date.$numberLong) : v.$date;
      const d = new Date(grezzo);
      if (Number.isNaN(d.getTime())) return '';
      if (row.kind === 'date') return d.toISOString().slice(0, 10);
      if (row.kind === 'datetime') return d.toISOString().slice(0, 23);
      return d.toISOString();
    }
    try { return JSON.stringify(v); } catch { return ''; }
  }
  return String(v);
}

/** Scrive il valore scelto sulla riga, conservando l'EJSON esatto. */
function impostaValoreFk(row, valore) {
  row.fkValore = valore;
  row.haFkScelto = true;
  row.mode = valore === null ? 'null' : 'value';
  row.modeSelect.value = row.mode;
  row.tr.dataset.mode = row.mode;
  row.input.disabled = valore === null;
  try {
    row.input.value = row.enumValues ? String(row.enumValues.indexOf(valore)) : row.kind === 'json' && !isSqlType(row.dbType) ? JSON.stringify(valore) : testoPerControllo(row, valore);
  } catch { /* il payload resta esatto anche se la vista è vuota */ }
}

/** Valore attuale della bozza per un campo, senza mai lanciare. */
function valoreBozzaPerCampo(nome) {
  const row = rigaPerCampo(nome);
  if (!row || row.auto) return undefined;
  if (row.haFkScelto) return row.fkValore === undefined ? undefined : row.fkValore;
  try {
    return insertRowValue(row);
  } catch {
    return undefined;
  }
}

function apriPannelloPerRiga(row, apertura) {
  if (!overlayInsertAperta(apertura)) return;
  if (!insertRows.includes(row) || !document.contains(row.input)) return;
  const relazione = row.fkRelazione;
  if (!relazione) return;
  const ctx = insertContext;
  if (!ctx) return;
  const coppie = relazione.coppie || [{ campo: relazione.campo, colonna: relazione.colonna }];
  const valoriRelazione = {};
  for (const p of coppie) valoriRelazione[p.campo] = valoreBozzaPerCampo(p.campo);
  const primo = coppie[0];
  apriPannelloFk({
    relazione,
    valore: valoriRelazione[primo.campo],
    valoriRelazione,
    dbCorrente: ctx.db,
    tabId: ctx.tabId,
    sorgente: row.input,
    contenitore: row.input,
    onScegli: (scelto, rigaScelta) => {
      // Risposta tardiva: il form è stato chiuso o riaperto nel frattempo.
      if (!overlayInsertAperta(apertura)) return;
      if (!insertRows.includes(row)) return;
      let assegnazione;
      try {
        // Tutta l'assegnazione in un colpo solo: le colonne di una FK composta
        // vengono dalla stessa riga scelta, mai da due scelte diverse.
        assegnazione = setDaRelazione(relazione, rigaScelta);
      } catch (err) {
        toast(err.message, true);
        return;
      }
      // Si valida TUTTO prima di toccare qualunque controllo: un bersaglio
      // mancante non deve lasciare il form modificato a metà.
      const obiettivi = [];
      for (const [campo, valore] of Object.entries(assegnazione)) {
        const destino = rigaPerCampo(campo);
        if (!destino || destino.auto || !document.contains(destino.input) || (destino.input.disabled && destino.mode !== 'null')) {
          toast(`Campo "${campo}" non disponibile: nessuna colonna è stata modificata.`, true);
          return;
        }
        obiettivi.push([destino, valore]);
      }
      for (const [destino, valore] of obiettivi) impostaValoreFk(destino, valore);
      // Il ritorno del focus non deve riaprire il pannello appena chiuso — ma
      // solo se il focus si è davvero spostato (clic vero): con un focus già
      // fermo sul campo, `focus()` non emette alcun evento e armare il flag lo
      // farebbe scattare sul PROSSIMO ingresso vero, lasciandolo senza pannello.
      if (document.contains(row.input) && row.input.focus && document.activeElement !== row.input) {
        row.saltaProssimoFocus = true;
        row.input.focus();
      }
    },
  });
}

function collegaPulsanteFk(row, apertura) {
  const relazione = row.fkRelazione;
  if (!relazione || !row.input || !row.input.parentElement) return;
  const valTd = row.input.closest('td');
  const btn = createArcButton({ className: 'fk-apri-btn' });
  btn.innerHTML = ICO('link');
  refreshLucideIcons(btn);
  btn.tabIndex = -1;
  const dove = bersaglioRelazione(relazione, insertContext ? insertContext.db : '');
  const ipotesi = relazione.origine !== VINCOLO ? ' (collegamento ipotizzato dal nome del campo)' : '';
  btn.title = `Scegli il riferimento in ${dove}${ipotesi}`;
  btn.setAttribute('aria-label', `Scegli il riferimento in ${dove}${ipotesi}`);
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    if (pannelloFkAperto(row.input)) chiudiPannelloFk();
    else apriPannelloPerRiga(row, apertura);
  });
  valTd.appendChild(controlElement(btn));
  row.input.addEventListener('focus', () => {
    if (row.saltaProssimoFocus) { row.saltaProssimoFocus = false; return; }
    // Su mobile il pannello si apre dal pulsante: l'apertura automatica
    // coprirebbe il campo che deve aiutare (vedi inlineEdit.js).
    if (pannelloFkMobile()) return;
    if (!overlayInsertAperta(apertura)) return;
    apriPannelloPerRiga(row, apertura);
  });
  const invalida = () => { row.haFkScelto = false; row.fkValore = undefined; };
  row.input.addEventListener('input', invalida);
  row.input.addEventListener('change', invalida);
  row.input.addEventListener('keydown', (e) => {
    // Escape col pannello aperto chiude prima il pannello, non la modale.
    if (e.key === 'Escape' && pannelloFkAperto(row.input)) {
      e.stopPropagation();
      chiudiPannelloFk();
    }
  });
}

/** Collega i pulsanti quando righe E relazioni sono pronte, in ogni ordine. */
function collegaFkAlForm(apertura) {
  if (apertura !== insertAperture || !insertRelazioni) return;
  if (!overlayInsertAperta(apertura)) return;
  let fuocoSu = null;
  for (const row of insertRows) {
    if (row.fkCollegato || row.auto || row.kind === 'geo') continue;
    const nome = nomeCampoRiga(row);
    if (!nome) continue;
    const relazione = insertRelazioni.get(nome);
    if (!relazione) continue;
    row.fkRelazione = relazione;
    row.fkCollegato = true;
    collegaPulsanteFk(row, apertura);
    if (document.activeElement === row.input) fuocoSu = row;
  }
  // Il primo campo è già focalizzato dall'apertura, prima che i pulsanti
  // esistessero: senza questa, entrare nel campo non aprirebbe nulla proprio
  // nel caso più frequente (primo campo collegato).
  if (fuocoSu && !pannelloFkMobile()) apriPannelloPerRiga(fuocoSu, apertura);
}

function nascondiErroreFk() {
  const el = $('#insert-fk-error');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
}

function mostraErroreFk(messaggio, riprova) {
  let el = $('#insert-fk-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'insert-fk-error';
    el.className = 'warning';
    const form = $('#insert-tab-form');
    form.insertBefore(el, form.firstChild);
  }
  el.innerHTML = '';
  const testo = document.createElement('span');
  testo.textContent = `Riferimenti non caricati: ${messaggio}. Puoi comunque inserire i valori a mano. `;
  el.appendChild(testo);
  const btn = createArcButton({ className: 'ghost' });
  btn.textContent = 'Riprova';
  btn.addEventListener('click', riprova);
  el.appendChild(controlElement(btn));
  el.classList.remove('hidden');
}

function caricaRelazioniInsert(apertura, contesto) {
  caricaRelazioni(contesto, { lancia: true }).then((indice) => {
    if (apertura !== insertAperture) return;
    insertRelazioni = indice;
    nascondiErroreFk();
    collegaFkAlForm(apertura);
  }).catch((err) => {
    if (apertura !== insertAperture) return;
    // Il form resta utilizzabile a mano: l'errore riguarda solo i pulsanti 🔗.
    insertRelazioni = null;
    mostraErroreFk(err.message, () => {
      if (apertura !== insertAperture) return;
      nascondiErroreFk();
      caricaRelazioniInsert(apertura, contesto);
    });
  });
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

  const target = `${tabs.list.find(t => t.id === tabId)?.label || 'Connessione'} / ${db} / ${coll}`;
  $('#insert-title').textContent = isSql ? 'Nuova riga' : 'Nuovo documento';
  $('#insert-target').textContent = target;
  $('#insert-description').textContent = isSql ? 'Dai forma ai tuoi dati. I campi omessi usano il valore predefinito del database.' : 'Dai forma ai tuoi dati. Scegli il tipo BSON per ogni campo, anche per quelli nuovi.';
  proteggiModifiche('#insert-overlay', tabId, target);
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
  insertRelazioni = null;
  nascondiErroreFk();
  selectInsertTab('form', false);
  $('#insert-schema-state').textContent = 'Lettura dei campi…';
  $('#insert-save').disabled = true;
  openModal('#insert-overlay');

  // Le relazioni viaggiano in parallelo alle colonne: il form resta disponibile
  // senza attenderle e i pulsanti si collegano quando entrambi sono pronti, in
  // qualunque ordine arrivino.
  caricaRelazioniInsert(apertura, { tabId, dbType, db, coll });

  emit('collection:stats', { tabId, db, coll }).then((res) => {
    if (!overlayInsertAperta(apertura)) return;
    for (const f of (res.fields || [])) {
      const mainType = (f.types || []).find((t) => t !== 'null') || 'null';
      addInsertRow({
        name: f.name,
        typeLabel: (f.types || []).join(', '),
        kind: insertKindOf(f.baseType || mainType, dbType),
        typeName: mainType,
        numericMeta: { type: f.baseType || mainType },
        auto: !!f.generated,
        autoIncrement: !!f.autoIncrement || (f.name === '_id' && !isSql),
        default: f.default,
        enumValues: f.enumValues,
        nullable: !isSql || f.nullable,
        dbType,
        required: isSql && !f.nullable && f.default == null && !f.autoIncrement && !f.generated,
      });
    }
    if (!insertRows.length) $('#insert-form-empty').classList.remove('hidden');
    $('#insert-schema-state').textContent = `${insertRows.length} ${insertRows.length === 1 ? 'campo disponibile' : 'campi disponibili'}`;
    $('#insert-save').disabled = false;
    collegaFkAlForm(apertura);
    const first = insertRows.find((r) => !r.auto && !r.autoIncrement) || insertRows.find(r => !r.auto);
    if (first && !$('#insert-tab-form').classList.contains('hidden')) first.input.focus();
  }).catch((err) => {
    if (!overlayInsertAperta(apertura)) return;
    $('#insert-schema-state').textContent = 'Schema non disponibile · compilazione manuale';
    $('#insert-save').disabled = false;
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

  // Percorso comune di chiusura: qualunque strada nasconda la modale
  // (Annulla, Escape, salvataggio riuscito) chiude anche il pannello aperto DA
  // QUESTO form. Osservare la classe copre tutte le strade senza un gestore per
  // ogni pulsante; si chiude solo se il pannello appartiene davvero al form,
  // mai quello di una griglia.
  new MutationObserver(() => {
    if ($('#insert-overlay').classList.contains('hidden') && pannelloApertoDaInsert()) {
      chiudiPannelloFk();
    }
  }).observe($('#insert-overlay'), { attributes: true, attributeFilter: ['class'] });

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
      try {
        const parsed = JSON.parse(docText);
        if (!parsed || typeof parsed !== 'object' || (isSqlType(insertContext?.dbType) && Array.isArray(parsed))) throw new Error('Serve un oggetto JSON con i nomi dei campi.');
        if (!Array.isArray(parsed)) campiJson(docText);
      } catch (err) { showError('#insert-error', `JSON non valido: ${err.message}`); return; }
    }
    // Bersaglio congelato all'apertura della modale, mai riletto da `state`.
    const ctx = insertContext;
    const apertura = insertAperture;
    const { tabId, db, coll, dbType } = ctx || {};

    // Un inserimento premuto due volte sono due documenti: qui lo stato di
    // attesa non è cortesia, è la protezione dal doppio invio.
    conCaricamento($('#insert-save'), () => emit('doc:insert', {
      tabId,
      db,
      coll,
      doc: docText,
    }), 'Inserisco…').then(() => {
      if (apertura === insertAperture) closeModal('#insert-overlay', { saved: true });
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
      if (apertura !== insertAperture) { toast(err.message, true); return; }
      const errorEl = $('#insert-error');
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  });
}

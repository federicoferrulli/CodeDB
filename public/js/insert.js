import { state } from './state.js';
import { socket } from './socket.js';
import { $, emit, esc, toast, openModal, closeModal, isSqlType, showError, conCaricamento, captureContext, marcaDatiSporchi, lucideIconHtml as ICO, refreshLucideIcons } from './utils.js';
import { isGeometry, geometryLabel, openGeoEditor } from './geomap.js';
import { tipoGeoJsonDaTipoColonna, colonnaGeometrica } from './geojson.js';
import { runQuery } from './grid.js';
import { agganciaLint, aggiornaLint, collegaStrumentiJson } from './json-lint.js';
import { decodificaNumeroEsatto, richiedePrecisioneEsatta, testoNumeroEsatto } from './valori-esatti.js';
import { caricaRelazioni } from './fk-cache.js';
import { apriPannelloFk, chiudiPannelloFk, pannelloFkAperto, pannelloFkMobile } from './fk-vista.js';
import { setDaRelazione, bersaglioRelazione, VINCOLO } from './fk-relazioni.js';

let insertRows = [];
let insertJsonTouched = false;

// I tipi arrivano da `collection:stats` nei nomi di ciascun motore: MySQL manda
// COLUMN_TYPE ("point", "geometry"), PostgreSQL il tipo con i modificatori
// ("geometry(MultiPolygon,4326)"), MongoDB il tipo dedotto dal campione
// ("geojson", vedi bsonTypeOf in MongoDbStrategy). Riconoscerli e' una regola
// sola (`colonnaGeometrica`), condivisa con la modifica in griglia: qui c'era
// un elenco parallelo di nomi, che i tipi con modificatore non contiene.
export function insertKindOf(typeName, dbType = state.dbType) {
  const t = String(typeName || '').toLowerCase();
  if (colonnaGeometrica({ type: t })) return 'geo';
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
  btn.innerHTML = isGeometry(geo)
    ? `${ICO('map')} ${esc(geometryLabel(geo).replace(/^▦ /, ''))}`
    : `${ICO('map')} Disegna sulla mappa…`;
  refreshLucideIcons(btn);
}

export function insertInputFor(kind, { typeName = '', numericMeta = null } = {}) {
  // Geometria: il "campo" è un pulsante che apre la mappa e custodisce il
  // GeoJSON in `value` — così il resto del form (lettura, cambio tipo,
  // rimozione riga) continua a trattarlo come un input qualsiasi.
  if (kind === 'geo') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost geo-pick';
    btn.value = '';
    btn.dataset.geoType = tipoGeoJsonDaTipoColonna(typeName) || '';
    etichettaGeo(btn);
    btn.addEventListener('click', () => {
      let corrente = null;
      try { corrente = btn.value ? JSON.parse(btn.value) : null; } catch { /* si riparte da zero */ }
      openGeoEditor({
        value: corrente,
        campo: insertNomeCampo(btn),
        tipoSuggerito: btn.dataset.geoType || null,
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
  if (kind === 'number') {
    // BIGINT e BSON Long non stanno in un double senza perdere cifre: come
    // l'editing inline (buildEditor in inlineEdit.js), qui la casella diventa
    // testo, altrimenti le frecce del controllo nativo — che calcolano su
    // `valueAsNumber`, un double — arrotonderebbero un valore oltre 2^53 al
    // primo clic, prima ancora di inviarlo.
    const esatto = richiedePrecisioneEsatta(numericMeta || { type: typeName });
    i.type = esatto ? 'text' : 'number';
    if (!esatto) i.step = 'any';
  }
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
    numericMeta: opts.numericMeta || {},
    // Stato FK (piano inserimento-foreign-key): la relazione collegata, il
    // valore EJSON esatto scelto dal pannello e il flag che dice se usarlo.
    // Finché l'utente non digita a mano, il documento usa la copia esatta —
    // il controllo testuale non rappresenta fedelmente BIGINT oltre 2^53,
    // ObjectId, date, null e stringa vuota.
    fkRelazione: null,
    fkCollegato: false,
    fkValore: undefined,
    haFkScelto: false,
    saltaProssimoFocus: false,
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
    row.input = insertInputFor(row.kind, { typeName: opts.typeName, numericMeta: row.numericMeta });
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
  // Valore scelto dal pannello FK: passa senza perdite, senza ripassare dal
  // parser del controllo (che arrotonderebbe un BIGINT o scambierebbe un
  // ObjectId per una stringa). Una digitazione manuale invalida la copia e
  // torna qui sotto.
  if (row.haFkScelto) return row.fkValore === undefined ? undefined : row.fkValore;
  const raw = row.input.value;
  const t = String(raw == null ? '' : raw).trim();
  if (t === '') return undefined;
  switch (row.kind) {
    case 'number': {
      return decodificaNumeroEsatto(t, row.numericMeta);
    }
    case 'decimal':
      return decodificaNumeroEsatto(t, { ...row.numericMeta, wrapper: '$numberDecimal' });
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
  if (name === 'json') {
    // Il pannello appartiene a un campo del modulo: sulla scheda JSON sarebbe
    // orfano sopra un editor libero. La bozza resta, il pannello no.
    if (pannelloApertoDaInsert()) chiudiPannelloFk();
    if (!insertJsonTouched && !$('#insert-tab-form').classList.contains('hidden')) {
      try {
        $('#insert-json').value = JSON.stringify(buildInsertDoc(), null, 2);
      } catch { /* ignore */ }
    }
  }
  document.querySelectorAll('[data-instab]').forEach((t) => t.classList.toggle('active', t.dataset.instab === name));
  $('#insert-tab-form').classList.toggle('hidden', name !== 'form');
  $('#insert-tab-json').classList.toggle('hidden', name !== 'json');
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
    if (typeof v.$oid === 'string') return v.$oid;
    if (v.$numberLong !== undefined || v.$numberDecimal !== undefined
      || v.$numberInt !== undefined || v.$numberDouble !== undefined) {
      return testoNumeroEsatto(v);
    }
    if (v.$date !== undefined) {
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
  try {
    row.input.value = testoPerControllo(row, valore);
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
        if (!destino || destino.auto || !document.contains(destino.input) || destino.input.disabled) {
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
  const valTd = row.input.parentElement;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fk-apri-btn';
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
  valTd.appendChild(btn);
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
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.textContent = 'Riprova';
  btn.addEventListener('click', riprova);
  el.appendChild(btn);
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
  insertRelazioni = null;
  nascondiErroreFk();
  selectInsertTab('form');
  openModal('#insert-overlay');

  // Le relazioni viaggiano in parallelo alle colonne: il form resta disponibile
  // senza attenderle e i pulsanti si collegano quando entrambi sono pronti, in
  // qualunque ordine arrivino.
  caricaRelazioniInsert(apertura, { tabId, dbType, db, coll });

  emit('collection:stats', { tabId, db, coll }).then((res) => {
    if (apertura !== insertAperture) return; // modale riaperta nel frattempo (CDB-14)
    for (const f of (res.fields || [])) {
      if (f.name === '_id' && !isSql) continue;
      const mainType = (f.types || []).find((t) => t !== 'null') || 'null';
      addInsertRow({
        name: f.name,
        typeLabel: (f.types || []).join(', '),
        kind: insertKindOf(mainType, dbType),
        typeName: mainType,
        numericMeta: { type: mainType },
        auto: !!f.autoIncrement || !!f.generated,
        required: isSql && !f.nullable && f.default == null && !f.autoIncrement && !f.generated,
      });
    }
    if (!insertRows.length) $('#insert-form-empty').classList.remove('hidden');
    collegaFkAlForm(apertura);
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

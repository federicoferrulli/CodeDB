import { state } from './state.js';
import { $, emit, isPlainObject, valueType, displayValue, editValue, parseEdited, idOf, toast, openModal, closeModal, isForActiveTab, captureContext, marcaDatiSporchi, conCaricamento } from './utils.js';
import { runQuery, renderGrid, relazioneDiCampo } from './grid.js';
import { isGeometry, openGeoEditor } from './geomap.js';
import { apriPannelloFk, chiudiPannelloFk, pannelloFkAperto, fuocoNelPannelloFk, pannelloFkMobile } from './fk-vista.js';

/**
 * Costruisce l'input adatto al tipo del valore.
 *
 * Oltre a `buildValue` (input → valore da salvare) ogni editor espone il
 * percorso inverso, `setValue` (valore → input). Serve al pannello delle chiavi
 * esterne, che consegna un valore già tipizzato preso da un'altra tabella:
 * scriverlo sempre come JSON avrebbe funzionato per i testi e fallito proprio
 * dove il pannello è più utile — un ObjectId sarebbe finito nella casella come
 * `{"$oid":"..."}`, che l'editor rifiuta come non valido. Ogni ramo sa già in
 * che forma vuole il proprio input: qui gliela si fa dire, invece di
 * indovinarla da fuori.
 */
export function buildEditor(current) {
  const type = valueType(current);

  if (type === 'date') {
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.step = '0.001';
    // ORA UTC, non locale (CDB-15). Il controllo `datetime-local` è per
    // definizione ora locale, e qui invece si mostra e si rilegge UTC: la scelta
    // è voluta — la griglia stampa `toISOString()`, l'export e l'EJSON parlano
    // UTC, e mostrare l'ora locale solo nell'editor significherebbe vedere due
    // orari diversi per lo stesso istante (e un valore che cambia in viaggio).
    // Quello che mancava era DIRLO: senza, chi scrive "10:00" crede di indicare
    // le 10:00 di casa propria e ne salva altre.
    input.title = 'Ora UTC, come nella griglia (non l\'ora locale del computer)';
    input.setAttribute('aria-label', 'Data e ora in UTC');
    input.classList.add('input-utc');
    const setValue = (v) => {
      const raw = (v && isPlainObject(v.$date)) ? Number(v.$date.$numberLong)
        : (v && v.$date !== undefined) ? v.$date : v;
      const d = new Date(raw);
      input.value = Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 23);
    };
    setValue(current);
    return {
      input,
      setValue,
      original: input.value,
      buildValue: () => {
        const d2 = new Date(input.value + 'Z');
        if (input.value === '' || Number.isNaN(d2.getTime())) throw new Error('Data non valida');
        return { $date: d2.toISOString() };
      },
    };
  }

  if (type === 'bool') {
    const input = document.createElement('select');
    for (const v of ['true', 'false']) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      input.appendChild(opt);
    }
    const setValue = (v) => { input.value = String(v); };
    setValue(current);
    return { input, setValue, original: input.value, buildValue: () => input.value === 'true' };
  }

  if (type === 'number') {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    const setValue = (v) => { input.value = displayValue(v).text; };
    setValue(current);
    return {
      input,
      setValue,
      original: input.value,
      buildValue: () => {
        const n = Number(input.value);
        if (input.value.trim() === '' || Number.isNaN(n)) throw new Error('Numero non valido');
        return n;
      },
    };
  }

  if (type === 'decimal') {
    const input = document.createElement('input');
    const setValue = (v) => { input.value = (v && v.$numberDecimal !== undefined) ? v.$numberDecimal : String(v ?? ''); };
    setValue(current);
    return {
      input,
      setValue,
      original: input.value,
      buildValue: () => ({ $numberDecimal: input.value.trim() }),
    };
  }

  if (type === 'oid') {
    const input = document.createElement('input');
    // Il pannello delle chiavi esterne consegna l'ObjectId in forma EJSON
    // ({$oid}); la casella vuole i 24 esadecimali nudi, che è anche ciò che
    // `buildValue` riconvaliderà.
    const setValue = (v) => { input.value = (v && typeof v.$oid === 'string') ? v.$oid : String(v ?? ''); };
    setValue(current);
    return {
      input,
      setValue,
      original: input.value,
      buildValue: () => {
        const t = input.value.trim();
        if (!/^[0-9a-fA-F]{24}$/.test(t)) throw new Error('ObjectId non valido: servono 24 caratteri esadecimali');
        return { $oid: t };
      },
    };
  }

  const input = document.createElement('input');
  const setValue = (v) => { input.value = editValue(v); };
  setValue(current);
  return { input, setValue, original: input.value, buildValue: () => parseEdited(input.value) };
}

/**
 * Scrive un singolo campo della riga. Estratta dal salvataggio inline perché la
 * usa anche l'editor su mappa, che risponde molto DOPO l'apertura: il contesto
 * (tab e collection) va quindi congelato all'inizio, altrimenti una geometria
 * confermata dopo un cambio di tab finirebbe nella tabella sbagliata.
 */
export function salvaCampo(doc, field, value, ctx) {
  // `contestoScrittura()` e non `captureContext()`: quest'ultima non porta
  // db/coll, quindi il ripiego avrebbe scritto con un bersaglio indefinito.
  // Oggi entrambi i chiamanti passano `ctx`, ma il ripiego non deve essere
  // una trappola per il prossimo.
  const c = ctx || contestoScrittura();
  return emit('doc:update', {
    tabId: c.tabId,
    db: c.db,
    coll: c.coll,
    id: idOf(doc),
    set: { [field]: value },
  }).then((res) => {
    toast(`Campo "${field}" aggiornato`);
    // Il refresh rilegge dagli input del workspace, che appartengono al tab
    // mostrato: se l'utente si è spostato altrove, rileggerebbe la collection
    // sbagliata. La scrittura è comunque andata a buon fine.
    if (isForActiveTab(res) && c.isStillActive()) runQuery({ auto: true }); // refresh post-scrittura
    else marcaDatiSporchi(c, c.db, c.coll);
  }).catch((err) => {
    toast(err.message, true);
    if (isForActiveTab(err)) renderGrid({ preserveScroll: true });
  });
}

// Contesto di scrittura completo: tab, coll-tab e bersaglio db/collection.
function contestoScrittura() {
  const c = captureContext();
  return Object.assign(c, { db: state.db, coll: state.coll });
}

export function startEdit(td, doc, field) {
  if (td.classList.contains('editing')) return;

  // Geometrie: non c'è un `input` sensato in cui scriverle a mano. Si apre
  // l'editor su mappa, che è anche l'unico modo di CAPIRE cosa si sta
  // modificando; il salvataggio è lo stesso `doc:update` degli altri campi.
  if (isGeometry(doc[field])) {
    const ctx = contestoScrittura();
    openGeoEditor({
      value: doc[field],
      campo: field,
      onSave: (geo) => salvaCampo(doc, field, geo, ctx),
    });
    return;
  }

  const { input, original, buildValue, setValue } = buildEditor(doc[field]);

  td.classList.add('editing');
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  if (input.select) input.select();

  let finished = false;

  const cancel = () => {
    if (finished) return;
    finished = true;
    chiudiPannelloFk();
    renderGrid({ preserveScroll: true });
  };

  const save = () => {
    if (finished) return;
    finished = true;
    chiudiPannelloFk();
    if (input.value === original) {
      renderGrid({ preserveScroll: true });
      return;
    }
    let value;
    try {
      value = buildValue();
    } catch (err) {
      toast(err.message, true);
      renderGrid({ preserveScroll: true });
      return;
    }
    salvaCampo(doc, field, value, contestoScrittura());
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') cancel();
  });
  // Uscire dal campo salva, TRANNE quando il fuoco è finito dentro il pannello
  // di riferimento: lì la modifica non è finita, l'utente è andato a cercare il
  // valore da metterci, e chiudere l'editor farebbe sparire proprio la cella
  // che si sta per riempire. `relatedTarget` è dove sta andando il fuoco;
  // quando il browser non lo fornisce si guarda dove è effettivamente finito.
  input.addEventListener('blur', (e) => {
    if (fuocoNelPannelloFk(e.relatedTarget || document.activeElement)) return;
    save();
  });
  if (input.tagName === 'SELECT') input.addEventListener('change', save);

  // Colonna collegata a un'altra tabella: il pannello di scelta si apre da solo
  // e accanto all'input compare 🔗 per riaprirlo se lo si è chiuso. Va tutto
  // DOPO `save`, perché il pannello scrive attraverso di lui.
  const relazione = relazioneDiCampo(field);
  if (relazione) {
    const editor = { input, setValue, save };
    aggiungiPulsanteFk(td, editor, doc, field, relazione);
    // Apertura automatica: dietro un pulsante l'aiuto lo trovava solo chi già
    // sapeva che esistesse, cioè non chi ne aveva bisogno. Non ruba il fuoco,
    // quindi chi sa già cosa scrivere continua a digitare senza accorgersene.
    //
    // Su MOBILE no, e non è un ripiego: l'apertura automatica si regge sul fatto
    // che la cella resti visibile ACCANTO al pannello. Su un telefono il foglio
    // occupa la metà bassa e la tastiera virtuale il resto, quindi la cella che
    // si sta modificando sparirebbe sotto entrambi — l'aiuto coprirebbe proprio
    // ciò che deve aiutare. Lì il pannello si apre col 🔗, quando lo si vuole.
    if (!pannelloFkMobile()) mostraPannelloFk(td, editor, doc, field, relazione);
  }
}

/**
 * Apre il pannello di scelta sulla cella in modifica.
 *
 * Il pannello riceve il contesto CONGELATO (documento e bersaglio di scrittura
 * al momento dell'apertura). Serve perché la scelta arriva molto dopo: se nel
 * frattempo l'editor è stato smontato, il valore viene scritto direttamente con
 * `salvaCampo` sullo stesso documento di partenza, non su quello che si trova
 * sotto il cursore adesso.
 */
function mostraPannelloFk(td, editor, doc, field, relazione) {
  const { input, setValue, save } = editor;
  const ctx = contestoScrittura();
  apriPannelloFk({
    relazione,
    valore: doc[field],
    dbCorrente: ctx.db,
    tabId: ctx.tabId,
    // La cella a cui il pannello si allinea: è ciò che lo fa leggere come un
    // aiuto a QUESTA riga e non come un pannello dell'applicazione.
    ancora: td,
    onScegli: (valore) => {
      // Editor ancora vivo (il caso normale): si riempie e si salva dallo
      // stesso percorso dell'Invio, così validazione, messaggi ed eventuale
      // rifiuto sono quelli di sempre. Se invece è già stato smontato — un
      // clic altrove, un refresh della griglia sotto — si scrive diretto sul
      // documento e sul bersaglio congelati all'apertura: "Usa questo valore"
      // deve fare la stessa cosa in entrambi i casi.
      if (document.contains(input)) {
        setValue(valore);
        input.focus();
        save();
      } else {
        salvaCampo(doc, field, valore, ctx);
      }
    },
  });
}

/**
 * Pulsante 🔗 accanto all'input di una cella collegata: riapre il pannello dopo
 * averlo chiuso, e lo richiude se è già aperto.
 *
 * Il punto delicato è il `mousedown`: senza `preventDefault()` il clic toglie
 * il fuoco all'input, che salva e ridisegna la griglia — il pulsante sparirebbe
 * *prima* del proprio `click`, e non succederebbe assolutamente nulla.
 */
function aggiungiPulsanteFk(td, editor, doc, field, relazione) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fk-apri-btn';
  btn.textContent = '🔗';
  btn.tabIndex = -1; // il Tab dell'editor resta quello di sempre
  btn.title = `Mostra la riga di ${relazione.tabella} riferita da questo valore`;
  btn.setAttribute('aria-label', `Riferimento a ${relazione.tabella}`);
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    if (pannelloFkAperto()) chiudiPannelloFk();
    else mostraPannelloFk(td, editor, doc, field, relazione);
  });
  td.appendChild(btn);
}

let editDocContext = null;
// Documento in modifica (CDB-52). Stava in `state.editingDoc`, cioè nel Proxy
// che punta SEMPRE al tab attivo: aprendo la modale e passando a un altro tab
// prima di salvare, `state.editingDoc` era quello dell'ALTRO tab — nel migliore
// dei casi il salvataggio non faceva nulla (nessun documento in modifica lì),
// nel peggiore scriveva su un `_id` che appartiene a un'altra connessione.
// La modale è una sola e globale: il documento vive qui, accanto al suo
// contesto, e non in uno stato che cambia sotto i piedi.
let editingDoc = null;

export function openEditDoc(doc, context = null) {
  editingDoc = doc;
  if (context) {
    editDocContext = context;
  } else {
    const origin = captureContext();
    editDocContext = Object.assign(origin, { db: state.db, coll: state.coll });
  }
  // I campi sono dati, non proprietà di controllo del prototipo.
  const copy = Object.create(null);
  for (const [k, v] of Object.entries(doc)) {
    if (k !== '_id') copy[k] = v;
  }
  $('#editdoc-id').textContent = `_id: ${displayValue(doc._id).text} (non modificabile)`;
  $('#editdoc-json').value = JSON.stringify(copy, null, 2);
  $('#editdoc-error').classList.add('hidden');
  openModal('#editdoc-overlay');
  $('#editdoc-json').focus();
}

export function initInlineEdit() {
  $('#editdoc-cancel').addEventListener('click', () => closeModal('#editdoc-overlay'));

  $('#editdoc-save').addEventListener('click', () => {
    if (!editingDoc) return;
    const ctx = editDocContext;
    const doc = editingDoc;
    const tabId = ctx ? ctx.tabId : undefined;
    const db = ctx ? ctx.db : state.db;
    const coll = ctx ? ctx.coll : state.coll;

    conCaricamento($('#editdoc-save'), () => emit('doc:replace', {
      tabId,
      db,
      coll,
      id: idOf(doc),
      doc: $('#editdoc-json').value,
    }), 'Salvo…').then((res) => {
      closeModal('#editdoc-overlay');
      toast('Documento aggiornato');
      if (ctx && ctx.onSaveSuccess) {
        ctx.onSaveSuccess();
      } else if (ctx && ctx.isStillActive && ctx.isStillActive()) {
        runQuery({ auto: true }); // refresh post-scrittura
      } else {
        marcaDatiSporchi(ctx, db, coll);
      }
    }).catch((err) => {
      const errorEl = $('#editdoc-error');
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    });
  });
}


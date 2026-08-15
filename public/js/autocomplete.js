/**
 * CodeDB — Completamento automatico (IntelliSense) sulle caselle e sull'editor
 *
 * Due agganci, un solo motore:
 *
 *  - `attachAutocomplete(input)` — le caselle di filtro e ordinamento della
 *    griglia, dove si scrive un frammento (una condizione, un ordinamento) e
 *    le colonne buone sono quelle della tabella aperta.
 *  - `attachEditorAutocomplete(textarea)` — l'editor ⚡ Query & Aggregate, dove
 *    si scrivono query intere: lì le colonne della tabella aperta sono quasi
 *    sempre le colonne SBAGLIATE, perché la query può parlare di tutt'altro.
 *    I suggerimenti vengono dallo **schema del database**, letti dal punto in
 *    cui sta il cursore (dopo `FROM` tabelle, dopo `u.` le colonne di `u`,
 *    dopo `db.` le collezioni). La decisione sta in `intellisense.js`, che è
 *    puro e testato; qui c'è solo il DOM.
 *
 * Lo schema si scarica una volta per (connessione, database) con `db:schema` —
 * la stessa chiamata dello Schema Browser — e si tiene in cache: il
 * completamento non può permettersi un giro di rete a ogni tasto premuto. La
 * cache va buttata quando la struttura cambia (`invalidaSchemaIntellisense`).
 */

import { state } from './state.js';
import { activeTab } from './tabs.js';
import { $, emit, isSqlType } from './utils.js';
import {
  suggerisci, applicaSuggerimento, PAROLE_SQL_WHERE,
} from './intellisense.js';

/* ==========================================================================
 * Cache dello schema
 * ========================================================================== */

const cacheSchema = new Map();   // "tabId::db" → { tabelle: [...] }
const inCorso = new Map();       // richieste già partite, per non duplicarle
const inAscolto = new Set();     // callback da richiamare quando lo schema arriva

function chiaveSchema(tabId, db) {
  return `${tabId || ''}::${db || ''}`;
}

/** Normalizza la risposta di `db:schema` nella forma attesa da intellisense.js. */
export function schemaDaCollections(collections) {
  const tabelle = (collections || []).map((item) => {
    if (typeof item === 'string') return { nome: item, campi: [] };
    const nome = item && item.name ? item.name : String(item);
    const campi = (item && Array.isArray(item.fields) ? item.fields : []).map((f) => {
      if (typeof f === 'string') return { nome: f, tipo: '' };
      const tipo = f.type || (Array.isArray(f.types) ? f.types.join('|') : (f.dataType || ''));
      return { nome: f.name || f.column || '', tipo };
    }).filter((c) => c.nome);
    return { nome, campi };
  });
  return { tabelle };
}

/**
 * Schema del database corrente, se già in cache. Se non c'è lo chiede (una
 * volta sola) e restituisce `null`: il completamento continua a funzionare con
 * quello che sa, e la prossima digitazione avrà l'elenco completo.
 */
export function schemaCorrente() {
  const tab = activeTab();
  const tabId = tab ? tab.id : undefined;
  const db = state.db;
  if (!db) return null;

  const chiave = chiaveSchema(tabId, db);
  if (cacheSchema.has(chiave)) return cacheSchema.get(chiave);
  if (inCorso.has(chiave)) return null;

  inCorso.set(chiave, true);
  emit('db:schema', { tabId, db })
    .then((res) => {
      cacheSchema.set(chiave, schemaDaCollections(res && res.collections));
      inAscolto.forEach((fn) => { try { fn(); } catch { /* un ascoltatore rotto non ferma gli altri */ } });
    })
    .catch(() => {
      // Niente schema (permessi, connessione caduta, database enorme): il
      // completamento resta quello di prima, senza rumore. Si segna comunque
      // un risultato vuoto per non ritentare a ogni tasto.
      cacheSchema.set(chiave, { tabelle: [] });
    })
    .finally(() => inCorso.delete(chiave));

  return null;
}

/**
 * Butta lo schema in cache. Va chiamata quando la struttura cambia (DDL,
 * cambio di connessione): un elenco di tabelle che non esistono più è peggio
 * di nessun elenco.
 * @param {string} [db] solo quel database; senza argomento, tutto.
 */
export function invalidaSchemaIntellisense(db) {
  if (!db) { cacheSchema.clear(); return; }
  for (const chiave of [...cacheSchema.keys()]) {
    if (chiave.endsWith(`::${db}`)) cacheSchema.delete(chiave);
  }
}

/* ==========================================================================
 * Dropdown condiviso
 * ========================================================================== */

const ICONE = {
  campo: '🔹', tabella: '📋', parola: '⌨', funzione: 'ƒ',
  operatore: '$', metodo: '▸',
};

function creaLista(dentro, flottante) {
  const list = document.createElement('ul');
  list.className = `ac-list hidden${flottante ? ' ac-flottante' : ''}`;
  list.setAttribute('role', 'listbox');
  dentro.appendChild(list);
  return list;
}

function disegnaVoci(list, voci, onScegli) {
  list.innerHTML = '';
  voci.forEach((voce, idx) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.i = String(idx);

    const icona = document.createElement('span');
    icona.className = 'ac-icona';
    icona.textContent = ICONE[voce.tipo] || '•';
    const testo = document.createElement('span');
    testo.className = 'ac-testo';
    testo.textContent = voce.testo;
    li.append(icona, testo);

    if (voce.dettaglio) {
      const det = document.createElement('span');
      det.className = 'ac-dettaglio';
      det.textContent = voce.dettaglio;
      li.appendChild(det);
    }

    li.addEventListener('mousedown', (e) => {
      // `mousedown` e non `click`: al click il campo ha già perso il fuoco e
      // il dropdown si è chiuso.
      e.preventDefault();
      onScegli(idx);
    });
    list.appendChild(li);
  });
}

/**
 * Coordinate del cursore dentro una textarea, in pixel dello schermo.
 *
 * Una textarea non espone la posizione del cursore: l'unico modo è ricostruire
 * il testo in un elemento con gli STESSI stili e misurare dove finisce. Il
 * "mirror" viene ricreato a ogni chiamata perché il tema (e quindi il font)
 * può essere cambiato nel frattempo.
 */
function coordinateCursore(textarea) {
  const rect = textarea.getBoundingClientRect();
  const stile = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const copia = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
    'lineHeight', 'textTransform', 'wordSpacing', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  ];
  for (const p of copia) mirror.style[p] = stile[p];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.top = '0';
  mirror.style.left = '-9999px';

  const pos = textarea.selectionStart;
  mirror.textContent = textarea.value.slice(0, pos);
  const segno = document.createElement('span');
  segno.textContent = '​';
  mirror.appendChild(segno);
  document.body.appendChild(mirror);

  const alto = parseFloat(stile.lineHeight) || parseFloat(stile.fontSize) * 1.2 || 16;
  const x = rect.left + segno.offsetLeft - textarea.scrollLeft;
  const y = rect.top + segno.offsetTop - textarea.scrollTop + alto;
  mirror.remove();

  return { x, y, alto };
}

/* Il dropdown flottante non deve uscire dalla finestra: se sotto non c'è
   spazio si apre verso l'alto. */
function posizionaFlottante(list, { x, y, alto }) {
  list.style.left = `${Math.max(4, Math.min(x, window.innerWidth - 260))}px`;
  const altezza = list.offsetHeight || 200;
  const sotto = window.innerHeight - y;
  list.style.top = sotto < altezza + 8 ? `${Math.max(4, y - alto - altezza)}px` : `${y}px`;
}

/* ==========================================================================
 * Motore comune ai due agganci
 * ========================================================================== */

// Oltre questa lunghezza il testo non viene analizzato tutto: l'analisi del
// contesto gira a ogni tasto premuto, e su un file SQL da un megabyte
// costerebbe più della digitazione. Si guarda una finestra attorno al cursore,
// abbastanza larga da contenere la query in cui si sta scrivendo.
const SOGLIA_TESTO_LUNGO = 100000;
const FINESTRA = 20000;

function finestraAnalisi(valore, cursore) {
  if (valore.length <= SOGLIA_TESTO_LUNGO) return { testo: valore, cursore };
  const da = Math.max(0, cursore - FINESTRA);
  const a = Math.min(valore.length, cursore + FINESTRA);
  return { testo: valore.slice(da, a), cursore: cursore - da };
}

/**
 * @param {HTMLElement} campo   input o textarea
 * @param {object} opts
 * @param {HTMLElement} opts.contenitore  dove appendere la lista
 * @param {boolean} opts.flottante        posizionata al cursore (textarea)
 * @param {() => object} opts.contesto    { motore, schema, colonne, collezione, parole, vocabolario }
 * @param {() => void} [opts.onApplicato] dopo l'inserimento (ridisegni dell'editor)
 */
function agganciaMotore(campo, opts) {
  const list = creaLista(opts.contenitore, !!opts.flottante);
  let voci = [];
  let attivo = -1;
  let ultimaRichiesta = false; // l'ultima apertura è stata chiesta con Ctrl+Spazio?

  function chiudi() {
    list.classList.add('hidden');
    list.innerHTML = '';
    voci = [];
    attivo = -1;
    campo.removeAttribute('aria-activedescendant');
  }

  function evidenzia() {
    [...list.children].forEach((li, i) => li.classList.toggle('active', i === attivo));
    if (attivo >= 0 && list.children[attivo]) list.children[attivo].scrollIntoView({ block: 'nearest' });
  }

  function calcola(forzato) {
    const ctx = opts.contesto() || {};
    const { testo, cursore } = finestraAnalisi(campo.value, campo.selectionStart ?? campo.value.length);
    return suggerisci({
      testo,
      cursore,
      motore: ctx.motore || 'sql',
      ripiego: ctx.ripiego || 'sql',
      schema: ctx.schema || null,
      colonne: ctx.colonne || [],
      collezione: ctx.collezione || '',
      parole: ctx.parole !== false,
      vocabolario: ctx.vocabolario || null,
      limite: forzato ? 20 : 12,
    });
  }

  function apri(forzato) {
    const cursore = campo.selectionStart ?? 0;
    const prefisso = /[\w$.]$/.test(campo.value.slice(0, cursore));
    // Senza niente di scritto il dropdown si apre SOLO su richiesta esplicita:
    // altrimenti comparirebbe a ogni spazio, coprendo il testo.
    if (!forzato && !prefisso) { chiudi(); return; }

    voci = calcola(forzato);
    if (!voci.length) { chiudi(); return; }

    ultimaRichiesta = !!forzato;
    disegnaVoci(list, voci, (i) => { applica(i); });
    attivo = -1;
    list.classList.remove('hidden');
    if (opts.flottante) posizionaFlottante(list, coordinateCursore(campo));
  }

  function applica(i) {
    const voce = voci[i];
    if (!voce) return;
    const { testo, cursore } = applicaSuggerimento(campo.value, campo.selectionStart ?? 0, voce.testo);
    campo.value = testo;
    campo.setSelectionRange(cursore, cursore);
    campo.focus();
    chiudi();
    if (typeof opts.onApplicato === 'function') opts.onApplicato();
  }

  campo.addEventListener('input', () => apri(false));

  campo.addEventListener('keydown', (e) => {
    // Ctrl+Spazio (o Cmd+Spazio): apre l'elenco completo dove sta il cursore.
    if ((e.ctrlKey || e.metaKey) && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      apri(true);
      return;
    }
    if (list.classList.contains('hidden')) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopImmediatePropagation();
      attivo = (attivo + 1) % voci.length;
      evidenzia();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      attivo = (attivo - 1 + voci.length) % voci.length;
      evidenzia();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // Invio senza una voce scelta deve restare Invio (esegui / a capo):
      // rubarlo sempre renderebbe impossibile scrivere. Il Tab, quando c'è un
      // elenco aperto, accetta la prima voce.
      if (attivo >= 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        applica(attivo);
      } else if (e.key === 'Tab' && voci.length) {
        e.preventDefault();
        e.stopImmediatePropagation();
        applica(0);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      chiudi();
    }
  }, true); // fase di cattura: arriva prima di chi gestisce Tab e Ctrl+Invio

  campo.addEventListener('blur', () => chiudi());
  campo.addEventListener('scroll', () => {
    if (!list.classList.contains('hidden') && opts.flottante) {
      posizionaFlottante(list, coordinateCursore(campo));
    }
  });

  const ridisegna = () => { if (!list.classList.contains('hidden')) apri(ultimaRichiesta); };
  inAscolto.add(ridisegna);

  return { chiudi, apri };
}

/* ==========================================================================
 * Aggancio 1 — caselle della griglia (filtro, ordinamento)
 * ========================================================================== */

export function attachAutocomplete(input, opts = {}) {
  let wrap = input.closest('.ac-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'ac-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
  }

  return agganciaMotore(input, {
    contenitore: wrap,
    flottante: false,
    contesto: () => {
      const isSql = isSqlType(state.dbType);
      const aggregate = $('#query-mode') ? $('#query-mode').value === 'aggregate' : false;
      return {
        motore: isSql ? 'sql' : 'mongo',
        // Qui lo schema serve solo per i TIPI delle colonne: la tabella è una
        // sola ed è quella aperta, quindi non si scarica niente apposta.
        schema: null,
        colonne: state.columns || [],
        collezione: state.coll || '',
        parole: opts.keywords !== false,
        // Nel filtro non si scrive una query intera: proporre `SELECT` o
        // `CREATE TABLE` sarebbe fuorviante. Nella casella di ordinamento
        // (keywords:false) non si propone nessuna parola.
        vocabolario: isSql && !aggregate ? PAROLE_SQL_WHERE : null,
      };
    },
  });
}

/* ==========================================================================
 * Aggancio 2 — editor ⚡ Query & Aggregate
 * ========================================================================== */

/**
 * Ripiego per la lingua dell'editor: si usa SOLO finché il testo non dice da
 * sé se è SQL o MQL. Il selettore del bersaglio (`#query-target-engine`) sceglie
 * il MOTORE di esecuzione, non la lingua: su MongoDB si può scrivere SQL (che
 * viene tradotto in MQL), quindi neppure "🍃 MongoDB" può escludere l'SQL.
 */
function ripiegoLingua(sceltaMotore) {
  if (sceltaMotore === 'mysql' || sceltaMotore === 'postgresql' || sceltaMotore === 'crossdb') return 'sql';
  if (sceltaMotore === 'mongodb') return 'mongo';
  return isSqlType(state.dbType) ? 'sql' : 'mongo';
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {object} opts
 * @param {() => string} opts.motore  valore di `#query-target-engine`
 * @param {() => void} [opts.onApplicato]
 */
export function attachEditorAutocomplete(textarea, opts = {}) {
  if (!textarea) return null;

  return agganciaMotore(textarea, {
    contenitore: document.body,
    flottante: true,
    onApplicato: opts.onApplicato,
    contesto: () => {
      const scelto = typeof opts.motore === 'function' ? opts.motore() : 'auto';
      return {
        // La lingua la decide il testo sotto il cursore (vedi motoreDalTesto):
        // uno script può contenere un `SELECT` e un `db.coll.find()`, e ogni
        // istruzione va completata nella sua lingua.
        motore: 'auto',
        ripiego: ripiegoLingua(scelto),
        schema: schemaCorrente(),
        colonne: state.columns || [],
        collezione: state.coll || '',
        parole: true,
      };
    },
  });
}

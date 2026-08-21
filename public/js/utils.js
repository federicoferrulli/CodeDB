import { socket } from './socket.js';
import { state } from './state.js';
import { tabs, activeTab } from './tabs.js';
import { isGeometry, geometryLabel } from './geojson.js';
import { isPlainObject, ejsonKind, fmtBytes, safeUUID, jsonBreve, tronca } from './valori.js';
// L'avviso passeggero vive in un modulo foglia: il trasporto ne ha bisogno e
// non puo' importare questo file (vedi la nota sul trasporto piu' sotto).
import { toast } from './avvisi.js';

export const $ = (sel) => document.querySelector(sel);

// Definiti in valori.js (modulo foglia, senza import) e ri-esportati qui: chi
// li importava da utils.js continua a funzionare, ma chi ha bisogno solo di
// questi non è costretto a caricare l'intera applicazione (vedi la nota in
// testa a valori.js).
export { isPlainObject, ejsonKind, fmtBytes, safeUUID };
export { toast };

export function displayValue(v) {
  if (v === null || v === undefined) return { text: '–', cls: 'type-null' };
  if (Array.isArray(v)) return { text: JSON.stringify(v.map(simplify)), cls: 'type-obj' };
  // Geometrie: in cella l'elenco delle coordinate non dice nulla e rompe il
  // layout. Si mostra tipo e numero di vertici; il contenuto vero si apre con
  // un doppio clic (editor su mappa). La copia delle celle non passa di qui:
  // legge `state.docs`, quindi continua a copiare il GeoJSON completo.
  if (isGeometry(v)) return { text: geometryLabel(v), cls: 'type-geo' };

  const kind = ejsonKind(v);
  if (kind === 'oid') return { text: v.$oid, cls: 'type-oid' };
  if (kind === 'date') {
    const d = isPlainObject(v.$date) ? Number(v.$date.$numberLong) : v.$date;
    const date = new Date(d);
    // Data invalida (es. DATETIME azzerati): non deve far saltare il render
    // dell'intera griglia con il RangeError di toISOString().
    if (isNaN(date.getTime())) return { text: String(d), cls: 'type-date' };
    return { text: date.toISOString(), cls: 'type-date' };
  }
  if (kind === 'number') {
    // 'number' copre sia le forme EJSON canoniche ({"$numberLong": "..."})
    // sia i numeri JS puri (il server serializza relaxed): vanno distinti.
    const text = isPlainObject(v)
      ? String(v.$numberInt ?? v.$numberLong ?? v.$numberDouble)
      : String(v);
    return { text, cls: 'type-num' };
  }
  if (kind === 'decimal') return { text: String(v.$numberDecimal), cls: 'type-num' };
  if (kind === 'binary') {
    const b64 = v.$binary.base64 || '';
    const size = Math.max(0, Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0));
    let hex = '';
    if (size > 0) {
      const header = atob(b64.slice(0, 16)).substring(0, 8);
      for (let i = 0; i < Math.min(header.length, 8); i++) {
        hex += header.charCodeAt(i).toString(16).padStart(2, '0').toUpperCase() + ' ';
      }
      if (size > 8) hex += '...';
    }
    return { text: `[BLOB ${fmtBytes(size)}] ${hex.trim()}`, cls: 'type-obj' };
  }
  if (kind === 'object') return { text: JSON.stringify(simplify(v)), cls: 'type-obj' };
  if (kind === 'boolean') return { text: String(v), cls: 'type-bool', dataVal: String(v) };
  return { text: String(v), cls: '' };
}

/**
 * Testo di una cella per il solo DISEGNO, con un tetto di caratteri.
 *
 * Identico a `displayValue` su tutto ciò che è breve; su oggetti e array si
 * ferma dopo `max` caratteri invece di serializzare l'intero valore. Un
 * documento da 25 MB in una cella costava ~144 ms di `simplify` + `stringify`
 * per cella e per fotogramma di scorrimento (la griglia è virtualizzata e
 * ridisegna ~20 righe alla volta), per mostrare i sessanta caratteri che
 * entrano nella colonna.
 *
 * Il tetto vale per OGNI tipo di valore, non solo per oggetti e array. Una
 * colonna TEXT/BLOB con dentro un documento, un log o un base64 è una STRINGA
 * semplice: prendeva il ramo `displayValue` e tornava indietro per intero, e da
 * lì finiva in tre posti che la pagano tutti e tre — `textContent` (un nodo di
 * testo da megabyte da impaginare), `title` (un attributo della stessa
 * dimensione, per un fumetto che nessuno leggerà) e `measureText` durante il
 * calcolo delle larghezze. Moltiplicato per le ~20 righe che la griglia
 * virtualizzata ridisegna a ogni fotogramma di scorrimento, è il blocco del
 * thread principale.
 *
 * NON va usata dove il valore serve per intero — copia delle celle
 * (`cellselect.js`), modifica al volo (`inlineEdit.js`), export: lì il testo
 * troncato sarebbe perdita di dati, e quelle strade continuano a usare
 * `displayValue`.
 */
export const MAX_TESTO_CELLA = 1000;

/**
 * Memoria dei testi già calcolati, per identità del VALORE.
 *
 * La griglia è virtualizzata: le stesse venti righe vengono ridisegnate a ogni
 * fotogramma di scorrimento, quindi lo stesso valore viene riconvertito decine
 * di volte al secondo. Sui documenti molto larghi il costo non è il testo
 * prodotto (mille caratteri) ma l'ENUMERAZIONE delle chiavi, che è O(campi) e
 * non si può evitare: un documento con cinquantamila campi costa ~6 ms, cioè
 * ~120 ms per fotogramma. Calcolarlo una volta sola lo rende un costo di
 * apertura invece che di scorrimento.
 *
 * La chiave è l'oggetto stesso, e vale perché i valori NON vengono mai mutati
 * sul posto: dopo una scrittura `inlineEdit`/`cellselect` fanno un refetch
 * (`runQuery`), che sostituisce `state.docs` con oggetti nuovi. La WeakMap
 * lascia poi che tutto se ne vada con la pagina di risultati.
 *
 * Il risultato è CONDIVISO fra i chiamanti: va trattato come sola lettura.
 */
const memoTestoBreve = new WeakMap();

export function displayValueBreve(v, max = MAX_TESTO_CELLA) {
  const memoizzabile = v !== null && typeof v === 'object';
  if (memoizzabile) {
    const perMax = memoTestoBreve.get(v);
    const gia = perMax && perMax.get(max);
    if (gia) return gia;
  }
  const r = calcolaTestoBreve(v, max);
  if (memoizzabile) {
    let perMax = memoTestoBreve.get(v);
    if (!perMax) { perMax = new Map(); memoTestoBreve.set(v, perMax); }
    perMax.set(max, r);
  }
  return r;
}

function calcolaTestoBreve(v, max) {
  if (v !== null && typeof v === 'object' && !isGeometry(v)
      && (Array.isArray(v) || ejsonKind(v) === 'object')) {
    return { text: jsonBreve(v, max, (foglia) => displayValueBreve(foglia, max).text), cls: 'type-obj' };
  }
  // Le stringhe si tagliano PRIMA di chiamare displayValue: passargliele intere
  // significherebbe costruire comunque il valore grande (String(v) su una
  // stringa è gratis, ma le altre forme no) e, soprattutto, non protegge dal
  // caso più comune.
  if (typeof v === 'string' && v.length > max) {
    return { text: tronca(v, max), cls: '' };
  }
  const r = displayValue(v);
  // Rete finale: qualunque ramo di displayValue produca un testo oltre il
  // tetto (una stringa dentro un wrapper EJSON, un tipo aggiunto in futuro)
  // viene tagliato lo stesso. Il valore intero resta disponibile a chi serve,
  // che chiama displayValue direttamente.
  if (typeof r.text === 'string' && r.text.length > max) {
    return { ...r, text: tronca(r.text, max) };
  }
  return r;
}

export function simplify(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(simplify);
  const kind = ejsonKind(v);
  if (kind === 'oid') return v.$oid;
  if (kind === 'date') return displayValue(v).text;
  if (kind === 'number') return isPlainObject(v) ? Number(Object.values(v)[0]) : v;
  if (kind === 'decimal') return Number(v.$numberDecimal);
  if (kind === 'object') {
    // I nomi dei campi arrivano dal database: un campo chiamato __proto__ non
    // deve cambiare il prototipo dell'oggetto né sparire dalla copia.
    const out = Object.create(null);
    for (const [k, val] of Object.entries(v)) out[k] = simplify(val);
    return out;
  }
  return v;
}

export function valueType(v) {
  const kind = ejsonKind(v);
  if (kind === 'oid' || kind === 'date' || kind === 'number' || kind === 'decimal') return kind;
  if (kind === 'string' || kind === 'boolean') return kind === 'boolean' ? 'bool' : kind;
  return 'json';
}

export function editValue(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

export function parseEdited(text) {
  const t = text.trim();
  if (t === '') return '';
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

export function idOf(doc) {
  return JSON.stringify(doc._id);
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

export function cut(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ---------------------------------------------------------------------------
 * Stato di CARICAMENTO dei pulsanti.
 *
 * Tutta la comunicazione col server passa da Socket.IO con acknowledgment, cioè
 * da un'attesa che può durare da pochi millisecondi a parecchi secondi (una
 * connessione remota dietro un tunnel SSH, un backup, un cambio di passphrase
 * che riavvolge il vault). Senza un segnale, un pulsante premuto è
 * indistinguibile da un pulsante non premuto: l'utente ripreme — e sui
 * pulsanti che scrivono questo non è un fastidio estetico ma una **doppia
 * operazione** (due documenti inseriti, due backup avviati).
 *
 * Il pattern che c'era prima era scritto a mano a ogni chiamata: disabilita,
 * riscrivi `textContent`, ripristina nel `then` E nel `catch`. Tre difetti
 * ricorrenti — l'etichetta originale ripetuta come stringa letterale in tre
 * punti (che divergono alla prima modifica), il ripristino dimenticato in uno
 * dei due rami (pulsante morto per sempre) e il salto del layout quando
 * "⚡ Testa Connessione" diventa "Verifica…".
 *
 * Qui l'etichetta si SALVA invece di riscriverla, il ripristino sta in un
 * `finally` (quindi vale anche per i rifiuti e per le eccezioni sincrone) e la
 * larghezza viene bloccata per la durata dell'attesa.
 * ------------------------------------------------------------------------- */

/**
 * Mette un pulsante in attesa. Restituisce la funzione che lo rimette com'era —
 * idempotente, così chiamarla due volte non fa danni.
 */
export function iniziaCaricamento(btn, testo) {
  if (!btn || btn.dataset.caricamento === '1') return () => {};

  const htmlPrec = btn.innerHTML;
  const eraDisabilitato = btn.disabled;
  const minWidthPrec = btn.style.minWidth;

  // Larghezza bloccata: l'etichetta di attesa è quasi sempre più corta di
  // quella normale, e un pulsante che si restringe fa saltare quelli accanto
  // proprio mentre l'utente sta guardando se è successo qualcosa.
  const larghezza = btn.getBoundingClientRect().width;
  if (larghezza) btn.style.minWidth = `${Math.ceil(larghezza)}px`;
  // Il cerchietto ha `margin-right`: su un pulsante-icona senza etichetta
  // sposterebbe il disegno fuori centro.
  if (testo === '') btn.classList.add('btn-solo-spinner');

  btn.dataset.caricamento = '1';
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  // `testo: ''` significa "solo il cerchietto": è il caso dei pulsanti-icona
  // (elimina colonna, ricarica), dove una parola non ci starebbe.
  const etichetta = testo == null ? 'Attendere…' : String(testo);
  btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>${etichetta ? esc(etichetta) : ''}`;

  let finito = false;
  return () => {
    if (finito) return;
    finito = true;
    btn.innerHTML = htmlPrec;
    btn.disabled = eraDisabilitato;
    btn.removeAttribute('aria-busy');
    btn.style.minWidth = minWidthPrec;
    btn.classList.remove('btn-solo-spinner');
    delete btn.dataset.caricamento;
  };
}

/**
 * Esegue `azione()` tenendo `btn` in attesa finché la promessa non si chiude.
 * Restituisce la stessa promessa, quindi si incastra in una catena esistente
 * senza cambiarne il comportamento: `conCaricamento(btn, () => emit(…), 'Salvo…')
 * .then(…)`. Un'azione sincrona (o che lancia) rimette comunque il pulsante a
 * posto.
 */
export function conCaricamento(btn, azione, testo) {
  const fine = iniziaCaricamento(btn, testo);
  let p;
  try {
    p = azione();
  } catch (err) {
    fine();
    throw err;
  }
  if (!p || typeof p.then !== 'function') {
    fine();
    return p;
  }
  return p.finally(fine);
}

/**
 * Chiave di storage dell'applicazione (CDB-64).
 *
 * I prefissi erano rimasti misti dopo il rebranding — `gui-db:` in alcuni
 * moduli, `codedb:` in altri — e un prefisso unico non è cosmesi: è ciò che
 * permette di enumerare e ripulire in blocco quanto l'applicazione ha scritto
 * (logout, reset), cosa impossibile finché metà delle chiavi porta un altro
 * nome. `chiaveStorage` genera il nome nuovo; `migraChiave` sposta una volta
 * sola il valore scritto dalle versioni precedenti, così nessuno perde le
 * larghezze delle sidebar o le cartelle chiuse.
 */
export function chiaveStorage(nome) {
  return `codedb:${nome}`;
}

export function migraChiave(nomeNuovo, chiaveVecchia) {
  const nuova = chiaveStorage(nomeNuovo);
  try {
    if (localStorage.getItem(nuova) === null) {
      const valore = localStorage.getItem(chiaveVecchia);
      if (valore !== null) localStorage.setItem(nuova, valore);
    }
    localStorage.removeItem(chiaveVecchia);
  } catch { /* storage non disponibile: si riparte dai default */ }
  return nuova;
}

/**
 * Esegue `azione` su ogni elemento con al più `ampiezza` operazioni in volo
 * (CDB-51), restituendo gli esiti nello stesso formato di `Promise.allSettled`
 * e nello stesso ordine degli elementi.
 *
 * Serve dove un solo gesto dell'utente si traduce in molte richieste: incollare
 * una selezione da un foglio di calcolo, cancellare centinaia di righe. Mandarle
 * tutte insieme non le rende più veloci — il pool di connessioni della sessione
 * è comunque limitato — ma riempie la coda del socket e mette in attesa dietro
 * di sé ogni altra operazione, compresa quella degli altri tab. Sotto
 * `ampiezza` elementi non cambia nulla: partono tutti nella prima ondata.
 */
export async function eseguiAOndate(elementi, ampiezza, azione) {
  const esiti = new Array(elementi.length);
  let prossimo = 0;
  const lavoratore = async () => {
    for (;;) {
      const i = prossimo++;
      if (i >= elementi.length) return;
      try {
        esiti[i] = { status: 'fulfilled', value: await azione(elementi[i], i) };
      } catch (reason) {
        esiti[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(ampiezza, 1), elementi.length || 1) }, lavoratore)
  );
  return esiti;
}

export function showQueryError(msg) {
  const el = $('#query-error');
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

export function showContextMenu(x, y, items) {
  const menu = $('#context-menu');
  menu.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    if (item === '---') {
      li.className = 'separator';
    } else {
      li.textContent = item.label;
      if (item.danger) li.classList.add('danger');
      li.addEventListener('click', () => {
        hideContextMenu();
        // Un'eccezione qui risaliva al listener e moriva in console: la voce di
        // menu non faceva NULLA e non c'era alcun indizio del perché (è così che
        // si è manifestato `prompt()` mancante in Electron). Ora si vede.
        try {
          const r = item.action();
          if (r && typeof r.catch === 'function') r.catch((err) => toast(err.message || String(err), true));
        } catch (err) {
          toast(err.message || String(err), true);
        }
      });
    }
    menu.appendChild(li);
  }
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
}

export function hideContextMenu() {
  $('#context-menu').classList.add('hidden');
}

// Il menu contestuale si chiude da solo: un clic altrove, la finestra che perde
// il fuoco, Esc. Gli ascoltatori si registrano solo se c'e' un documento —
// altrimenti il solo IMPORTARE questo file fuori dal browser lanciava
// `ReferenceError: document is not defined`, cioe' rendeva non provabile ogni
// modulo che risalisse fin qui. La guardia non cambia nulla nella pagina.
if (typeof document !== 'undefined') {
  document.addEventListener('click', hideContextMenu);
  window.addEventListener('blur', hideContextMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });
}

// Riordino via drag & drop di una barra di tab. `el` è l'elemento tab, `id` la
// sua chiave stabile (il tabId o l'id del coll-tab) e `onReorder(fromId, toId)`
// riordina l'array sottostante e ri-renderizza. Si lavora per id, non per
// indice: la barra di connessione salta i tab non connessi, quindi la posizione
// visiva non coincide con l'indice nell'array.
// Classi che descrivono il bersaglio del trascinamento: `drag-over` è la tab
// sotto il cursore, `drag-slide-*` il verso in cui si sposta per aprire il
// varco (vedi "Riordino tab" in style.css). Si ripuliscono sempre TUTTE
// insieme: la tab che scivola non è quella che riceve `dragend`, e una classe
// dimenticata lascia una tab spostata di 12px per il resto della sessione.
const CLASSI_DRAG = ['drag-over', 'drag-slide-left', 'drag-slide-right'];
function pulisciSegniDrag() {
  CLASSI_DRAG.forEach((c) => {
    document.querySelectorAll('.' + c).forEach((n) => n.classList.remove(...CLASSI_DRAG));
  });
}

export function makeDraggable(el, id, onReorder, getPayload) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', typeof id === 'string' ? id : JSON.stringify(id));
    if (getPayload) {
      const payload = typeof getPayload === 'function' ? getPayload() : getPayload;
      if (payload) {
        e.dataTransfer.setData('application/codedb-tab', JSON.stringify(payload));
      }
    }
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    pulisciSegniDrag();
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (el.classList.contains('dragging')) return;
    // Da che parte far scivolare la tab per aprire il varco: se quella in mano
    // sta PRIMA di questa nella barra, la scavalcherà da sinistra e il posto va
    // aperto a destra — quindi questa arretra a sinistra. Con un verso fisso
    // metà dei trascinamenti indicherebbe il lato sbagliato.
    const inMano = document.querySelector('.dragging');
    const daSinistra = !!inMano
      && !!(inMano.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    el.classList.add('drag-over');
    el.classList.toggle('drag-slide-left', daSinistra);
    el.classList.toggle('drag-slide-right', !daSinistra);
  });
  el.addEventListener('dragleave', () => el.classList.remove(...CLASSI_DRAG));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    pulisciSegniDrag();
    const fromId = e.dataTransfer.getData('text/plain');
    if (fromId && fromId !== id) onReorder(fromId, id);
  });
}

// Sposta l'elemento con `fromId` nella posizione di quello con `toId`.
// Ritorna true se qualcosa è cambiato.
export function reorderById(list, fromId, toId, key = 'id') {
  const from = list.findIndex((x) => x[key] === fromId);
  const to = list.findIndex((x) => x[key] === toId);
  if (from < 0 || to < 0 || from === to) return false;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return true;
}



export function showError(id, msg) {
  const el = $(id);
  if (el) {
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }
}

/* ---------------------------------------------------------------------------
 * Il trasporto se n'e' andato: vive in `trasporto.js`.
 *
 * `emit`, `emitFireAndForget` e `isForActiveTab` erano gli unici pezzi PROFONDI
 * di questo file — dietro tre nomi ci stanno la riconnessione delle sole
 * connessioni salvate, l'annullamento su tab chiuso e la marcatura dell'origine
 * della risposta — e stavano sepolti fra una quarantina di funzioni scorrelate,
 * dai toast alle icone alle modali. Chi aveva bisogno del solo trasporto si
 * tirava dietro tutto il resto, ascoltatori globali sul `document` compresi.
 *
 * Si ri-esportano da qui perche' e' il posto da cui quarantasette moduli li
 * importano: spostare la conoscenza non e' un buon motivo per rompere
 * quarantasette import. E' la stessa scelta gia' fatta per `valori.js`.
 * ------------------------------------------------------------------------- */

export { emit, isForActiveTab, emitFireAndForget } from './trasporto.js';

// Contesto (tab + coll-tab) al momento in cui parte un'operazione asincrona
// lunga — import a blocchi, scritture multiple, refresh post-scrittura. `st` è
// lo stato su cui scrivere; `isStillActive()` dice se il workspace mostra ancora
// quel contesto, cioè se ha senso ridipingere o rieseguire la query (che legge
// gli input del DOM, condivisi da tutti i tab).
export function captureContext() {
  const tab = activeTab();
  const st = tab ? tab.state : state;
  const collId = st.activeCollId;
  return {
    tab,
    st,
    collId,
    tabId: tab ? tab.id : undefined,
    isStillActive: () => activeTab() === tab && st.activeCollId === collId,
  };
}

// Segna come obsoleti i dati della collection toccata da una scrittura che si
// conclude mentre l'utente guarda un altro contesto. Il flag piatto copre la
// collection corrente del tab; quello sul coll-tab conserva l'informazione
// anche quando il bersaglio non era in primo piano.
export function marcaDatiSporchi(ctx, db, coll) {
  const st = ctx && (ctx.st || (ctx.tab && ctx.tab.state));
  if (!st) return;
  const ct = Array.isArray(st.collTabs)
    ? st.collTabs.find((c) => !c.isDbTab && !c.isSplitTab && c.db === db && c.coll === coll)
    : null;
  if (ct) ct.dataDirty = true;
  if (st.db === db && st.coll === coll) st.dataDirty = true;
}


// (rimossa `invalidateSchema()`: azzerava la cache dello schema attraverso il
// Proxy `state`, quindi quella del tab ATTIVO alla risposta invece di quella del
// tab che aveva eseguito la DDL. I chiamanti ora scrivono `res._state.dbSchema`.)

export function colDone(verb) {
  return verb + 'a';
}

export function dbTypeIcon(dbType) {
  if (dbType === 'postgresql' || dbType === 'postgres') {
    return '<span class="db-type-badge db-type-pg" title="PostgreSQL"><i data-lucide="database"></i></span>';
  }
  if (dbType === 'mysql') {
    return '<span class="db-type-badge db-type-mysql" title="MySQL"><i data-lucide="database"></i></span>';
  }
  // mongodb (default)
  return '<span class="db-type-badge db-type-mongo" title="MongoDB"><i data-lucide="leaf"></i></span>';
}

export function isSqlType(dbType) {
  return dbType === 'mysql' || dbType === 'postgresql' || dbType === 'postgres';
}

export function positionFixedDropdown(btn, menu) {
  if (!btn || !menu) return;
  menu.classList.remove('hidden');
  const rect = btn.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 220;
  const menuHeight = menu.offsetHeight || 180;
  const screenWidth = window.innerWidth;
  const screenHeight = window.innerHeight;

  menu.style.position = 'fixed';
  menu.style.zIndex = '100000';

  // Posizionamento verticale: sotto il bottone, oppure sopra se in basso non c'è spazio sufficiente
  let top = rect.bottom + 6;
  if (top + menuHeight > screenHeight - 8 && rect.top - menuHeight - 6 > 0) {
    top = Math.max(8, rect.top - menuHeight - 6);
  }
  menu.style.top = `${top}px`;

  // Posizionamento orizzontale: allinea a destra col bottone, garantendo che sia sempre compreso nello schermo (8px dal bordo)
  let left = rect.right - menuWidth;
  if (left < 8) left = 8;
  if (left + menuWidth > screenWidth - 8) left = Math.max(8, screenWidth - menuWidth - 8);

  menu.style.left = `${left}px`;
  menu.style.right = 'auto';
}

// Aggancia un menu a tendina a un pulsante di barra: apre/chiude, chiude gli
// altri menu aperti, e si richiude al clic fuori, con Esc, al ridimensionamento
// e allo scroll (il menu è posizionato `fixed`, quindi non seguirebbe il
// pulsante). `aria-expanded` resta allineato allo stato reale.
export function initToolbarDropdown(btnSel, menuSel) {
  const btn = typeof btnSel === 'string' ? $(btnSel) : btnSel;
  const menu = typeof menuSel === 'string' ? $(menuSel) : menuSel;
  if (!btn || !menu) return;

  const chiudi = () => {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const eraChiuso = menu.classList.contains('hidden');
    document.querySelectorAll('.toolbar-dropdown-menu').forEach((m) => m.classList.add('hidden'));
    document.querySelectorAll('[aria-haspopup="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    if (!eraChiuso) return;
    positionFixedDropdown(btn, menu);
    btn.setAttribute('aria-expanded', 'true');
  });

  // Una voce cliccata ha fatto il suo lavoro: il menu si chiude. Fa eccezione
  // la casella di spunta, dove si vede subito l'effetto della scelta.
  menu.addEventListener('click', (e) => {
    if (e.target.closest('.checkbox-item')) return;
    if (e.target.closest('.dropdown-item')) chiudi();
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest(`#${menu.id}`) || e.target === btn || btn.contains(e.target)) return;
    chiudi();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') chiudi(); });
  window.addEventListener('resize', chiudi);
  window.addEventListener('scroll', chiudi, true);
}

// Costruttore albero JSON interattivo con rendering pigro dei figli
export function buildJsonNode(val, key = null, isRoot = false) {
  const node = document.createElement('div');
  node.className = 'json-node';

  const type = typeof val;

  if (val === null) {
    node.innerHTML = `${key ? `<span class="json-key">${esc(key)}</span>: ` : ''}<span class="json-null">null</span>`;
    return node;
  }

  if (type === 'object') {
    const isArray = Array.isArray(val);
    const keys = Object.keys(val);

    const header = document.createElement('div');
    header.className = 'json-header';
    header.style.cursor = 'pointer';

    const toggle = document.createElement('span');
    toggle.className = 'json-toggle';
    toggle.textContent = isRoot ? '▼ ' : '▶ ';

    const keySpan = key ? `<span class="json-key">${esc(key)}</span>: ` : '';
    const bracketOpen = isArray ? '[' : '{';
    const countText = `<span class="json-count">(${keys.length} ${isArray ? 'elementi' : 'chiavi'})</span>`;

    header.innerHTML = `${keySpan}${bracketOpen} ${countText}`;
    header.prepend(toggle);
    node.appendChild(header);

    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'json-children';
    if (!isRoot) childrenWrap.classList.add('hidden');
    node.appendChild(childrenWrap);

    let rendered = false;
    const renderChildren = () => {
      if (rendered) return;
      rendered = true;
      const frag = document.createDocumentFragment();
      for (const k of keys) {
        frag.appendChild(buildJsonNode(val[k], isArray ? null : k, false));
      }
      childrenWrap.appendChild(frag);
    };

    if (isRoot) renderChildren();

    header.addEventListener('click', (e) => {
      e.stopPropagation();
      renderChildren();
      const isHidden = childrenWrap.classList.toggle('hidden');
      toggle.textContent = isHidden ? '▶ ' : '▼ ';
    });

    return node;
  }

  let valClass = 'json-string';
  let formattedVal = `"${esc(String(val))}"`;

  if (type === 'number') {
    valClass = 'json-number';
    formattedVal = String(val);
  } else if (type === 'boolean') {
    valClass = 'json-boolean';
    formattedVal = String(val);
  }

  node.innerHTML = `${key ? `<span class="json-key">${esc(key)}</span>: ` : ''}<span class="${valClass}">${formattedVal}</span>`;
  return node;
}

/* ---------- Gestione Modali & Overlay Centralizzata ---------- */
const activeModals = new Set();

function handleModalEsc(e) {
  if (e.key === 'Escape' && activeModals.size > 0) {
    const lastModal = Array.from(activeModals).pop();
    closeModal(lastModal);
  }
}

export function openModal(elOrId) {
  const el = typeof elOrId === 'string'
    ? (elOrId.startsWith('#') || elOrId.startsWith('.') ? document.querySelector(elOrId) : (document.getElementById(elOrId) || document.querySelector(elOrId)))
    : elOrId;
  if (!el) return;
  el.classList.remove('hidden');
  activeModals.add(el);
  if (activeModals.size === 1) {
    document.addEventListener('keydown', handleModalEsc);
  }
  const focusable = el.querySelector('input:not([type="hidden"]), button, select, textarea');
  if (focusable) focusable.focus();
}

/**
 * Chiede un testo all'utente e risolve con la stringa inserita, oppure `null`
 * se annulla — stesso contratto di `window.prompt()`, che sostituisce.
 *
 * Serve perché **Electron non implementa `prompt()`**: nell'app desktop la
 * chiamata o lancia ("prompt() is and will not be supported") o ritorna `null`,
 * e in entrambi i casi il chiamante si interrompe PRIMA di poter mostrare un
 * toast — cliccando "Rinomina database" non succedeva assolutamente nulla, senza
 * alcun indizio del perché. `alert()` e `confirm()` invece funzionano, quindi
 * l'anomalia colpiva le sole voci che chiedono un testo.
 *
 * A differenza di `prompt()` non blocca il thread: restituisce una Promise, e
 * chi la usa deve essere `async` o concatenare `.then`.
 */
/**
 * Modale di richiesta testo. Con `spunta` mostra anche una casella opzionale e
 * risolve con `{ testo, spunta }` invece della sola stringa: serve alle
 * operazioni in cui la scelta non è "quale valore" ma "e poi cosa faccio"
 * (la rinomina di un database e il destino dell'originale). Senza `spunta` il
 * valore risolto resta la stringa di sempre, così i chiamanti esistenti non
 * cambiano.
 */
export function chiediTesto({ titolo, sottotitolo, etichetta, valore = '', password = false, ok = 'Conferma', spunta = null } = {}) {
  const overlay = $('#askinput-overlay');
  // Senza la modale in pagina, meglio annullare che restare in attesa per sempre.
  if (!overlay) return Promise.resolve(null);
  $('#askinput-title').textContent = titolo || 'Inserisci un valore';
  const sub = $('#askinput-subtitle');
  sub.textContent = sottotitolo || '';
  sub.classList.toggle('hidden', !sottotitolo);
  $('#askinput-label').textContent = etichetta || 'Valore';
  $('#askinput-ok').textContent = ok;
  const input = $('#askinput-value');
  input.type = password ? 'password' : 'text';
  input.value = valore == null ? '' : String(valore);

  const rigaSpunta = $('#askinput-check-row');
  const casella = $('#askinput-check');
  if (rigaSpunta && casella) {
    rigaSpunta.classList.toggle('hidden', !spunta);
    // Sempre riazzerata all'apertura: una casella che ricorda la scelta
    // precedente farebbe eliminare un database a chi apre la modale e conferma
    // senza rileggerla.
    casella.checked = !!(spunta && spunta.valore);
    if (spunta) $('#askinput-check-label').textContent = spunta.etichetta || '';
  }

  return new Promise((resolve) => {
    let chiuso = false;
    const finish = (res) => {
      if (chiuso) return;
      chiuso = true;
      document.removeEventListener('keydown', onEsc, true);
      $('#askinput-ok').removeEventListener('click', onOk);
      $('#askinput-cancel').removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onEnter);
      closeModal(overlay);
      resolve(res);
    };
    const onOk = () => finish(spunta ? { testo: input.value, spunta: !!(casella && casella.checked) } : input.value);
    const onCancel = () => finish(null);
    const onEnter = (e) => { if (e.key === 'Enter') { e.preventDefault(); onOk(); } };
    // Esc lo intercetta anche handleModalEsc, che chiude la modale ma non
    // saprebbe risolvere la promise: senza questo il chiamante resterebbe
    // appeso e la modale successiva troverebbe i gestori di quella prima.
    const onEsc = (e) => { if (e.key === 'Escape') finish(null); };

    $('#askinput-ok').addEventListener('click', onOk);
    $('#askinput-cancel').addEventListener('click', onCancel);
    input.addEventListener('keydown', onEnter);
    document.addEventListener('keydown', onEsc, true);
    openModal(overlay);
    input.focus();
    input.select();
  });
}

export function closeModal(elOrId) {
  const el = typeof elOrId === 'string'
    ? (elOrId.startsWith('#') || elOrId.startsWith('.') ? document.querySelector(elOrId) : (document.getElementById(elOrId) || document.querySelector(elOrId)))
    : elOrId;
  if (!el) return;
  el.classList.add('hidden');
  activeModals.delete(el);
  if (activeModals.size === 0) {
    document.removeEventListener('keydown', handleModalEsc);
  }
}

/* ---------- Gestione Notifiche Toast ---------- */
export function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.role = 'status';

  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️'
  };

  const iconSpan = document.createElement('span');
  iconSpan.textContent = icons[type] || 'ℹ️';

  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  textSpan.style.flex = '1';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn-close';
  closeBtn.textContent = '✕';
  closeBtn.ariaLabel = 'Chiudi notifica';
  closeBtn.onclick = () => toast.remove();

  toast.appendChild(iconSpan);
  toast.appendChild(textSpan);
  toast.appendChild(closeBtn);
  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.2s ease';
        setTimeout(() => toast.remove(), 200);
      }
    }, duration);
  }
}

/* ---------- Rendering Skeleton Pending States ---------- */
export function showSkeletonGrid(targetEl, rows = 6, cols = 5) {
  const el = typeof targetEl === 'string' ? document.querySelector(targetEl) : targetEl;
  if (!el) return;

  // Rimuove eventuali tabelle skeleton temporanee precedentemente create
  el.querySelectorAll('.skeleton-grid-table').forEach((t) => t.remove());

  const targetTable = el.tagName === 'TABLE' ? el : el.querySelector('table');

  if (targetTable) {
    let thead = targetTable.querySelector('thead');
    let tbody = targetTable.querySelector('tbody');
    if (!thead) {
      thead = document.createElement('thead');
      targetTable.appendChild(thead);
    }
    if (!tbody) {
      tbody = document.createElement('tbody');
      targetTable.appendChild(tbody);
    }
    thead.innerHTML = '';
    tbody.innerHTML = '';

    const trH = document.createElement('tr');
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th');
      th.style.padding = '8px 12px';
      th.innerHTML = `<div class="skeleton skeleton-text" style="width: ${50 + ((c + 1) * 17) % 40}%;"></div>`;
      trH.appendChild(th);
    }
    thead.appendChild(trH);

    for (let r = 0; r < rows; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td');
        td.style.padding = '8px 12px';
        td.innerHTML = `<div class="skeleton skeleton-text" style="width: ${35 + ((r + c) * 19) % 55}%;"></div>`;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  } else {
    const table = document.createElement('table');
    table.className = 'data-table skeleton-grid-table';
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';

    const thead = document.createElement('thead');
    const trH = document.createElement('tr');
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th');
      th.style.padding = '8px 12px';
      th.innerHTML = `<div class="skeleton skeleton-text" style="width: ${50 + ((c + 1) * 17) % 40}%;"></div>`;
      trH.appendChild(th);
    }
    thead.appendChild(trH);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let r = 0; r < rows; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td');
        td.style.padding = '8px 12px';
        td.innerHTML = `<div class="skeleton skeleton-text" style="width: ${35 + ((r + c) * 19) % 55}%;"></div>`;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    el.appendChild(table);
  }
}

export function refreshLucideIcons(targetElement = null) {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    try {
      window.lucide.createIcons({
        attrs: {
          'stroke-width': 2
        },
        nameAttr: 'data-lucide',
        ...(targetElement ? { root: targetElement } : {})
      });
    } catch (e) {
      console.warn('Lucide icon refresh warning:', e);
    }
  }
}

export function lucideIconHtml(iconName, extraClasses = '') {
  return `<i data-lucide="${iconName}" class="lucide-icon ${extraClasses}"></i>`;
}

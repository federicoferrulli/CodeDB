'use strict';

/* ---------------------------------------------------------------------------
 * Il pannello 🔗 di scelta che compare accanto a una cella collegata.
 *
 * Risponde alle due domande che la griglia da sola non sa rispondere: *chi è*
 * il cliente 42, e *quale altro* mettere al suo posto. Prima serviva aprire una
 * seconda scheda, cercare la riga, tornare indietro e ridigitare l'id a
 * memoria — con il doppio clic che accetta comunque qualunque numero.
 *
 * Due scelte di forma che sono anche scelte di significato.
 *
 * 1. SI APRE DA SOLO, entrando in modifica su una cella collegata. Dietro un
 *    pulsante era un aiuto che bisognava già sapere che esisteva: chi non
 *    conosceva il 🔗 continuava a digitare l'id a memoria, cioè restava
 *    esattamente nel problema che il pannello risolve.
 *
 * 2. NON È UNA BARRA LATERALE, ed è per questo che non tocca i bordi della
 *    finestra e non ne prende tutta l'altezza. Una sidebar è una parte stabile
 *    dell'applicazione, sempre lì; questo è un aiuto momentaneo che appartiene
 *    a UNA cella, si allinea alla sua riga e se ne va quando la modifica
 *    finisce. La forma deve dire quale delle due cose è.
 *
 * Non è nemmeno una modale, che sarebbe stata la strada breve: il senso è
 * scegliere un valore *per quella cella*, e la cella deve restare visibile e
 * scrivibile mentre si sceglie. Da qui tre conseguenze da rispettare:
 *
 *   - la chiusura con Esc e la restituzione del fuoco sono gestite qui, non da
 *     `openModal()` di utils.js (che impila e intrappola apposta);
 *   - aprendosi da solo NON prende il fuoco: chi sa già cosa scrivere continua
 *     a digitare nella cella e il pannello resta un suggerimento accanto;
 *   - il pannello CONGELA il bersaglio all'apertura (documento, campo, contesto
 *     di scrittura). L'editor inline della cella si chiude al primo `blur` — e
 *     un clic dentro il pannello è un blur: senza il congelamento, "Usa questo
 *     valore" scriverebbe su un editor che non esiste più, o peggio su quello
 *     nel frattempo aperto altrove.
 *
 * Le decisioni (quale colonna fa da etichetta, quando due chiavi sono la stessa
 * chiave, come si scrive un valore EJSON) stanno in `fk-relazioni.js`, puro e
 * provato in Node: qui c'è solo il disegno e il dialogo col server.
 * ------------------------------------------------------------------------- */

import { $, emit, esc, toast, chiaveStorage } from './utils.js';
import { openCollTab } from './colltabs.js';
import { onTabChange, switchTab, tabs } from './tabs.js';
// La ricerca nell'elenco dei candidati è la stessa del filtro rapido della
// griglia: una parola cercata in tutte le colonne (vedi filtro-rapido.js).
import { filtroRapido } from './filtro-rapido.js';
import {
  bersaglioRelazione, notaOrigine, scegliEtichetta, etichettaRiga,
  testoValore, stessoValore, VINCOLO,
} from './fk-relazioni.js';

/** Righe caricate per volta nell'elenco dei candidati. */
const LIMITE_ELENCO = 50;

/**
 * Tetto complessivo di righe caricate scorrendo, prima di fermarsi e rimandare
 * alla ricerca.
 *
 * Non è una cautela sulla memoria: è il costo dello `skip`. Su una tabella
 * grande l'OFFSET cresce con la profondità, e chi scorre per un minuto
 * chiederebbe pagine sempre più care al database per cercare a occhio ciò che
 * la casella di ricerca trova in una query. Il tetto viene DICHIARATO nella
 * nota: un elenco che smette di crescere in silenzio sembra finito.
 */
const MAX_CARICATE = 500;

/** Distanza dal fondo entro cui si chiede la pagina successiva. */
const SOGLIA_SCROLL_PX = 80;

/**
 * Attesa prima di cercare mentre si digita. La ricerca è una lettura di righe
 * vere sul database (e una voce nello Storico Azioni): una richiesta per
 * battuta significherebbe otto query per la parola "clienti".
 */
const ATTESA_RICERCA_MS = 250;

// L'APERTURA corrente: contesto d'origine, bersaglio e stato dell'elenco.
//
// Una sola per volta — il pannello è ancorato a UNA cella, e due pannelli su
// due celle diverse non avrebbero un significato utile. Ma «una per volta» non
// vuol dire «sempre la stessa griglia»: da quando il pannello si apre anche da
// un riquadro Split-View, chi lo ha aperto cambia. Per questo le funzioni qui
// sotto ricevono l'apertura come PRIMO argomento invece di andarsela a prendere
// da questa variabile: una risposta arrivata in ritardo non può più disegnare
// dentro l'apertura che le è subentrata, perché quella che tiene in mano non è
// più quella corrente.
let apertura = null;
let ricercaTimer = null;
// Un contatore PER RICHIESTA e non uno solo: il pannello lancia due letture
// indipendenti all'apertura (la riga riferita e l'elenco dei candidati), e con
// un contatore condiviso la seconda invaliderebbe la prima — la riga riferita
// non verrebbe mai disegnata, restando in "Carico…" per sempre.
let tokenRiga = 0;
let tokenElenco = 0;
// Distingue una dissolvenza ormai vecchia da una nuova apertura dello stesso
// pannello: il relativo `transitionend` può arrivare dopo il riuso del DOM.
let tokenChiusura = 0;

/**
 * Apre il pannello sulla cella in modifica.
 *
 * @param {object} opts
 * @param {object} opts.relazione  descrittore normalizzato (vedi fk-relazioni.js)
 * @param {*}      opts.valore     valore EJSON attuale della cella
 * @param {string} opts.dbCorrente database/schema della tabella di partenza
 * @param {function(*):void} opts.onScegli chiamata col valore scelto
 */
export function apriPannelloFk({
  relazione, valore, valoriRelazione = null, dbCorrente, tabId, onScegli, sorgente, contenitore = null,
}) {
  if (!relazione) return null;
  const pannello = $('#fk-pannello');
  if (!pannello) return null;

  // Da dove ripartire quando il pannello si chiude: chi ha aperto il pannello
  // dalla tastiera deve ritrovarsi dove aveva lasciato, non in cima alla pagina.
  const fuocoPrecedente = document.activeElement;
  const c = {
    relazione, valore, valoriRelazione, dbCorrente, tabId, onScegli, fuocoPrecedente,
    // Chi ha aperto: serve a `pannelloFkAperto(sorgente)`, cioè al 🔗 di una
    // griglia per sapere se il pannello aperto è il PROPRIO. Senza, il pulsante
    // di un riquadro chiuderebbe il pannello aperto da un altro.
    sorgente,
    // La griglia d'origine. Se sparisce dalla pagina — un riquadro Split-View
    // chiuso mentre il pannello è aperto — non c'è più nessuna cella da
    // riempire: il pannello si chiude invece di restare orfano.
    contenitore,
    scelto: undefined,
    // Stato dell'elenco paginato: righe accumulate fra le pagine, testo cercato
    // a cui appartengono, e se ne restano altre da chiedere.
    // `colonne`: i nomi arrivati con la prima pagina. Servono a comporre la
    // ricerca — il filtro rapido cerca in tutte le colonne che conosce, e alla
    // prima pagina non ce n'è ancora bisogno perché il testo si digita dopo.
    etichetta: null, righe: [], colonne: [], cerca: '', finito: false, caricando: false, errore: null,
  };
  apertura = c;
  tokenChiusura += 1;

  $('#fk-title').textContent = bersaglioRelazione(relazione, dbCorrente);
  $('#fk-title').title = `Colonna "${relazione.campo}" → ${bersaglioRelazione(relazione, dbCorrente)}`;
  const origine = $('#fk-origine');
  origine.textContent = notaOrigine(relazione);
  origine.classList.toggle('ipotesi', relazione.origine !== VINCOLO);

  $('#fk-cerca').value = '';
  $('#fk-usa').disabled = true;
  $('#fk-elenco-nota').classList.add('hidden');
  $('#fk-riga').innerHTML = '<p class="fk-vuoto">Carico…</p>';
  $('#fk-elenco').innerHTML = '';

  pannello.classList.remove('hidden');
  pannello.setAttribute('aria-hidden', 'false');
  // Residuo di uno swipe interrotto: senza, il drawer si riaprirebbe già
  // spostato verso il basso di quanto era stato trascinato l'ultima volta.
  pannello.classList.remove('trascinando');
  pannello.style.removeProperty('--fk-chiusura');
  applicaMisura(pannello, leggiMisura());
  riposizionaPannello(pannello);
  aggiornaTastiera();
  // Un fotogramma prima di animare: applicando `aperto` nello stesso frame in
  // cui si toglie `hidden`, il browser non ha uno stato di partenza da cui
  // animare e il pannello comparirebbe di scatto.
  requestAnimationFrame(() => pannello.classList.add('aperto'));

  document.addEventListener('keydown', onKeydown, true);

  caricaRigaRiferita(c);
  caricaElenco(c, '');
  return c;
}

/**
 * L'apertura `c` è ancora quella corrente, e la griglia da cui è partita è
 * ancora in pagina?
 *
 * Due domande e non una perché i due modi di diventare obsoleti sono diversi:
 * il pannello può essere stato riaperto altrove (e allora `c` non comanda più
 * nulla), oppure la griglia d'origine può essere stata smontata sotto — un
 * riquadro chiuso, un coll-tab cambiato — e allora non c'è più alcuna cella a
 * cui il valore scelto potrebbe servire.
 */
function apertaEViva(c) {
  if (!c || apertura !== c) return false;
  const cont = typeof c.contenitore === 'function' ? c.contenitore() : c.contenitore;
  if (cont && !document.contains(cont)) {
    chiudiPannelloFk();
    return false;
  }
  return true;
}

/* ---------------------------- Ridimensionamento ---------------------------- *
 * La misura del pannello è una preferenza dell'utente, non un dettaglio della
 * singola apertura: chi lavora su una tabella con venti colonne lo vuole largo,
 * chi ha uno schermo piccolo lo vuole stretto, e nessuno dei due ha voglia di
 * ridirlo ogni volta. Per questo si conserva in localStorage con il prefisso
 * dell'applicazione (vedi `chiaveStorage`, CDB-64).
 *
 * I minimi non sono cautele teoriche: sotto una certa larghezza l'elenco dei
 * candidati diventa una colonna di testo tagliato, cioè smette di servire a
 * scegliere — che è l'unica cosa per cui il pannello esiste.
 * ------------------------------------------------------------------------- */

const MIN_LARGHEZZA = 300;
const MIN_ALTEZZA = 260;
const CHIAVE_MISURA = chiaveStorage('fk-pannello-misura');

/**
 * Stessa soglia del resto dell'applicazione (responsive.js e le media query di
 * style.css): sotto i 900px le sidebar diventano drawer e questo pannello
 * diventa un foglio in basso. Una soglia diversa qui vorrebbe dire un pannello
 * che si comporta da desktop mentre tutto il resto è già passato a mobile.
 */
const mqMobile = window.matchMedia('(max-width: 900px)');

/** Il pannello è nella disposizione mobile (foglio in basso)? */
export function pannelloFkMobile() {
  return mqMobile.matches;
}

function leggiMisura() {
  try {
    const grezzo = JSON.parse(localStorage.getItem(CHIAVE_MISURA) || 'null');
    if (!grezzo || typeof grezzo !== 'object') return null;
    const w = Number(grezzo.w);
    const h = Number(grezzo.h);
    return {
      w: Number.isFinite(w) ? w : null,
      h: Number.isFinite(h) ? h : null,
    };
  } catch {
    return null; // storage non disponibile o valore corrotto: si riparte dai default
  }
}

function scriviMisura(misura) {
  try { localStorage.setItem(CHIAVE_MISURA, JSON.stringify(misura)); } catch { /* storage pieno o negato */ }
}

// I limiti dipendono dalla finestra, quindi si ricalcolano a ogni uso: una
// misura salvata su un monitor grande non deve rendere il pannello inusabile
// dopo aver ridotto la finestra o essere passati a uno schermo più piccolo.
function limiti() {
  return {
    wMax: Math.max(MIN_LARGHEZZA, window.innerWidth - 48),
    hMax: Math.max(MIN_ALTEZZA, window.innerHeight - 120),
  };
}

/* --------------------------- Tastiera virtuale ---------------------------- *
 * Su mobile il pannello è un foglio appoggiato in basso, e la casella di
 * ricerca sta dentro. Toccandola si apre la tastiera virtuale — che NON
 * accorcia le unità viewport: `100vh` resta l'altezza di tutto lo schermo,
 * quindi il foglio non si sposta e la casella in cui si sta scrivendo finisce
 * sotto i tasti. È il difetto classico dei bottom sheet, e si vede solo su un
 * telefono vero.
 *
 * `visualViewport` è l'unica API che dice quanto spazio la tastiera sta
 * occupando davvero; dove manca (browser vecchi) il valore resta 0 e il
 * comportamento è quello di prima, non peggiore.
 * ------------------------------------------------------------------------- */

function altezzaTastiera() {
  const vv = window.visualViewport;
  if (!vv) return 0;
  // Quanto della finestra è coperto dal basso. Sotto una soglia è il normale
  // assestarsi delle barre del browser, non una tastiera.
  const coperto = window.innerHeight - vv.height - vv.offsetTop;
  return coperto > 120 ? Math.round(coperto) : 0;
}

function aggiornaTastiera() {
  const pannello = $('#fk-pannello');
  if (!pannello) return;
  // Solo da aperto e solo su mobile: altrove la variabile non è nemmeno letta
  // dal CSS, e scriverla a ogni assestamento sarebbe lavoro a vuoto.
  if (!apertura || !pannelloFkMobile()) {
    pannello.style.removeProperty('--fk-tastiera');
    return;
  }
  pannello.style.setProperty('--fk-tastiera', `${altezzaTastiera()}px`);
}

function applicaMisura(pannello, misura) {
  // Su mobile la disposizione la decide il CSS (foglio in basso, tutta
  // larghezza): riapplicare qui la misura scelta col mouse su un desktop
  // scriverebbe stili inline che la media query deve poi sovrascrivere a forza
  // di `!important` — meglio non scriverli affatto.
  if (pannelloFkMobile()) {
    pannello.style.width = '';
    pannello.style.maxHeight = '';
    return;
  }
  const { wMax, hMax } = limiti();
  const m = misura || {};
  if (m.w) pannello.style.width = `${Math.min(Math.max(m.w, MIN_LARGHEZZA), wMax)}px`;
  // `maxHeight` e non `height`: il pannello deve restare alto quanto il suo
  // contenuto quando è poco: fissando l'altezza, una tabella con tre colonne
  // lascerebbe mezzo pannello vuoto.
  if (m.h) pannello.style.maxHeight = `${Math.min(Math.max(m.h, MIN_ALTEZZA), hMax)}px`;
}

/**
 * Trascinamento di una maniglia, con la stessa impostazione dei separatori
 * della Split-View (vedi `creaResizer` in splitview.js): Pointer Events invece
 * di mouse/touch separati, e `setPointerCapture` perché senza, un trascinamento
 * veloce che esce dalla finestra si perde e il pannello resta a metà.
 */
function collegaManiglia(maniglia, pannello, asse) {
  const orizz = asse === 'x';
  let partenza = 0;
  let inizialeW = 0;
  let inizialeH = 0;
  let attivo = false;

  const applica = (dw, dh) => {
    const { wMax, hMax } = limiti();
    const w = Math.min(Math.max(inizialeW + dw, MIN_LARGHEZZA), wMax);
    const h = Math.min(Math.max(inizialeH + dh, MIN_ALTEZZA), hMax);
    pannello.style.width = `${w}px`;
    pannello.style.maxHeight = `${h}px`;
    return { w, h };
  };

  maniglia.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    const rect = pannello.getBoundingClientRect();
    inizialeW = rect.width;
    inizialeH = rect.height;
    partenza = orizz ? e.clientX : e.clientY;
    attivo = true;
    maniglia.setPointerCapture(e.pointerId);
    maniglia.classList.add('dragging');
    // Senza, il trascinamento seleziona il testo del pannello sotto il cursore.
    document.body.classList.add('fk-resizing');
  });

  maniglia.addEventListener('pointermove', (e) => {
    if (!attivo) return;
    // La maniglia della larghezza sta a SINISTRA e il pannello è ancorato a
    // destra: trascinando verso sinistra il pannello si allarga, quindi il
    // delta va invertito.
    const delta = (orizz ? e.clientX : e.clientY) - partenza;
    applica(orizz ? -delta : 0, orizz ? 0 : delta);
  });

  const fine = (e) => {
    if (!attivo) return;
    attivo = false;
    maniglia.classList.remove('dragging');
    document.body.classList.remove('fk-resizing');
    try { maniglia.releasePointerCapture(e.pointerId); } catch { /* già rilasciato */ }
    const rect = pannello.getBoundingClientRect();
    scriviMisura({ w: Math.round(rect.width), h: Math.round(rect.height) });
  };
  maniglia.addEventListener('pointerup', fine);
  maniglia.addEventListener('pointercancel', fine);

  maniglia.addEventListener('keydown', (e) => {
    const passo = e.shiftKey ? 64 : 16;
    const avanti = orizz ? 'ArrowLeft' : 'ArrowDown';   // allarga / allunga
    const indietro = orizz ? 'ArrowRight' : 'ArrowUp';
    let d = 0;
    if (e.key === avanti) d = passo;
    else if (e.key === indietro) d = -passo;
    else return;
    e.preventDefault();
    const rect = pannello.getBoundingClientRect();
    inizialeW = rect.width;
    inizialeH = rect.height;
    // Si passa dallo stesso `applica` del trascinamento: due percorsi di calcolo
    // separati divergerebbero al primo caso limite.
    const finale = applica(orizz ? d : 0, orizz ? 0 : d);
    scriviMisura({ w: Math.round(finale.w), h: Math.round(finale.h) });
  });
}

/* ------------------------ Swipe di chiusura (mobile) ----------------------- *
 * Un drawer che sale dal basso promette, con la sua forma, di potersi spingere
 * giù: la maniglia in cima è quel segno. Se il gesto non funzionasse, la forma
 * mentirebbe — e su un telefono chiudere col ✕ in alto a destra significa
 * spostare la mano fuori dalla zona del pollice.
 * ------------------------------------------------------------------------- */

/** Oltre questa frazione dell'altezza (o con uno strappo netto) si chiude. */
const CHIUSURA_FRAZIONE = 0.3;
const CHIUSURA_VELOCITA = 0.5; // px/ms

function collegaSwipeFk(maniglia, pannello) {
  let inizio = null;

  const scrivi = (dy) => pannello.style.setProperty('--fk-chiusura', `${Math.max(0, dy)}px`);
  const azzera = () => pannello.style.removeProperty('--fk-chiusura');

  maniglia.addEventListener('pointerdown', (e) => {
    if (!pannelloFkMobile()) return;
    inizio = { y: e.clientY, t: Date.now() };
    maniglia.setPointerCapture(e.pointerId);
    pannello.classList.add('trascinando');
  });

  maniglia.addEventListener('pointermove', (e) => {
    if (!inizio) return;
    // Solo verso il basso: tirare in su un drawer già in fondo non ha un
    // significato, e lasciarlo salire lo staccherebbe dal bordo.
    scrivi(e.clientY - inizio.y);
  });

  const fine = (e) => {
    if (!inizio) return;
    const dy = e.clientY - inizio.y;
    const velocita = dy / Math.max(1, Date.now() - inizio.t);
    inizio = null;
    pannello.classList.remove('trascinando');
    try { maniglia.releasePointerCapture(e.pointerId); } catch { /* già rilasciato */ }
    // Uno strappo veloce chiude anche se corto: è il gesto di chi butta via il
    // foglio, e pretendere comunque un terzo di altezza lo farebbe rimbalzare
    // indietro come se il telefono non avesse capito.
    if (dy > pannello.offsetHeight * CHIUSURA_FRAZIONE || velocita > CHIUSURA_VELOCITA) {
      azzera();
      chiudiPannelloFk();
    } else {
      // Sotto soglia torna al suo posto, con la transizione riattivata.
      scrivi(0);
      setTimeout(azzera, 250);
    }
  };
  maniglia.addEventListener('pointerup', fine);
  maniglia.addEventListener('pointercancel', fine);
}

/**
 * Riporta il pannello nella sua posizione di riposo (in alto a destra sul
 * desktop, foglio in basso su mobile) togliendo ogni `top` calcolato.
 *
 * Il pannello si allineava alla riga della cella in modifica, così l'occhio
 * collegava le due cose. Ma su una riga in fondo alla griglia finiva in fondo
 * alla finestra, dove l'elenco dei candidati resta schiacciato contro il bordo
 * e si legge male — ed è proprio quando si modificano le ultime righe che
 * capita più spesso. Un posto fisso e prevedibile vale più dell'allineamento:
 * il legame con la cella lo dicono già il titolo del pannello e la cella
 * evidenziata in modifica.
 *
 * Resta comunque una funzione perché una misura salvata o un `top` inline di
 * una versione precedente non devono sopravvivere all'apertura.
 */
function riposizionaPannello(pannello) {
  pannello.style.top = '';
}

export function chiudiPannelloFk() {
  const pannello = $('#fk-pannello');
  // `apertura` è l'unica verità su "il pannello è aperto": la classe `hidden` arriva
  // solo a dissolvenza finita, quindi due chiusure ravvicinate — "Usa questo
  // valore" chiude, e il salvataggio che ne segue richiude — trovavano il
  // pannello ancora senza `hidden` e rifacevano tutto, riagganciando un secondo
  // `transitionend`.
  if (!pannello || !apertura) return;
  // Il fuoco torna indietro solo se se n'era andato DENTRO il pannello. Da
  // quando il pannello si apre da solo, `fuocoPrecedente` è quasi sempre la
  // cella in modifica: rimandarcelo mentre l'utente sta già scrivendo altrove
  // gli sposterebbe il cursore sotto le dita.
  const precedente = apertura.fuocoPrecedente;
  const tornaIndietro = fuocoNelPannelloFk(document.activeElement);
  apertura = null;
  const miaChiusura = ++tokenChiusura;
  // Le risposte ancora in volo non devono più disegnare nulla.
  tokenRiga += 1;
  tokenElenco += 1;
  clearTimeout(ricercaTimer);
  document.removeEventListener('keydown', onKeydown, true);

  pannello.classList.remove('aperto');
  pannello.setAttribute('aria-hidden', 'true');
  aggiornaTastiera(); // `apertura` è già null: rimuove il sollevamento da tastiera
  // `hidden` solo a dissolvenza finita: toglierlo subito farebbe sparire il
  // pannello di colpo invece di farlo uscire.
  // Se un'altra griglia lo riapre durante la dissolvenza, il `transitionend`
  // della vecchia chiusura non deve nascondere la nuova apertura.
  const finito = () => {
    if (miaChiusura === tokenChiusura && !pannello.classList.contains('aperto')) {
      pannello.classList.add('hidden');
    }
  };
  pannello.addEventListener('transitionend', finito, { once: true });
  // Ripiego se la transizione non parte (prefers-reduced-motion, pannello già
  // invisibile): senza, resterebbe un pannello trasparente che intercetta i
  // clic sulla destra della finestra.
  setTimeout(() => { if (!pannello.classList.contains('aperto')) finito(); }, 400);

  if (tornaIndietro && precedente && document.contains(precedente) && precedente.focus) {
    precedente.focus();
  }
}

/** Il pannello è aperto, eventualmente proprio dalla sorgente indicata? */
export function pannelloFkAperto(sorgente) {
  return !!(apertura && (sorgente === undefined || apertura.sorgente === sorgente));
}

/**
 * L'elemento sta dentro il pannello?
 *
 * Serve all'editor inline per distinguere i due significati di un `blur` sulla
 * cella: se il fuoco è finito NEL pannello la modifica non è finita — l'utente
 * è andato a cercare il valore da metterci — mentre in ogni altro caso vale la
 * regola di sempre e la cella si salva. Prima bastava "il pannello è aperto?",
 * ma da quando si apre da solo quella domanda è sempre vera, e la cella non si
 * sarebbe più salvata uscendo dal campo.
 */
export function fuocoNelPannelloFk(el) {
  const pannello = $('#fk-pannello');
  return !!(pannello && el && pannello.contains(el));
}

function onKeydown(e) {
  if (e.key !== 'Escape' || !apertura) return;
  // Solo se il fuoco è dentro il pannello: altrimenti Esc appartiene a chi sta
  // scrivendo nella cella (dove annulla la modifica), e chiuderebbe il pannello
  // al posto suo.
  if (!fuocoNelPannelloFk(document.activeElement)) return;
  e.stopPropagation();
  chiudiPannelloFk();
}

/* ------------------------------ Riga riferita ------------------------------ */

function caricaRigaRiferita(c) {
  const { relazione, valore, tabId } = c;
  // Cella vuota: non c'è alcuna riga da cercare, e chiedere "tutte le righe con
  // NULL" mostrerebbe un elenco spacciandolo per il riferimento.
  const coppie = relazione.coppie || [{ campo: relazione.campo, colonna: relazione.colonna }];
  const condizioni = coppie.map((p) => ({
    campo: p.colonna,
    operatore: 'uguale',
    valore: c.valoriRelazione ? c.valoriRelazione[p.campo] : valore,
  }));
  if (condizioni.some((x) => x.valore === undefined || x.valore === null)) {
    $('#fk-riga').innerHTML = '<p class="fk-vuoto">La cella è vuota: nessun riferimento.</p>';
    return;
  }
  const mio = ++tokenRiga;
  // Una condizione STRUTTURATA, non tre campi che ogni strategia reinterpreta a
  // modo suo: il pannello smette di dover sapere quale motore risponderà.
  emit('collection:find', {
    tabId,
    db: relazione.db || c.dbCorrente,
    coll: relazione.tabella,
    filtro: { condizioni },
    limit: 1,
    skip: 0,
    deferCount: true,
  }).then((res) => {
    if (!apertaEViva(c) || mio !== tokenRiga) return;
    disegnaRigaRiferita(c, res.docs && res.docs[0]);
  }).catch((err) => {
    if (!apertaEViva(c) || mio !== tokenRiga) return;
    $('#fk-riga').innerHTML = `<p class="fk-vuoto avviso">${esc(err.message)}</p>`;
  });
}

function disegnaRigaRiferita(c, riga) {
  const box = $('#fk-riga');
  if (!riga) {
    // Non è un errore da nascondere: un valore che non corrisponde a nulla è
    // proprio ciò che si vuole scoprire aprendo il pannello.
    box.innerHTML = `<p class="fk-vuoto avviso">Nessuna riga con ${esc(c.relazione.colonna)} = `
      + `${esc(testoValore(c.valore))}.</p>`;
    return;
  }
  const html = [];
  for (const [k, v] of Object.entries(riga)) {
    if (k === '_id') continue; // chiave sintetica di CodeDB sulle righe SQL
    const nullo = v === null || v === undefined;
    html.push(`<div class="fk-campo">${esc(k)}</div>`
      + `<div class="fk-valore${nullo ? ' nullo' : ''}">${esc(testoValore(v))}</div>`);
  }
  box.innerHTML = html.join('') || '<p class="fk-vuoto">Riga senza campi.</p>';
}

/* ------------------------- Elenco dei candidati --------------------------- */

/**
 * Carica una pagina di candidati. `append` distingue le due chiamate: nuova
 * ricerca (l'elenco riparte da zero) o pagina successiva raggiunta scorrendo.
 *
 * La paginazione è a `skip`/`limit` e non keyset come nella griglia: qui le
 * pagine profonde non si raggiungono scorrendo — c'è il tetto di
 * `MAX_CARICATE`, e la strada per un valore lontano è la ricerca. Un OFFSET
 * limitato a poche pagine costa quanto la scansione che il database fa comunque
 * per ordinare, mentre un cursore keyset richiederebbe di paginare sulla stessa
 * colonna dell'ordinamento — e qui l'ordinamento è la chiave primaria della
 * tabella riferita, che non è detto sia la colonna del vincolo.
 */
function caricaElenco(c, cerca, { append = false } = {}) {
  if (!apertaEViva(c)) return;
  const { relazione, tabId } = c;
  const mio = ++tokenElenco;
  const elenco = $('#fk-elenco');

  if (!append) {
    c.righe = [];
    c.etichetta = null;
    c.finito = false;
    c.errore = null; // un fallimento della ricerca precedente non riguarda questa
    c.cerca = cerca;
    elenco.innerHTML = '<p class="fk-vuoto" style="padding:8px">Carico…</p>';
    elenco.scrollTop = 0;
  }
  c.caricando = true;
  aggiornaNota(c);

  // La ricerca nell'elenco è la stessa del filtro rapido della griglia: una
  // parola cercata in tutte le colonne che si conoscono. Alla prima pagina le
  // colonne non si conoscono ancora — ma alla prima pagina non c'è nemmeno
  // niente da cercare, perché il testo lo si digita dopo.
  const condizioneRicerca = filtroRapido(cerca, c.colonne);
  emit('collection:find', {
    tabId,
    db: relazione.db || c.dbCorrente,
    coll: relazione.tabella,
    ...(condizioneRicerca ? { filtro: condizioneRicerca } : {}),
    limit: LIMITE_ELENCO,
    skip: append ? c.righe.length : 0,
    deferCount: true,
  }).then((res) => {
    if (!apertaEViva(c) || mio !== tokenElenco) return;
    c.caricando = false;
    const righe = res.docs || [];
    // Le colonne servono alla ricerca della pagina successiva: il filtro rapido
    // si compone su quelle che si conoscono.
    if (res.columns && res.columns.length) c.colonne = res.columns;
    // Pagina più corta del richiesto (o troncata dal budget di byte del
    // server): non c'è altro da chiedere. Senza questo, arrivati in fondo si
    // continuerebbe a interrogare il database a ogni scorrimento.
    if (righe.length < LIMITE_ELENCO || res.truncated) c.finito = true;
    disegnaElenco(c, righe, res.columns || [], { append });
  }).catch((err) => {
    if (!apertaEViva(c) || mio !== tokenElenco) return;
    c.caricando = false;
    // Una pagina successiva che fallisce non deve cancellare quelle già
    // mostrate: si ferma il caricamento e lo si dice nella nota.
    if (append) {
      c.finito = true;
      c.errore = err.message;
      aggiornaNota(c);
    } else {
      elenco.innerHTML = `<p class="fk-vuoto avviso" style="padding:8px">${esc(err.message)}</p>`;
    }
  });
}

// HTML di una voce. `data-i` è l'indice in `c.righe`, che è CUMULATIVO fra le
// pagine: usare l'indice dentro la pagina farebbe scegliere alla seconda pagina
// le righe della prima.
function vocePerRiga(c, riga, i) {
  const { relazione } = c;
  const scelto = c.scelto === undefined ? c.valore : c.scelto;
  const coppie = relazione.coppie || [{ campo: relazione.campo, colonna: relazione.colonna }];
  const corrente = c.scelto !== undefined
    ? stessoValore(riga[relazione.colonna], scelto)
    : coppie.every((p) => stessoValore(
      riga[p.colonna], c.valoriRelazione ? c.valoriRelazione[p.campo] : scelto,
    ));
  return `<button type="button" class="fk-voce${corrente ? ' corrente scelta' : ''}" role="option"`
    + ` aria-selected="${corrente}" data-i="${i}">`
    + '<span class="fk-spunta" aria-hidden="true"></span>'
    + `<span class="fk-testo">${esc(etichettaRiga(riga, relazione.colonna, c.etichetta))}</span>`
    + '</button>';
}

function disegnaElenco(c, righe, colonne, { append }) {
  const elenco = $('#fk-elenco');
  const { relazione } = c;

  if (!append && !righe.length) {
    elenco.innerHTML = '<p class="fk-vuoto" style="padding:8px">Nessun risultato.</p>';
    aggiornaNota(c);
    return;
  }

  // L'etichetta si decide sulla PRIMA pagina e non si ridiscute più fino alla
  // prossima ricerca. Ricalcolarla a ogni pagina la farebbe cambiare colonna a
  // metà elenco — le prime cinquanta righe con il nome, le successive con la
  // città — e sarebbe un elenco che non si può nemmeno leggere.
  if (!append) c.etichetta = scegliEtichetta(righe, relazione.colonna, colonne);

  const base = c.righe.length;
  c.righe = base ? c.righe.concat(righe) : righe.slice();
  const html = righe.map((riga, i) => vocePerRiga(c, riga, base + i)).join('');

  if (append) elenco.insertAdjacentHTML('beforeend', html);
  else elenco.innerHTML = html;
  aggiornaNota(c);
}

/**
 * Stato dell'elenco sotto le voci: quante righe si stanno guardando, se ne
 * stanno arrivando altre, e soprattutto se sono FINITE.
 *
 * Quest'ultima è la parte che conta: un elenco parziale che sembra completo
 * porta a concludere "questo valore non esiste" dopo averne guardate cinquanta.
 */
function aggiornaNota(c) {
  const nota = $('#fk-elenco-nota');
  const n = (c.righe && c.righe.length) || 0;

  if (c.errore) {
    nota.textContent = `${n} righe caricate. Il caricamento si è interrotto: ${c.errore}`;
    nota.classList.remove('hidden');
    return;
  }
  if (c.caricando) {
    nota.textContent = n ? `${n} righe · carico le successive…` : 'Carico…';
    nota.classList.remove('hidden');
    return;
  }
  if (!c.finito && n >= MAX_CARICATE) {
    nota.textContent = `${n} righe caricate, il massimo per volta: usa la ricerca per arrivare alle altre.`;
    nota.classList.remove('hidden');
    return;
  }
  if (!c.finito) {
    nota.textContent = `${n} righe · scorri per caricarne altre`;
    nota.classList.remove('hidden');
    return;
  }
  // Elenco completo: si dichiara solo se vale la pena, cioè quando le righe
  // sono tante abbastanza da far dubitare che ci sia dell'altro.
  if (n > LIMITE_ELENCO) {
    nota.textContent = `${n} righe in tutto`;
    nota.classList.remove('hidden');
  } else {
    nota.classList.add('hidden');
  }
}

// Vicino al fondo dell'elenco: si chiede la pagina dopo. La soglia è in pixel e
// non in percentuale perché l'elenco ha un'altezza fissa: caricare quando
// mancano due voci alla fine è ciò che rende lo scorrimento continuo invece di
// farlo inciampare sul fondo.
function forseCaricaAltre(c) {
  if (!apertaEViva(c) || c.caricando || c.finito) return;
  if ((c.righe || []).length >= MAX_CARICATE) return;
  const elenco = $('#fk-elenco');
  if (elenco.scrollTop + elenco.clientHeight < elenco.scrollHeight - SOGLIA_SCROLL_PX) return;
  caricaElenco(c, c.cerca || '', { append: true });
}

/* --------------------------------- Eventi --------------------------------- */

export function initFkVista() {
  const pannello = $('#fk-pannello');
  if (!pannello) return;

  // Il pannello è ancorato a una cella del tab di connessione corrente: al
  // cambio di connessione va chiuso, anche se le richieste restano comunque
  // fissate al tabId originario.
  onTabChange(chiudiPannelloFk);

  collegaManiglia($('#fk-res-x'), pannello, 'x');
  collegaManiglia($('#fk-res-y'), pannello, 'y');
  collegaSwipeFk($('#fk-grab'), pannello);

  // Tastiera virtuale e rotazione dello schermo: il foglio si risolleva sopra i
  // tasti invece di finirci sotto. `resize` copre anche il passaggio fra
  // disposizione mobile e desktop trascinando la finestra.
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', aggiornaTastiera);
    window.visualViewport.addEventListener('scroll', aggiornaTastiera);
  }
  mqMobile.addEventListener('change', () => {
    if (!apertura) return;
    // Cambiata la disposizione, gli stili inline dell'altra vanno rifatti da
    // zero: un `top` da desktop su un foglio mobile lo mette fuori posto.
    applicaMisura(pannello, leggiMisura());
    riposizionaPannello(pannello);
    aggiornaTastiera();
  });

  $('#fk-close').addEventListener('click', chiudiPannelloFk);

  $('#fk-cerca').addEventListener('input', (e) => {
    const c = apertura;
    if (!c) return;
    const testo = e.target.value.trim();
    clearTimeout(ricercaTimer);
    ricercaTimer = setTimeout(() => {
      if (apertaEViva(c)) caricaElenco(c, testo);
    }, ATTESA_RICERCA_MS);
  });

  // Scorrimento continuo dell'elenco: arrivati vicino al fondo si chiede la
  // pagina dopo. Throttle a fotogramma come nella griglia (grid.js): `scroll`
  // arriva molte volte per fotogramma e non serve rispondere a tutte.
  let scrollRaf = 0;
  $('#fk-elenco').addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      forseCaricaAltre(apertura);
    });
  });

  $('#fk-elenco').addEventListener('click', (e) => {
    const voce = e.target.closest('.fk-voce');
    const c = apertura;
    if (!voce || !c || !c.righe) return;
    const riga = c.righe[Number(voce.dataset.i)];
    if (!riga) return;
    c.scelto = riga[c.relazione.colonna];
    c.rigaScelta = riga;
    for (const altra of $('#fk-elenco').querySelectorAll('.fk-voce')) {
      const scelta = altra === voce;
      altra.classList.toggle('scelta', scelta);
      altra.setAttribute('aria-selected', String(scelta));
    }
    // Riconfermare il valore che c'è già non è un errore, ma nemmeno una
    // modifica: il pulsante resta spento perché non c'è nulla da scrivere.
    $('#fk-usa').disabled = stessoValore(c.scelto, c.valore);
    disegnaRigaRiferita(c, riga);
  });

  $('#fk-usa').addEventListener('click', () => {
    const c = apertura;
    if (!c || c.scelto === undefined) return;
    const { onScegli, scelto, rigaScelta } = c;
    chiudiPannelloFk();
    if (onScegli) onScegli(scelto, rigaScelta);
  });

  $('#fk-apri').addEventListener('click', () => {
    const c = apertura;
    if (!c) return;
    const { tabella } = c.relazione;
    const db = c.relazione.db || c.dbCorrente;
    const tabOrigine = c.tabId ? tabs.list.find((t) => t.id === c.tabId) : null;
    chiudiPannelloFk();
    if (c.tabId && !tabOrigine) {
      toast('Il tab da cui era stato aperto il pannello non è più disponibile.', true);
      return;
    }
    if (tabOrigine && tabs.activeId !== tabOrigine.id) switchTab(tabOrigine.id);
    openCollTab(db, tabella);
    toast(`Apro "${tabella}"`);
  });
}

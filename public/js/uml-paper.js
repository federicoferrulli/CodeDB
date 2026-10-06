'use strict';

/* ---------------------------------------------------------------------------
 * Il tavolo da disegno: JointJS Community messo al servizio di un diagramma di
 * schema.
 *
 * Tutto ciò che qui dentro sa di JointJS non deve uscire da questo modulo:
 * `uml.js` parla di chiavi di oggetto, collegamenti e documento, e riceve
 * indietro gesti già tradotti in quel vocabolario. È la stessa separazione che
 * `geo-vista.js` tiene con Leaflet, e serve alla stessa cosa — cambiare
 * libreria non deve voler dire riscrivere la semantica del database.
 *
 * Quattro cose che la distribuzione Community NON porta con sé, e che quindi
 * stanno qui (vedi `docs/ricerca-jointjs.md`):
 *
 * 1. LA SELEZIONE MULTIPLA. `ui.Selection` è JointJS+. Qui c'è un insieme di
 *    chiavi, il rettangolo di selezione disegnato sopra al Paper e lo
 *    spostamento di gruppo: trascinando un nodo selezionato si muovono tutti
 *    quelli selezionati, con UNA sola voce nella storia.
 *
 * 2. LA MINIMAPPA. `ui.Navigator` è JointJS+. Qui è un secondo Paper in sola
 *    lettura sullo stesso Graph, scalato per stare nel riquadro.
 *
 * 3. L'EXPORT. `format.toSVG` è JointJS+. Qui l'SVG si serializza a mano
 *    incorporando lo stile che lo riguarda — un SVG che rimanda a un foglio
 *    esterno, aperto fuori dall'app, è un disegno senza colori — e il PNG si
 *    ottiene disegnando quell'SVG su un canvas.
 *
 * 4. LO ZOOM AL PUNTATORE. Il Paper scala attorno alla propria origine:
 *    ingrandire «dove punta il mouse» vuol dire correggere la traslazione di
 *    conseguenza, altrimenti il punto sotto il cursore scappa via mentre si
 *    gira la rotella.
 * ------------------------------------------------------------------------- */

import { tokenTema } from './theme.js';

const SRC_JOINT = '/vendor/joint/joint.min.js';

export const NODO = { W: 264, HEAD: 30, ROW: 20, PAD: 8, MAX_RIGHE_COMPRESSO: 12, MAX_RIGHE_ESPANSO: 60 };
export const ZOOM_MIN = 0.15;
export const ZOOM_MAX = 3;
// Sotto questa scala i campi non si leggono comunque: il nodo diventa sagoma
// (titolo e base dati) e la pittura crolla di un ordine di grandezza. È solo
// pittura — geometria, porte e posizioni non cambiano, quindi nessun arco si
// sposta e l'export ritrova il dettaglio (vedi `esportaSvg`).
export const SOGLIA_SAGOMA = 0.5;

let joint = null;
let caricamento = null;
let FormaNodo = null;
let FormaNota = null;

/** Carica (una volta sola) JointJS vendorizzato e restituisce il globale. */
export function caricaJoint() {
  if (joint) return Promise.resolve(joint);
  if (!caricamento) {
    caricamento = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = SRC_JOINT;
      el.addEventListener('load', () => {
        if (!window.joint) { reject(new Error('JointJS caricato ma non disponibile (window.joint assente).')); return; }
        joint = window.joint;
        definisciForme();
        resolve(joint);
      });
      el.addEventListener('error', () => reject(new Error('Impossibile caricare JointJS da public/vendor/joint.')));
      document.head.appendChild(el);
    }).catch((err) => { caricamento = null; throw err; });
  }
  return caricamento;
}

// Le due forme si definiscono UNA volta. Definire una classe per nodo (che è
// la scorciatoia comoda quando il markup cambia da nodo a nodo) riempirebbe il
// namespace di JointJS di un tipo per tabella, e il tipo è ciò che finisce
// nel JSON del grafo: il documento salvato conterrebbe nomi di classe casuali.
function definisciForme() {
  if (FormaNodo) return;
  FormaNodo = joint.dia.Element.define('codedb.Nodo', {
    attrs: { corpo: { width: NODO.W }, testa: { width: NODO.W } },
  }, {
    markup: [{ tagName: 'rect', selector: 'corpo' }, { tagName: 'rect', selector: 'testa' }],
  });
  FormaNota = joint.dia.Element.define('codedb.Nota', {}, {
    markup: [{ tagName: 'rect', selector: 'corpo' }, { tagName: 'text', selector: 'testo' }],
  });
}

/** Altezza resa da un nodo con `n` campi visibili più l'eventuale riga «altri N». */
export function altezzaNodo(campiVisti, haResto) {
  return NODO.HEAD + NODO.PAD + Math.max(1, campiVisti + (haResto ? 1 : 0)) * NODO.ROW + NODO.PAD;
}

/** Quanti campi si mostrano su un nodo, secondo lo stato di compressione. */
export function campiVisibili(totale, compresso) {
  return Math.min(totale, compresso ? NODO.MAX_RIGHE_COMPRESSO : NODO.MAX_RIGHE_ESPANSO);
}

/**
 * Come si dichiara l'origine di un collegamento. Tre tratteggi, tre colori e
 * tre PAROLE: il colore da solo non dice niente a chi non lo distingue, e il
 * tratteggio da solo non dice quale delle tre origini sia.
 */
export function stileOrigine(origine, col) {
  if (origine === 'vincolo') return { dash: 'none', colore: col.accento, larghezza: 1.7, parola: 'FK' };
  if (origine === 'logica') return { dash: '2,4', colore: col.avviso, larghezza: 1.5, parola: 'logica' };
  return { dash: '6,4', colore: col.fgDim, larghezza: 1.3, parola: 'ipotesi' };
}

function palette() {
  return {
    fg: tokenTema('--fg', '#e6e9ef'),
    fgDim: tokenTema('--fg-dim', '#9aa4b2'),
    bg1: tokenTema('--bg-1', '#12161c'),
    bg2: tokenTema('--bg-2', '#1a1f27'),
    bg3: tokenTema('--bg-3', '#232a33'),
    bordo: tokenTema('--border', '#2c333d'),
    accento: tokenTema('--accent', '#6366f1'),
    accentoFg: tokenTema('--accent-fg', '#8b8df5'),
    selezione: tokenTema('--sel', '#2a3346'),
    avviso: tokenTema('--warning', '#fbbf24'),
  };
}

/* ------------------------------- Il tavolo -------------------------------- */

export class Tavola {
  /**
   * @param {HTMLElement} contenitore  elemento che ospita il Paper
   * @param {object} eventi  callback verso `uml.js` (chiavi, non celle JointJS)
   */
  constructor(contenitore, eventi = {}) {
    this.contenitore = contenitore;
    this.eventi = eventi;
    this.selezione = new Set();
    this.modifica = false;
    this.aggancio = true;
    this.perChiave = new Map();
    this.perGruppo = null;
    this._dipinta = null;
    this._dettaglio = 'pieno';
    this._timerDettaglio = null;
    this.smontato = false;
    this._scollegamenti = [];

    const col = palette();
    // Il Paper ADOTTA l'elemento che riceve, e `paper.remove()` lo TOGLIE dalla
    // pagina: montandolo su `#uml-canvas` il primo `distruggi()` (cambio di
    // database, «Rigenera», uscita dalla vista) cancellava il contenitore
    // stesso, e il montaggio successivo trovava `null` — `messaggio()` taceva
    // per la sua guardia e `monta()` moriva su `innerHTML`. Si monta su un
    // figlio, come per la minimappa e per la stessa ragione.
    const dentro = document.createElement('div');
    dentro.style.width = '100%';
    dentro.style.height = '100%';
    contenitore.appendChild(dentro);
    this.graph = new joint.dia.Graph({}, { cellNamespace: joint.shapes });
    this.paper = new joint.dia.Paper({
      el: dentro,
      model: this.graph,
      width: '100%',
      height: '100%',
      gridSize: 10,
      drawGrid: { name: 'dot', args: { color: col.bordo, thickness: 1 } },
      background: { color: col.bg1 },
      async: true,
      sorting: joint.dia.Paper.sorting.APPROX,
      cellViewNamespace: joint.shapes,
      // In «Esplora» il canvas è un documento da leggere: nulla si sposta.
      // Lo sfondo di un gruppo non si trascina mai: è una cornice, e
      // trascinarla senza i membri mentirebbe su che cosa si sta spostando.
      interactive: (vista) => this.modifica
        && !(vista.model && vista.model.get('gruppoSfondo')),
      defaultConnectionPoint: { name: 'boundary' },
      defaultRouter: { name: 'manhattan', args: { padding: 18, step: 10 } },
      defaultConnector: { name: 'rounded', args: { radius: 6 } },
      markAvailable: true,
      // Un collegamento non nasce dal nulla: si parte dalla porta di un campo.
      // Senza questa guardia un trascinamento sul corpo del nodo creerebbe
      // link con un capo in aria.
      validateConnection: (vistaDa, magneteDa, vistaA, magneteA) => (
        this.modifica && !!magneteDa && !!magneteA && vistaDa !== vistaA
      ),
    });

    this._collegaEventi();
    this._osservatore = new ResizeObserver(() => {
      if (this.smontato) return;
      this._aggiornaMinimappa();
      this.eventi.onVista?.(this.vistaCorrente());
    });
    this._osservatore.observe(contenitore);
  }

  /* ----------------------------- Ciclo di vita ---------------------------- */

  distruggi() {
    this.smontato = true;
    for (const stacca of this._scollegamenti) stacca();
    this._scollegamenti.length = 0;
    clearTimeout(this._timerDettaglio);
    this._nascondiVertici();
    this._osservatore.disconnect();
    if (this.minimappa) { this.minimappa.remove(); this.minimappa = null; }
    if (this._rettEl) { this._rettEl.remove(); this._rettEl = null; }
    this.paper.remove();
    this.graph.clear();
    this.perChiave.clear();
    this.perGruppo = null;
    this._dipinta = null;
  }

  _ascolta(bersaglio, evento, gestore, opzioni) {
    bersaglio.addEventListener(evento, gestore, opzioni);
    this._scollegamenti.push(() => bersaglio.removeEventListener(evento, gestore, opzioni));
  }

  /* -------------------------------- Eventi -------------------------------- */

  _collegaEventi() {
    const p = this.paper;

    p.on('element:pointerdown', (vista, evt) => {
      this._nascondiVertici();
      // Un clic sullo sfondo di un gruppo sceglie i suoi membri: la cornice
      // da sola non è lavoro su cui operare.
      const sfondo = vista.model.get('gruppoSfondo');
      if (sfondo && this.perGruppo) {
        const membri = (this.perGruppo.get(sfondo) || []).filter((k) => this.perChiave.has(k));
        this.selezione = new Set(membri);
        this._dipingiSelezione();
        this.eventi.onSelezione?.([...this.selezione]);
        return;
      }
      const chiave = vista.model.get('chiaveCodedb');
      if (!chiave) return;
      const aggiungi = evt.ctrlKey || evt.metaKey || evt.shiftKey;
      if (aggiungi) {
        if (this.selezione.has(chiave)) this.selezione.delete(chiave);
        else this.selezione.add(chiave);
      } else if (!this.selezione.has(chiave)) {
        this.selezione = new Set([chiave]);
      }
      this._dipingiSelezione();
      this.eventi.onSelezione?.([...this.selezione]);
      if (!this.modifica || vista.model.get('bloccato')) return;
      // I DATI dello spostamento si prendono qui, alla pressione; la VOCE di
      // storia invece nasce al primo MOVIMENTO. Aprirla qui vorrebbe dire che
      // anche un Ctrl+clic che sceglie senza spostare lascia una voce fantasma
      // — e un «Annulla» che non cambia nulla sposta di uno il conteggio che
      // ogni gesto successivo si aspetta. Fra pressione e primo movimento le
      // posizioni non possono cambiare, quindi l'istantanea è la stessa.
      this._trascinamento = {
        origine: vista.model.position(),
        altri: [...this.selezione]
          .filter((k) => k !== chiave && this.perChiave.has(k))
          .map((k) => ({ chiave: k, pos: this.perChiave.get(k).position() }))
          .filter((a) => this.perChiave.get(a.chiave).position),
        mosso: false,
      };
    });

    p.on('element:pointermove', (vista) => {
      const t = this._trascinamento;
      if (!t || !this.modifica) return;
      if (!t.mosso) {
        t.mosso = true;
        this.eventi.onInizioGesto?.('sposta');
        // La minimappa condivide il grafo e ridipingerebbe a ogni fotogramma
        // del trascinamento: congelata, si aggiorna una volta sola al rilascio.
        this._congelaMinimappa(true);
      }
      const ora = vista.model.position();
      const dx = ora.x - t.origine.x;
      const dy = ora.y - t.origine.y;
      for (const a of t.altri) {
        const cella = this.perChiave.get(a.chiave);
        if (cella && !cella.get('bloccato')) cella.position(a.pos.x + dx, a.pos.y + dy);
      }
    });

    p.on('element:pointerup', () => {
      const t = this._trascinamento;
      this._trascinamento = null;
      this._congelaMinimappa(false);
      // Un clic senza movimento non è un gesto: niente voce, niente autosave
      // e niente aggancio che sposti un nodo che si voleva solo scegliere.
      if (!t || !t.mosso) return;
      if (this.aggancio) {
        for (const chiave of this.selezione) {
          const cella = this.perChiave.get(chiave);
          if (!cella || !cella.position || cella.get('bloccato')) continue;
          const pos = cella.position();
          cella.position(Math.round(pos.x / 10) * 10, Math.round(pos.y / 10) * 10);
        }
      }
      this._aggiornaMinimappa();
      this.eventi.onFineGesto?.(this.posizioni());
    });

    p.on('element:pointerdblclick', (vista) => {
      const chiave = vista.model.get('chiaveCodedb');
      if (chiave) this.eventi.onApriDati?.(chiave);
    });

    p.on('element:contextmenu', (vista, evt) => {
      evt.preventDefault();
      const chiave = vista.model.get('chiaveCodedb');
      if (!chiave) return;
      if (!this.selezione.has(chiave)) { this.selezione = new Set([chiave]); this._dipingiSelezione(); this.eventi.onSelezione?.([...this.selezione]); }
      this.eventi.onMenu?.(evt.clientX, evt.clientY, [...this.selezione]);
    });

    p.on('link:pointerdown', (vista, evt) => {
      const id = vista.model.get('linkCodedb');
      if (!id) return;
      if (!(evt.ctrlKey || evt.metaKey || evt.shiftKey)) this.selezione.clear();
      this.selezione.add(id);
      this._dipingiSelezione();
      this.eventi.onSelezione?.([...this.selezione]);
      this._mostraVertici(id);
    });

    p.on('link:contextmenu', (vista, evt) => {
      evt.preventDefault();
      const id = vista.model.get('linkCodedb');
      if (!id) return;
      if (!this.selezione.has(id)) { this.selezione = new Set([id]); this._dipingiSelezione(); this.eventi.onSelezione?.([...this.selezione]); }
      this.eventi.onMenu?.(evt.clientX, evt.clientY, [...this.selezione]);
    });

    // I vertici trascinati cambiano il MODELLO del link, non una posizione nel
    // documento: qui si apre il gesto (una voce di storia), la scrittura vera
    // avviene al rilascio in `fineGestoSfondo`, che legge dove i vertici sono
    // arrivati. Durante la costruzione si ignorano: sono i vertici salvati o
    // quelli degli auto-riferimenti, non un gesto dell'utente.
    this.graph.on('change:vertices', (link) => {
      if (this.smontato || this._costruzione) return;
      const id = link.get('linkCodedb');
      if (!id || this._gestoVertici) return;
      this._gestoVertici = id;
      this._congelaMinimappa(true);
      this.eventi.onInizioGesto?.('instrada');
    });

    // Il gesto disegna la linea; la relazione la crea `uml.js`, che sa se le due
    // estremità possono averne una. Il link provvisorio viene quindi RIMOSSO:
    // il modello lo ridisegnerà, o non lo ridisegnerà affatto.
    p.on('link:connect', (vista) => {
      const link = vista.model;
      if (link.get('linkCodedb')) return;
      const s = link.get('source');
      const t = link.get('target');
      const daCella = this.graph.getCell(s.id);
      const aCella = this.graph.getCell(t.id);
      link.remove();
      this.eventi.onCollega?.({
        da: daCella && daCella.get('chiaveCodedb'),
        a: aCella && aCella.get('chiaveCodedb'),
        campoDa: nomeDaPorta(s.port),
        campoA: nomeDaPorta(t.port),
      });
    });

    p.on('blank:pointerdown', (evt, x, y) => {
      if (evt.button === 2) return;
      this._nascondiVertici();
      if (!this.modifica || evt.altKey || evt.button === 1) {
        this._pan = { x: evt.clientX, y: evt.clientY, t: p.translate() };
        this._congelaMinimappa(true);
      } else {
        this._rettangolo = { x, y, x2: x, y2: y };
        this._disegnaRettangolo();
      }
    });

    p.on('blank:contextmenu', (evt) => {
      evt.preventDefault();
      const punto = this.paper.clientToLocalPoint({ x: evt.clientX, y: evt.clientY });
      this.eventi.onMenuVuoto?.(evt.clientX, evt.clientY, { x: Math.round(punto.x), y: Math.round(punto.y) });
    });

    // Il movimento si ascolta sulla FINESTRA e non sul contenitore: un
    // trascinamento veloce esce dal canvas, e lì il pan si fermerebbe a metà.
    //
    // Ed è un evento di PUNTATORE, non di mouse: `mousemove` non arriva da un
    // dito né da una penna, quindi su un dispositivo tattile lo sfondo del
    // canvas si vedeva, mostrava il cursore giusto e non si trascinava —
    // esattamente il difetto già corretto sulle maniglie di ridimensionamento
    // (`maniglia.js`). Il canvas dichiara `touch-action: none`, altrimenti il
    // browser si prende il gesto per scorrere la pagina prima che arrivi qui.
    this._ascolta(window, 'pointermove', (evt) => {
      if (this._pizzico && this._pizzico.puntatori.has(evt.pointerId)) {
        this._pizzico.puntatori.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
        this._aggiornaPizzico();
        return;
      }
      if (this._pan) {
        this.paper.translate(this._pan.t.tx + (evt.clientX - this._pan.x), this._pan.t.ty + (evt.clientY - this._pan.y));
        this._aggiornaMinimappa();
        return;
      }
      if (this._rettangolo) {
        const punto = this.paper.clientToLocalPoint({ x: evt.clientX, y: evt.clientY });
        this._rettangolo.x2 = punto.x;
        this._rettangolo.y2 = punto.y;
        this._disegnaRettangolo();
      }
    });

    const fineGestoSfondo = (evt) => {
      if (this._pizzico) {
        this._pizzico.puntatori.delete(evt.pointerId);
        if (this._pizzico.puntatori.size < 2) this._pizzico = null;
      }
      this._pan = null;
      this._congelaMinimappa(false);
      // Fine di un trascinamento di vertici: si leggono dove sono arrivati e
      // si scrivono nel documento. La voce di storia è già stata aperta al
      // primo movimento, quindi il gesto si annulla in una volta sola.
      if (this._gestoVertici) {
        const id = this._gestoVertici;
        this._gestoVertici = null;
        this._congelaMinimappa(false);
        const link = this.perChiave.get(id);
        const vertici = link && link.get('vertices');
        this.eventi.onInstrada?.(id, Array.isArray(vertici) ? vertici.map((v) => ({ x: v.x, y: v.y })) : []);
      }
      if (!this._rettangolo) return;
      const r = this._rettangolo;
      this._rettangolo = null;
      this._disegnaRettangolo();
      // Il rettangolo sceglie nodi, mai archi: le maniglie di un arco scelto
      // prima non hanno più nulla a cui stare appese.
      this._nascondiVertici();
      const area = new joint.g.Rect(
        Math.min(r.x, r.x2), Math.min(r.y, r.y2),
        Math.abs(r.x2 - r.x), Math.abs(r.y2 - r.y)
      );
      this.selezione.clear();
      if (area.width > 4 || area.height > 4) {
        for (const el of this.graph.getElements()) {
          const chiave = el.get('chiaveCodedb');
          if (chiave && area.intersect(el.getBBox())) this.selezione.add(chiave);
        }
      }
      this._dipingiSelezione();
      this.eventi.onSelezione?.([...this.selezione]);
    };
    this._ascolta(window, 'pointerup', fineGestoSfondo);
    // Un puntatore annullato (il sistema si prende il gesto, il dito esce dal
    // digitalizzatore) non manda `pointerup`: senza questo il pan resterebbe
    // attaccato al puntatore per sempre.
    this._ascolta(window, 'pointercancel', fineGestoSfondo);

    // Pizzico per ingrandire: due dita non producono alcun `wheel`, quindi
    // senza questo lo zoom sul tattile non esisterebbe affatto.
    this._ascolta(this.contenitore, 'pointerdown', (evt) => {
      if (evt.pointerType === 'mouse') return;
      if (!this._pizzico) this._pizzico = { puntatori: new Map(), distanza: 0 };
      this._pizzico.puntatori.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
      if (this._pizzico.puntatori.size === 2) {
        // Con due dita non si trascina più: si ingrandisce.
        this._pan = null;
        this._rettangolo = null;
        this._disegnaRettangolo();
        this._pizzico.distanza = this._distanzaPizzico();
      }
    });

    this._ascolta(this.contenitore, 'wheel', (evt) => {
      evt.preventDefault();
      this.zoomAlPuntatore(evt.deltaY < 0 ? 1.12 : 1 / 1.12, { x: evt.clientX, y: evt.clientY });
    }, { passive: false });

    // Un rilascio dal catalogo arriva come drop HTML5: le coordinate sono dello
    // schermo e vanno riportate nel sistema del Paper, altrimenti il nodo cade
    // dove sarebbe caduto a zoom 1 e pan 0.
    this._ascolta(this.contenitore, 'dragover', (evt) => {
      evt.preventDefault();
      evt.dataTransfer.dropEffect = 'copy';
    });
    this._ascolta(this.contenitore, 'drop', (evt) => {
      evt.preventDefault();
      const chiave = evt.dataTransfer.getData('application/x-codedb-uml');
      if (!chiave) return;
      const punto = this.paper.clientToLocalPoint({ x: evt.clientX, y: evt.clientY });
      this.eventi.onRilascio?.(chiave, { x: Math.round(punto.x), y: Math.round(punto.y) });
    });
  }

  /* --------------------------------- Vista -------------------------------- */

  zoomAlPuntatore(fattore, puntoSchermo) {
    const scalaOra = this.paper.scale().sx;
    const scala = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scalaOra * fattore));
    if (Math.abs(scala - scalaOra) < 1e-6) return;
    const prima = this.paper.clientToLocalPoint(puntoSchermo);
    this.paper.scale(scala, scala);
    const dopo = this.paper.clientToLocalPoint(puntoSchermo);
    const t = this.paper.translate();
    this.paper.translate(t.tx + (dopo.x - prima.x) * scala, t.ty + (dopo.y - prima.y) * scala);
    this.eventi.onZoom?.(scala);
    this._aggiornaMinimappa();
    this._programmaDettaglio();
  }

  _distanzaPizzico() {
    const [a, b] = [...this._pizzico.puntatori.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _aggiornaPizzico() {
    if (!this._pizzico || this._pizzico.puntatori.size !== 2) return;
    const ora = this._distanzaPizzico();
    const prima = this._pizzico.distanza;
    if (!prima || !ora) { this._pizzico.distanza = ora; return; }
    const [a, b] = [...this._pizzico.puntatori.values()];
    // Si ingrandisce attorno al punto FRA le due dita, per la stessa ragione
    // per cui la rotella ingrandisce attorno al cursore: è lì che si guarda.
    this.zoomAlPuntatore(ora / prima, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    this._pizzico.distanza = ora;
  }

  zoomA(scala) {
    const riquadro = this.contenitore.getBoundingClientRect();
    if (!riquadro.width) return;
    this.zoomAlPuntatore(
      Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scala)) / this.paper.scale().sx,
      { x: riquadro.left + riquadro.width / 2, y: riquadro.top + riquadro.height / 2 }
    );
  }

  get scala() { return this.paper.scale().sx; }

  adatta(celle = null) {
    const elementi = celle && celle.length ? celle : this.graph.getElements();
    if (!elementi.length) return;
    const area = this.graph.getCellsBBox(elementi);
    const riquadro = this.contenitore.getBoundingClientRect();
    if (!area || !riquadro.width) return;
    const margine = 40;
    const scala = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(
      (riquadro.width - margine * 2) / Math.max(1, area.width),
      (riquadro.height - margine * 2) / Math.max(1, area.height)
    )));
    this.paper.scale(scala, scala);
    this.paper.translate(
      margine - area.x * scala + Math.max(0, (riquadro.width - margine * 2 - area.width * scala) / 2),
      margine - area.y * scala + Math.max(0, (riquadro.height - margine * 2 - area.height * scala) / 2)
    );
    this.eventi.onZoom?.(scala);
    this._aggiornaMinimappa();
    this._programmaDettaglio();
  }

  centraSu(chiavi) {
    const celle = chiavi.map((k) => this.perChiave.get(k)).filter((c) => c && c.position);
    if (celle.length) this.adatta(celle);
  }

  /** Posizioni correnti di tutti i nodi, per il documento. */
  posizioni() {
    const out = new Map();
    for (const [chiave, cella] of this.perChiave) {
      if (!cella.position || (cella.isLink && cella.isLink())) continue;
      // La cornice di un gruppo non ha una posizione nel documento: segue i
      // membri e viene ricalcolata.
      if (cella.get && cella.get('gruppoSfondo')) continue;
      const p = cella.position();
      out.set(chiave, { x: Math.round(p.x), y: Math.round(p.y) });
    }
    return out;
  }

  /**
   * Riquadri degli elementi indicati, per allineare e distribuire.
   *
   * La misura viene dalla CELLA disegnata (posizione + dimensione), non dal
   * documento: è ciò che l'utente vede ad allinearsi. I collegamenti non sono
   * riquadri — allinearli non avrebbe senso — e per questo sono esclusi.
   */
  riquadri(chiavi) {
    const out = [];
    for (const chiave of chiavi) {
      const cella = this.perChiave.get(chiave);
      if (!cella || !cella.position || (cella.isLink && cella.isLink())) continue;
      if (cella.get && cella.get('gruppoSfondo')) continue;
      const p = cella.position();
      const s = cella.size ? cella.size() : { width: 0, height: 0 };
      out.push({
        chiave,
        x: Math.round(p.x), y: Math.round(p.y),
        w: s.width, h: s.height,
        bloccato: !!cella.get('bloccato'),
      });
    }
    return out;
  }

  /* ------------------------------ Costruzione ------------------------------ */

  /**
   * Ricostruisce le celle dal MODELLO già deciso da `uml.js`: qui non si sceglie
   * che cosa mostrare, si disegna.
   *
   * `gruppi` è l'elenco già pronto: gli espansi portano `riquadro` dei membri
   * visibili, i compressi `x, y, conteggio` del segnaposto. I membri di un
   * gruppo compresso non arrivano proprio fra `nodi`/`entita`/`note`: un
   * collegamento che puntasse a una cella non disegnata sparirebbe, e per
   * questo `uml.js` riscrive gli archi sul segnaposto prima di chiamare qui.
   */
  monta({ nodi = [], links = [], note = [], entita = [], logiche = [], irrisolti = new Set(), gruppi = [], instradamenti = {} }) {
    const col = palette();
    this._nascondiVertici();
    this._gestoVertici = null;
    this._costruzione = true;
    this._irrisolti = irrisolti;
    this._dipinta = null;
    this._dettaglio = 'pieno';
    this.graph.resetCells([]);
    this.perChiave.clear();
    this.perGruppo = new Map(gruppi.map((g) => [g.id, g.membri || []]));
    const celle = [];

    for (const nodo of nodi) {
      const el = this._creaNodo(nodo, col, irrisolti.has(nodo.chiave));
      this.perChiave.set(nodo.chiave, el);
      celle.push(el);
    }
    for (const ent of entita) {
      const el = this._creaNodo({
        chiave: ent.id,
        titolo: ent.nome,
        sottotitolo: 'progetto',
        campi: (ent.campi || []).map((c) => ({ name: c.nome, types: c.tipo ? [c.tipo] : [] })),
        x: ent.x, y: ent.y, compresso: false, bloccato: ent.bloccato, progetto: true,
      }, col, false);
      this.perChiave.set(ent.id, el);
      celle.push(el);
    }
    for (const nota of note) {
      const el = this._creaNota(nota, col);
      this.perChiave.set(nota.id, el);
      celle.push(el);
    }
    // Le cornici degli espansi stanno SOTTO i membri — e quelle esterne sotto
    // le interne: si aggiungono in testa in ordine di profondità crescente,
    // che nello stesso `addCells` vale come «dietro».
    const sfondi = [];
    const espansi = gruppi
      .filter((g) => !g.compresso)
      .slice()
      .sort((a, b) => (a.profondita || 0) - (b.profondita || 0));
    for (const gruppo of gruppi) {
      if (gruppo.compresso) {
        const el = this._creaNodo({
          chiave: gruppo.id,
          titolo: gruppo.nome,
          sottotitolo: `${gruppo.conteggio} elementi`,
          campi: [],
          x: gruppo.x, y: gruppo.y, compresso: true, gruppo: true,
        }, col, false);
        this.perChiave.set(gruppo.id, el);
        celle.push(el);
      }
    }
    for (const gruppo of espansi) {
      const el = this._creaSfondoGruppo(gruppo, col);
      if (el) {
        this.perChiave.set(gruppo.id, el);
        sfondi.push(el);
      }
    }
    this.graph.addCells([...sfondi, ...celle]);

    const archi = [];
    for (const link of links) archi.push(this._creaLink(link, col, instradamenti));
    for (const log of logiche) {
      archi.push(this._creaLink({
        id: log.id,
        origine: 'logica',
        da: log.da,
        a: log.a,
        etichetta: [log.etichetta, log.cardinalita].filter(Boolean).join(' · '),
        coppie: log.campoDa ? [{ campo: log.campoDa, colonna: log.campoA }] : [],
        auto: log.da === log.a,
      }, col, instradamenti));
    }
    this.graph.addCells(archi.filter(Boolean));
    this._costruzione = false;
    this._dipingiSelezione();
    this._aggiornaMinimappa();
  }

  _creaNodo(nodo, col, irrisolto) {
    const campi = nodo.campi || [];
    const visti = campiVisibili(campi.length, nodo.compresso !== false);
    const resto = campi.length - visti;
    const altezza = altezzaNodo(visti, resto > 0);

    const markup = [
      { tagName: 'rect', selector: 'corpo' },
      { tagName: 'rect', selector: 'testa' },
      { tagName: 'text', selector: 'titolo' },
      { tagName: 'text', selector: 'sottotitolo' },
    ];
    const attrs = {
      corpo: {
        width: NODO.W, height: altezza, rx: 8, ry: 8,
        fill: col.bg2,
        stroke: irrisolto ? col.avviso : col.bordo,
        strokeWidth: irrisolto ? 2 : 1.2,
        strokeDasharray: irrisolto ? '5,3' : 'none',
      },
      testa: {
        width: NODO.W, height: NODO.HEAD, rx: 8, ry: 8,
        fill: (nodo.progetto || nodo.gruppo) ? col.selezione : col.bg3,
        stroke: 'none', strokeWidth: 0,
      },
      titolo: {
        x: 10, y: NODO.HEAD / 2, textAnchor: 'start', textVerticalAnchor: 'middle',
        fill: col.fg, fontSize: 13, fontWeight: 600,
        text: taglia(nodo.titolo, 24),
      },
      sottotitolo: {
        x: NODO.W - 10, y: NODO.HEAD / 2, textAnchor: 'end', textVerticalAnchor: 'middle',
        fill: col.fgDim, fontSize: 10,
        text: taglia(nodo.sottotitolo || '', 20),
      },
    };

    const porte = [];
    let y = NODO.HEAD + NODO.PAD + NODO.ROW / 2;
    campi.slice(0, visti).forEach((campo, i) => {
      markup.push({ tagName: 'text', selector: `campo${i}` }, { tagName: 'text', selector: `tipo${i}` });
      // PK, FK e nullabilità non sono affidate al colore: sono un prefisso
      // leggibile, e il prefisso resta anche in un export in scala di grigi.
      const prefisso = campo.pk ? 'PK ' : campo.fk ? 'FK ' : '   ';
      attrs[`campo${i}`] = {
        x: 10, y, textAnchor: 'start', textVerticalAnchor: 'middle',
        fill: campo.pk ? col.accentoFg : col.fg,
        fontSize: 11.5, fontFamily: 'Consolas, monospace',
        fontWeight: campo.pk ? 600 : 400,
        text: prefisso + taglia(campo.name, 18),
      };
      attrs[`tipo${i}`] = {
        x: NODO.W - 10, y, textAnchor: 'end', textVerticalAnchor: 'middle',
        fill: col.fgDim, fontSize: 10.5, fontFamily: 'Consolas, monospace',
        text: taglia((campo.types || []).filter(Boolean).join('|') + (campo.nullable === false ? ' !' : ''), 16),
      };
      // Due porte per campo, una per lato: un collegamento entra dalla parte da
      // cui arriva, e senza la porta a sinistra ogni freccia entrante girerebbe
      // intorno al nodo per attaccarsi a destra.
      porte.push({ id: `i:${campo.name}`, group: 'sinistra', args: { x: 0, y } });
      porte.push({ id: `o:${campo.name}`, group: 'destra', args: { x: NODO.W, y } });
      y += NODO.ROW;
    });
    if (resto > 0) {
      markup.push({ tagName: 'text', selector: 'resto' });
      attrs.resto = {
        x: 10, y, textAnchor: 'start', textVerticalAnchor: 'middle',
        fill: col.fgDim, fontSize: 11, fontStyle: 'italic',
        text: `… altri ${resto} campi`,
      };
    }
    // Porta di RIEPILOGO: un collegamento su un campo non visibile si ancora
    // qui, non alla riga di un altro campo — che direbbe una cosa falsa.
    porte.push({ id: 'i:*', group: 'sinistra', args: { x: 0, y: NODO.HEAD / 2 } });
    porte.push({ id: 'o:*', group: 'destra', args: { x: NODO.W, y: NODO.HEAD / 2 } });

    const portaAttrs = {
      circle: { r: 4.5, magnet: true, fill: col.accento, stroke: col.bg1, strokeWidth: 1, opacity: 0 },
    };
    const el = new FormaNodo({
      position: { x: nodo.x || 0, y: nodo.y || 0 },
      size: { width: NODO.W, height: altezza },
      markup,
      attrs,
      ports: {
        groups: {
          sinistra: { position: { name: 'absolute' }, markup: [{ tagName: 'circle', selector: 'circle' }], attrs: portaAttrs },
          destra: { position: { name: 'absolute' }, markup: [{ tagName: 'circle', selector: 'circle' }], attrs: portaAttrs },
        },
        items: porte,
      },
    });
    el.set('chiaveCodedb', nodo.chiave);
    el.set('bloccato', !!nodo.bloccato);
    // Quante righe di campo disegnare in sagoma: il dettaglio proporzionato
    // le nasconde senza ricostruire la cella.
    el.set('righeCampo', visti);
    el.set('haResto', resto > 0);
    return el;
  }

  /**
   * Aggiunge elementi appena creati senza ricostruire il grafo: ricostruire
   * cento nodi per aggiungerne uno costava secondi, e il costo cresceva col
   * diagramma invece che col gesto. I collegamenti si creano solo fra celle
   * presenti — la stessa regola di `monta`.
   */
  aggiungi({ nodi = [], note = [], entita = [], gruppi = [], links = [], logiche = [], instradamenti = {} }) {
    const col = palette();
    this._costruzione = true;
    try {
      for (const g of gruppi) this.perGruppo.set(g.id, g.membri || []);
      const nuove = [];
      for (const nodo of nodi) {
        const el = this._creaNodo(nodo, col, this._irrisolti && this._irrisolti.has(nodo.chiave));
        this.perChiave.set(nodo.chiave, el);
        nuove.push(el);
      }
      for (const ent of entita) {
        const el = this._creaNodo({
          chiave: ent.id,
          titolo: ent.nome,
          sottotitolo: 'progetto',
          campi: (ent.campi || []).map((c) => ({ name: c.nome, types: c.tipo ? [c.tipo] : [] })),
          x: ent.x, y: ent.y, compresso: false, bloccato: ent.bloccato, progetto: true,
        }, col, false);
        this.perChiave.set(ent.id, el);
        nuove.push(el);
      }
      for (const nota of note) {
        const el = this._creaNota(nota, col);
        this.perChiave.set(nota.id, el);
        nuove.push(el);
      }
      const sfondi = [];
      const espansi = gruppi
        .filter((g) => !g.compresso)
        .slice()
        .sort((a, b) => (a.profondita || 0) - (b.profondita || 0));
      for (const gruppo of gruppi) {
        if (!gruppo.compresso) continue;
        const el = this._creaNodo({
          chiave: gruppo.id,
          titolo: gruppo.nome,
          sottotitolo: `${gruppo.conteggio} elementi`,
          campi: [],
          x: gruppo.x, y: gruppo.y, compresso: true, gruppo: true,
        }, col, false);
        this.perChiave.set(gruppo.id, el);
        nuove.push(el);
      }
      for (const gruppo of espansi) {
        const el = this._creaSfondoGruppo(gruppo, col);
        if (el) {
          this.perChiave.set(gruppo.id, el);
          sfondi.push(el);
        }
      }
      this.graph.addCells([...sfondi, ...nuove]);
      const archi = [];
      for (const link of links) archi.push(this._creaLink(link, col, instradamenti));
      for (const log of logiche) {
        archi.push(this._creaLink({
          id: log.id,
          origine: 'logica',
          da: log.da,
          a: log.a,
          etichetta: [log.etichetta, log.cardinalita].filter(Boolean).join(' · '),
          coppie: log.campoDa ? [{ campo: log.campoDa, colonna: log.campoA }] : [],
          auto: log.da === log.a,
        }, col, instradamenti));
      }
      this.graph.addCells(archi.filter(Boolean));
      this._aggiornaMinimappa();
    } finally {
      this._costruzione = false;
    }
  }

  /**
   * Sostituisce la cella di UN elemento (espansione, compressione, blocco) e
   * rifà solo gli archi che lo toccano: le porte cambiano con i campi visibili
   * e un arco ancorato a una porta sparita direbbe una cosa falsa.
   */
  sostituisci({ chiave, nodo = null, nota = null, entita = null, links = [], logiche = [], instradamenti = {}, irrisolto = false }) {
    const col = palette();
    this._costruzione = true;
    try {
      const vecchia = this.perChiave.get(chiave);
      if (vecchia) {
        // Gli archi toccati si rifanno con le porte nuove: quelli rimossi qui
        // escono anche dall'indice, altrimenti resterebbero celle fantasma che
        // rispondono alle posizioni e agli strumenti.
        for (const link of this.graph.getConnectedLinks(vecchia)) {
          const id = link.get('linkCodedb');
          if (id) this.perChiave.delete(id);
          link.remove();
        }
        vecchia.remove();
        this.perChiave.delete(chiave);
      }
      let el = null;
      if (nodo) el = this._creaNodo(nodo, col, irrisolto);
      else if (entita) {
        el = this._creaNodo({
          chiave: entita.id,
          titolo: entita.nome,
          sottotitolo: 'progetto',
          campi: (entita.campi || []).map((c) => ({ name: c.nome, types: c.tipo ? [c.tipo] : [] })),
          x: entita.x, y: entita.y, compresso: false, bloccato: entita.bloccato, progetto: true,
        }, col, false);
      }
      else if (nota) el = this._creaNota(nota, col);
      if (!el) return;
      this.perChiave.set(chiave, el);
      this.graph.addCell(el);
      const tocca = (l) => l.da === chiave || l.a === chiave;
      const archi = [];
      for (const link of links.filter(tocca)) archi.push(this._creaLink(link, col, instradamenti));
      for (const log of logiche.filter(tocca)) {
        archi.push(this._creaLink({
          id: log.id,
          origine: 'logica',
          da: log.da,
          a: log.a,
          etichetta: [log.etichetta, log.cardinalita].filter(Boolean).join(' · '),
          coppie: log.campoDa ? [{ campo: log.campoDa, colonna: log.campoA }] : [],
          auto: log.da === log.a,
        }, col, instradamenti));
      }
      this.graph.addCells(archi.filter(Boolean));
      this.aggiornaSfondiGruppi();
    } finally {
      this._costruzione = false;
    }
  }

  /**
   * Riposiziona le celle esistenti senza ricostruire nulla: è la via di
   * «Annulla»/«Ripeti» quando il documento differisce solo per le posizioni.
   * Le cornici seguono i membri; i segnaposto arrivano già nella mappa perché
   * la loro posizione deriva dai membri e va ricalcolata dal chiamante.
   */
  sposta(posizioni) {
    for (const [chiave, p] of posizioni) {
      const cella = this.perChiave.get(chiave);
      if (!cella || !cella.position || cella.get('bloccato')) continue;
      if (cella.get && cella.get('gruppoSfondo')) continue;
      cella.position(Math.round(p.x), Math.round(p.y));
    }
    this.aggiornaSfondiGruppi();
  }

  /**
   * Cornice di un gruppo espanso: un rettangolo dietro i membri con il nome.
   *
   * La misura è l'unione dei riquadri dei membri più un margine, calcolata
   * sulle CELLE (posizione + dimensione) e non sul grafo: al momento in cui
   * si crea, le celle non sono ancora state aggiunte al modello.
   */
  _creaSfondoGruppo(gruppo, col) {
    const r = this._riquadroMembri(gruppo.membri || []);
    if (!r) return null;
    const el = new joint.shapes.standard.Rectangle();
    el.position(r.x, r.y);
    el.resize(r.w, r.h);
    el.attr({
      body: {
        fill: 'transparent', stroke: col.fgDim, strokeWidth: 1.2,
        strokeDasharray: '7,4', rx: 10, ry: 10,
      },
      label: {
        text: gruppo.nome, fill: col.fgDim, fontSize: 11, fontWeight: 600,
        textVerticalAnchor: 'top', textAnchor: 'start', refX: 10, refY: 5,
      },
    });
    el.set('gruppoSfondo', gruppo.id);
    return el;
  }

  _riquadroMembri(membri) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const k of membri) {
      const cella = this.perChiave.get(k);
      if (!cella || !cella.position || (cella.isLink && cella.isLink())) continue;
      const p = cella.position();
      const s = cella.size ? cella.size() : { width: 0, height: 0 };
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x + s.width); y2 = Math.max(y2, p.y + s.height);
    }
    if (x1 === Infinity) return null;
    const margine = 18;
    const etichetta = 22;
    return {
      x: Math.round(x1 - margine), y: Math.round(y1 - margine - etichetta),
      w: Math.round(x2 - x1 + margine * 2), h: Math.round(y2 - y1 + margine * 2 + etichetta),
    };
  }

  /**
   * Dopo uno spostamento le cornici seguono i membri senza ricostruire il
   * grafo: ricostruire a ogni fine-gesto butterebbe via la vista di minimappa
   * e costerebbe un layout per ciò che è un rettangolo.
   */
  aggiornaSfondiGruppi() {
    if (!this.perGruppo) return;
    for (const [id, cella] of this.perChiave) {
      if (!cella.get || !cella.get('gruppoSfondo')) continue;
      const r = this._riquadroMembri(this.perGruppo.get(id) || []);
      if (!r) continue;
      cella.position(r.x, r.y);
      if (cella.resize) cella.resize(r.w, r.h);
    }
    this._aggiornaMinimappa();
  }

  _creaNota(nota, col) {    const larghezza = nota.w || 220;
    const altezza = nota.h || 110;
    const el = new FormaNota({
      position: { x: nota.x || 0, y: nota.y || 0 },
      size: { width: larghezza, height: altezza },
      attrs: {
        corpo: {
          width: larghezza, height: altezza, rx: 6, ry: 6,
          fill: col.bg3, stroke: col.avviso, strokeWidth: 1.2, strokeDasharray: '4,3',
        },
        testo: {
          x: 10, y: 10, textAnchor: 'start', textVerticalAnchor: 'top',
          fill: col.fg, fontSize: 12,
          text: joint.util.breakText(nota.testo || 'Nota', { width: larghezza - 20 }),
        },
      },
    });
    el.set('chiaveCodedb', nota.id);
    el.set('nota', true);
    return el;
  }

  _creaLink(link, col, instradamenti = {}) {
    const da = this.perChiave.get(link.da);
    const a = this.perChiave.get(link.a);
    if (!da || !a) return null;
    const prima = (link.coppie && link.coppie[0]) || {};
    const stile = stileOrigine(link.origine, col);
    const etichetta = [
      stile.parola,
      link.composta ? `(${link.coppie.length} colonne)` : '',
      link.etichetta || '',
    ].filter(Boolean).join(' ');

    const arco = new joint.shapes.standard.Link({
      source: { id: da.id, port: portaEsistente(da, `o:${prima.campo}`) },
      target: { id: a.id, port: portaEsistente(a, `i:${prima.colonna}`) },
      attrs: {
        line: {
          stroke: stile.colore,
          strokeWidth: stile.larghezza,
          strokeDasharray: stile.dash,
          targetMarker: { type: 'path', d: 'M 9 -4 0 0 9 4 z', fill: stile.colore, stroke: 'none' },
        },
      },
      labels: [{
        position: { distance: 0.5, offset: -8 },
        attrs: {
          text: { text: taglia(etichetta, 44), fill: stile.colore, fontSize: 10.5, fontFamily: 'Consolas, monospace' },
          rect: { fill: col.bg1, stroke: 'none', rx: 3, ry: 3 },
        },
      }],
    });
    if (link.auto) {
      // Un auto-riferimento con i due capi sullo stesso nodo si ridurrebbe a un
      // punto: i vertici lo fanno uscire e rientrare.
      const box = da.getBBox();
      arco.set('router', { name: 'normal' });
      arco.set('connector', { name: 'smooth' });
      arco.set('vertices', [
        { x: box.x + box.width + 60, y: box.y - 18 },
        { x: box.x + box.width + 60, y: box.y + box.height + 18 },
      ]);
    }
    // I vertici trascinati a mano vincono su quelli calcolati: sono lavoro
    // dell'utente, salvato nel documento, non un'approssimazione da rifare.
    const manuali = instradamenti[link.id];
    if (Array.isArray(manuali) && manuali.length) {
      arco.set('vertices', manuali.map((p) => ({ x: p.x, y: p.y })));
    }
    arco.set('linkCodedb', link.id);
    arco.set('stileBase', stile);
    this.perChiave.set(link.id, arco);
    return arco;
  }

  /* ------------------------------- Selezione ------------------------------- */

  imposta(chiavi) {
    this.selezione = new Set(chiavi);
    this._dipingiSelezione();
  }

  /**
   * Maniglie sui vertici del collegamento scelto, in modifica.
   *
   * `linkTools.Vertices` è Community, non Plus: è nel bundle vendorizzato e
   * il test e2e ne verifica la presenza a runtime. Se una distribuzione non
   * lo offrisse, la guardia rende il gesto un no-op invece di un'eccezione a
   * ogni clic su un arco.
   */
  _mostraVertici(idLink) {
    const link = this.perChiave.get(idLink);
    const vista = link && link.isLink && link.isLink() ? this.paper.findViewByModel(link) : null;
    if (!this.modifica || !vista || !joint.linkTools || !joint.linkTools.Vertices || !joint.dia.ToolsView) {
      this._nascondiVertici();
      return;
    }
    // Non ricostruire gli strumenti mentre li si sta usando: toglierli a metà
    // trascinamento ucciderebbe il gesto in corso.
    if (this._verticiSu && this._verticiSu.model === link) return;
    this._nascondiVertici();
    vista.addTools(new joint.dia.ToolsView({ tools: [new joint.linkTools.Vertices()] }));
    this._verticiSu = vista;
  }

  _nascondiVertici() {
    if (this._verticiSu) {
      try { this._verticiSu.removeTools(); } catch { /* vista già smontata */ }
      this._verticiSu = null;
    }
  }

  /** Toglie le maniglie dai collegamenti (uscita dalla modifica, smontaggio). */
  nascondiStrumenti() {
    this._nascondiVertici();
  }

  /**
   * Dettaglio proporzionato allo zoom, senza ricostruire nulla: sotto la
   * soglia le righe di campo si nascondono (attributo di presentazione) e
   * sopra si rimostrano. La chiamata è debounced dal chiamante: ricalcolare a
   * ogni tacca della rotella costerebbe più del trascinamento che protegge.
   */
  applicaDettaglio() {
    const sagoma = this.paper.scale().sx < SOGLIA_SAGOMA;
    if (this._dettaglio === (sagoma ? 'sagoma' : 'pieno')) return false;
    this._dettaglio = sagoma ? 'sagoma' : 'pieno';
    const mostra = sagoma ? 'none' : '';
    for (const [, cella] of this.perChiave) {
      if (!cella.attr || (cella.isLink && cella.isLink())) continue;
      const righe = Number(cella.get('righeCampo')) || 0;
      for (let i = 0; i < righe; i++) {
        cella.attr(`campo${i}/display`, mostra);
        cella.attr(`tipo${i}/display`, mostra);
      }
      if (cella.get('haResto')) cella.attr('resto/display', mostra);
    }
    return true;
  }

  _programmaDettaglio() {
    clearTimeout(this._timerDettaglio);
    this._timerDettaglio = setTimeout(() => {
      if (!this.smontato) this.applicaDettaglio();
    }, 200);
  }

  /**
   * Congela o scongela la minimappa. Il secondo Paper condivide il grafo:
   * senza questo, ogni mossa del trascinamento ridipinge due volte.
   */
  _congelaMinimappa(congela) {
    const mini = this.minimappa;
    if (!mini) return;
    try {
      if (congela && typeof mini.freeze === 'function') mini.freeze();
      else if (!congela && typeof mini.unfreeze === 'function') mini.unfreeze();
    } catch { /* una minimappa guasta non ferma il gesto */ }
  }

  _dipingiSelezione() {
    const col = palette();
    // Ridipinge solo ciò che è CAMBIATO dall'ultima passata: su cento nodi,
    // riscrivere gli attributi di tutte le celle a ogni clic costava oltre
    // cento millisecondi. La mappa ricorda per chiave lo stato dipinto
    // (scelta, blocco); le celle nuove o ricostruite non ci sono e si
    // dipingono sempre. `monta` la azzera: celle nuove, pittura nuova.
    if (!this._dipinta) this._dipinta = new Map();
    for (const [chiave, cella] of this.perChiave) {
      // La cornice non si seleziona: al suo clic i membri sono già stati
      // scelti dal gestore dedicato.
      if (cella.get && cella.get('gruppoSfondo')) continue;
      const scelta = this.selezione.has(chiave);
      const bloccato = !!(cella.get && cella.get('bloccato'));
      const prima = this._dipinta.get(chiave);
      if (prima && prima.scelta === scelta && prima.bloccato === bloccato) continue;
      this._dipinta.set(chiave, { scelta, bloccato });
      if (cella.isLink && cella.isLink()) {
        const base = cella.get('stileBase') || { colore: col.fgDim, larghezza: 1.3 };
        cella.attr('line/stroke', scelta ? col.accentoFg : base.colore);
        cella.attr('line/strokeWidth', scelta ? base.larghezza + 1.6 : base.larghezza);
        continue;
      }
      // La scelta non è affidata al solo colore: il contorno è più che doppio,
      // e lo spessore si vede anche in scala di grigi. (Un `filter` di alone
      // sarebbe più vistoso, ma ridipingerlo a ogni selezione costa una
      // ricostruzione della cella proprio mentre la si sta trascinando.)
      cella.attr('corpo/stroke', scelta ? col.accento : (cella.get('nota') ? col.avviso : col.bordo));
      cella.attr('corpo/strokeWidth', scelta ? 2.6 : 1.2);

      // Un nodo BLOCCATO lo dichiara con il bordo tratteggiato della testata:
      // altrimenti «non si muove» sarebbe indistinguibile da «non funziona».
      cella.attr('testa/stroke', bloccato ? col.fgDim : 'none');
      cella.attr('testa/strokeWidth', bloccato ? 1.2 : 0);
      cella.attr('testa/strokeDasharray', bloccato ? '3,2' : 'none');
    }
  }

  /* -------------------------------- Minimappa ------------------------------ */

  montaMinimappa(contenitore) {
    if (this.minimappa) this.minimappa.remove();
    // Il Paper scrive `position: relative` INLINE sul proprio elemento, e un
    // inline batte la regola CSS: montandolo direttamente sul riquadro della
    // minimappa gli toglieva il `position: absolute` e la minimappa tornava in
    // flusso, mangiandosi la larghezza del canvas. Si monta quindi su un figlio.
    contenitore.innerHTML = '';
    const dentro = document.createElement('div');
    dentro.style.width = '100%';
    dentro.style.height = '100%';
    contenitore.appendChild(dentro);
    this.minimappa = new joint.dia.Paper({
      el: dentro,
      model: this.graph,
      width: '100%',
      height: '100%',
      interactive: false,
      background: { color: palette().bg1 },
      async: true,
      sorting: joint.dia.Paper.sorting.APPROX,
    });
    this._ascolta(contenitore, 'click', (evt) => {
      const punto = this.minimappa.clientToLocalPoint({ x: evt.clientX, y: evt.clientY });
      const riquadro = this.contenitore.getBoundingClientRect();
      const s = this.paper.scale().sx;
      this.paper.translate(riquadro.width / 2 - punto.x * s, riquadro.height / 2 - punto.y * s);
      this._aggiornaMinimappa();
    });
    this._aggiornaMinimappa();
  }

  _aggiornaMinimappa() {
    if (this.smontato) return;
    this.eventi.onVista?.(this.vistaCorrente());
    if (!this.minimappa) return;
    const area = this.graph.getCellsBBox(this.graph.getElements());
    const riquadro = this.minimappa.el.getBoundingClientRect();
    if (!area || !riquadro.width) return;
    const scala = Math.min(riquadro.width / (area.width + 80), riquadro.height / (area.height + 80), 1);
    this.minimappa.scale(scala, scala);
    this.minimappa.translate(40 * scala - area.x * scala, 40 * scala - area.y * scala);
  }

  /** Rettangolo della porzione visibile, in coordinate del grafo. */
  vistaCorrente() {
    const riquadro = this.contenitore.getBoundingClientRect();
    if (!riquadro.width) return { x: 0, y: 0, w: 0, h: 0 };
    const a = this.paper.clientToLocalPoint({ x: riquadro.left, y: riquadro.top });
    const b = this.paper.clientToLocalPoint({ x: riquadro.right, y: riquadro.bottom });
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }

  _disegnaRettangolo() {
    if (!this._rettangolo) {
      if (this._rettEl) { this._rettEl.remove(); this._rettEl = null; }
      return;
    }
    if (!this._rettEl) {
      this._rettEl = document.createElement('div');
      this._rettEl.className = 'uml-rubber';
      this.contenitore.appendChild(this._rettEl);
    }
    const r = this._rettangolo;
    const s = this.paper.scale().sx;
    const t = this.paper.translate();
    this._rettEl.style.left = `${Math.min(r.x, r.x2) * s + t.tx}px`;
    this._rettEl.style.top = `${Math.min(r.y, r.y2) * s + t.ty}px`;
    this._rettEl.style.width = `${Math.abs(r.x2 - r.x) * s}px`;
    this._rettEl.style.height = `${Math.abs(r.y2 - r.y) * s}px`;
  }

  /* --------------------------------- Export -------------------------------- */

  /**
   * SVG autonomo del diagramma intero (o della sola selezione). Lo stile che
   * lo riguarda viene INCORPORATO: un SVG che rimanda al foglio di stile
   * dell'app, aperto altrove, è un disegno senza colori. Nessuno script
   * sopravvive alla serializzazione.
   */
  esportaSvg({ soloSelezione = false } = {}) {
    const elementi = soloSelezione && this.selezione.size
      ? [...this.selezione].map((k) => this.perChiave.get(k)).filter((c) => c && c.position && !(c.isLink && c.isLink()))
      : this.graph.getElements();
    const area = this.graph.getCellsBBox(elementi);
    if (!area) throw new Error('Non c’è nulla da esportare: il diagramma è vuoto.');
    const margine = 24;
    const svg = this.paper.svg.cloneNode(true);
    svg.removeAttribute('style');
    svg.setAttribute('width', Math.ceil(area.width + margine * 2));
    svg.setAttribute('height', Math.ceil(area.height + margine * 2));
    svg.setAttribute('viewBox', `${area.x - margine} ${area.y - margine} ${area.width + margine * 2} ${area.height + margine * 2}`);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    // La trasformazione di vista (pan/zoom) non deve finire nell'export: il
    // viewBox qui sopra inquadra già il contenuto.
    for (const strato of svg.querySelectorAll('.joint-layers')) strato.removeAttribute('transform');
    for (const via of svg.querySelectorAll('script, foreignObject, image')) via.remove();
    // L'export è sempre a dettaglio PIENO: se il canvas era in sagoma (zoom
    // lontano), le righe nascoste tornano visibili qui. Si toglie solo
    // l'attributo che la sagoma mette sui testi dei campi.
    for (const testo of svg.querySelectorAll('text[display]')) testo.removeAttribute('display');
    const stile = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    stile.textContent = 'text { font-family: system-ui, "Segoe UI", sans-serif; } .joint-port circle { opacity: 0; } .marker-vertices, .marker-arrowheads, .link-tools, .joint-highlight-stroke { display: none; }';
    const sfondo = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    sfondo.setAttribute('x', area.x - margine);
    sfondo.setAttribute('y', area.y - margine);
    sfondo.setAttribute('width', area.width + margine * 2);
    sfondo.setAttribute('height', area.height + margine * 2);
    sfondo.setAttribute('fill', palette().bg1);
    svg.insertBefore(sfondo, svg.firstChild);
    svg.insertBefore(stile, svg.firstChild);
    return new XMLSerializer().serializeToString(svg);
  }

  async esportaPng(opzioni = {}) {
    const testo = this.esportaSvg(opzioni);
    const blob = new Blob([testo], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('Il diagramma non è stato convertito in immagine.'));
        i.src = url;
      });
      const scala = opzioni.scala || 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scala));
      canvas.height = Math.max(1, Math.round(img.height * scala));
      const ctx = canvas.getContext('2d');
      ctx.scale(scala, scala);
      ctx.drawImage(img, 0, 0);
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function nomeDaPorta(porta) {
  if (!porta) return null;
  const nome = String(porta).replace(/^[io]:/, '');
  return nome === '*' ? null : nome;
}

function portaEsistente(cella, id) {
  if (id && !id.endsWith(':null') && !id.endsWith(':undefined') && cella.getPort && cella.getPort(id)) return id;
  return id && id.startsWith('o:') ? 'o:*' : 'i:*';
}

function taglia(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

'use strict';

/* ---------------------------------------------------------------------------
 * La vista UML: il coordinatore.
 *
 * Tre stati distinti, e non vanno confusi (è la ragione per cui il vecchio
 * renderer non poteva crescere: schema e disegno erano la stessa cosa, e
 * spostare un nodo non era nemmeno esprimibile):
 *
 *  - lo SCHEMA OSSERVATO, che arriva dal server e non si modifica trascinando;
 *  - il DOCUMENTO DEL DIAGRAMMA (`uml-modello.js`), cioè posizioni, nodi
 *    presenti, note, entità di progetto e relazioni logiche — l'unica cosa che
 *    si salva, e che nessuna interazione del canvas fa mai arrivare al DBMS;
 *  - lo STATO DELLA VISTA (zoom, selezione, pannelli, richieste in volo), che
 *    non si salva perché non è lavoro: è dove si stava guardando.
 *
 * Qui non c'è JointJS (sta in `uml-paper.js`) e non ci sono le regole del
 * modello (stanno in `uml-modello.js`): qui c'è il collegamento fra i tre stati
 * e l'interfaccia.
 *
 * DUE PROPRIETÀ CHE COSTANO POCO E CHE SENZA UNA REGOLA SI PERDONO:
 *
 * 1. NESSUNA RISPOSTA TARDIVA TOCCA UN ALTRO DIAGRAMMA. Il canvas è UNO e i tab
 *    sono molti: una lettura partita sul database A che torna mentre si guarda
 *    il database B disegnerebbe le tabelle sbagliate senza alcun errore. Ogni
 *    lettura congela (tab, connessione, database) e la risposta produce effetti
 *    solo se quel contesto è ancora quello mostrato — la stessa regola di
 *    `coerenza-richieste.js` che protegge la griglia.
 *
 * 2. IL DIAGRAMMA NON SCRIVE MAI NEL DATABASE. Aggiungere una relazione logica,
 *    rimuovere un nodo o cancellare una nota tocca il documento e basta. Le
 *    operazioni reali (rinomina, DDL) restano dove sono, con il loro bersaglio
 *    esplicito; il diagramma si riconcilia dopo l'esito.
 * ------------------------------------------------------------------------- */

import { state } from './state.js';
import { activeTab } from './tabs.js';
import {
  $, emit, esc, showToast, showContextMenu, refreshLucideIcons, chiediTesto, displayValueBreve,
  initToolbarDropdown, buildJsonNode,
} from './utils.js';
import { congelaContesto, contestoCorrente } from './coerenza-richieste.js';
import {
  chiaveOggetto, leggiChiave, unisciSchema, collegamenti, disposizione, documentoVuoto,
  Cronologia, clona, validaDocumento, riconcilia, nuovoId, VINCOLO,
  allinea, distribuisci, ALLINEAMENTI, collegamentiCompressi,
  nascondiglioGruppi, foglieGruppo, posizioneSegnaposto, profonditaGruppi,
  stessaStruttura,
} from './uml-modello.js';
import { caricaJoint, Tavola, altezzaNodo, campiVisibili } from './uml-paper.js';
import * as archivio from './uml-store.js';
import { setView } from './main.js';
import { selectCollection } from './grid.js';
import { addOrSplitPane } from './splitview.js';
import { getCurrentUser } from './auth.js';
import { socket } from './socket.js';

// Il tetto più alto che `limitaSchema` concede: l'UML è la vista in cui
// «mancano delle tabelle» è un difetto, non un'ottimizzazione. Ciò che resta
// fuori si continua a chiedere con il cursore.
const BUDGET = { collectionLimit: 200, fieldLimit: 200, relationLimit: 1000 };
const RIGHE_PAGINA = 25;
const ATTESA_AUTOSAVE = 900;

/** Stato della vista. Il canvas è uno solo, quindi questo oggetto è uno solo. */
const V = {
  tavola: null,
  contesto: null,      // { tabId, connId, db } del diagramma montato
  schema: null,
  doc: documentoVuoto(),
  cronologia: new Cronologia(),
  idDiagramma: null,
  revisione: 0,
  ambito: null,
  stato: 'salvato',    // salvato | modificato | errore
  selezione: [],
  modifica: false,
  dettagli: new Map(), // chiave -> { fields, indexes, relazioni } completi
  dati: null,          // { chiave, db, coll, docs, columns, skip, rigaScelta }
  filtroCatalogo: '',
  timerSalvataggio: null,
  generazione: 0,
};

/* ============================ Identità e contesto ========================= */

function connId() {
  const t = activeTab();
  return state.connId || (t ? `temp:${t.id}` : 'temp');
}

/**
 * Chi sta guardando. Senza RBAC la risposta è «l'installazione»: i diagrammi
 * di un'installazione a utente singolo non devono sparire solo perché il
 * server non dichiara alcun soggetto.
 */
function utenteCorrente() {
  const u = getCurrentUser();
  return (u && (u.email || u.id)) || 'locale';
}

function contestoOra() {
  const t = activeTab();
  return { tabId: t ? t.id : null, connId: connId(), db: state.db || null };
}

function ancoraQui(congelato) {
  return contestoCorrente(contestoOra(), congelato);
}

function chiaveDi(nome, db = state.db) {
  return chiaveOggetto({ conn: connId(), db, nome });
}

/* ================================ Ingresso =============================== */

export function loadUml(force) {
  if (!state.db) {
    messaggio('Apri un database per costruire un diagramma.');
    return;
  }
  const ctx = contestoOra();
  const cambiato = !V.contesto || V.contesto.tabId !== ctx.tabId
    || V.contesto.connId !== ctx.connId || V.contesto.db !== ctx.db;
  // Tornare sulla vista non ricostruisce nulla: posizione, zoom, selezione e
  // modifiche non salvate restano esattamente dove erano.
  if (!cambiato && !force && V.tavola && V.schema) return;
  avvia(ctx, force);
}

async function avvia(ctx, force) {
  const congelato = congelaContesto(ctx);
  const mia = ++V.generazione;
  messaggio('Caricamento di JointJS e dello schema…');
  try {
    await caricaJoint();
  } catch (err) {
    messaggio(`<span class="error">${esc(err.message)}</span>`);
    return;
  }
  if (mia !== V.generazione || !ancoraQui(congelato)) return;

  smonta();
  V.contesto = ctx;
  V.dettagli.clear();
  V.dati = null;
  V.selezione = [];
  V.cronologia.azzera();
  V.ambito = archivio.ambitoDi({ utente: utenteCorrente(), conn: ctx.connId, db: ctx.db });

  const schema = await leggiSchema(congelato, force);
  if (!schema || mia !== V.generazione || !ancoraQui(congelato)) return;
  V.schema = schema;

  await ripristinaDiagramma(congelato);
  if (mia !== V.generazione || !ancoraQui(congelato)) return;

  monta();
}

async function leggiSchema(congelato, force) {
  const cache = state.dbSchema;
  if (!force && cache && state.dbSchemaFor === state.db) return cache;
  try {
    const res = await emit('db:schema', {
      tabId: congelato.tabId, db: congelato.db, progressive: true, ...BUDGET,
      // «Rigenera» deve rileggere davvero: senza, lo snapshot di sessione
      // continuerebbe a servire il catalogo di prima fino alla scadenza.
      refresh: force === true,
    });
    if (!ancoraQui(congelato)) return null;
    if (res._state) { res._state.dbSchema = res; res._state.dbSchemaFor = congelato.db; }
    return res;
  } catch (err) {
    if (ancoraQui(congelato)) messaggio(`<span class="error">${esc(err.message)}</span>`);
    return null;
  }
}

/* ============================== Documento ================================= */

async function ripristinaDiagramma(congelato) {
  let salvati = [];
  let erroreArchivio = null;
  try {
    salvati = await archivio.elenca(V.ambito);
  } catch (err) {
    // Senza storage il diagramma vive in memoria: l'errore si dichiara UNA
    // volta sola, alla fine — le due uscite qui sotto scrivevano «salvato»
    // sopra l'errore, e lo stato mentiva proprio quando serviva dirlo.
    erroreArchivio = err;
  }
  if (!ancoraQui(congelato)) return;
  const statoFinale = () => {
    if (erroreArchivio) {
      mostraStato('errore', `${erroreArchivio.message} — il diagramma resta in memoria e si può esportare.`);
    } else {
      mostraStato('salvato');
    }
  };
  if (salvati.length) {
    const record = await archivio.leggi(V.ambito, salvati[0].id).catch(() => null);
    if (record && ancoraQui(congelato)) {
      const { doc, avvisi } = validaDocumento(record.doc);
      V.doc = doc;
      V.idDiagramma = record.id;
      V.revisione = record.revisione || 0;
      if (avvisi.length) showToast(avvisi[0], 'warning');
      statoFinale();
      aggiornaElencoDiagrammi(salvati);
      return;
    }
  }
  V.doc = documentoVuoto(congelato.db ? `Schema ${congelato.db}` : 'Diagramma');
  V.idDiagramma = nuovoId('dia');
  V.revisione = 0;
  // Un diagramma nuovo non nasce vuoto: nasce con lo schema disposto, che è
  // ciò che l'utente si aspetta aprendo «UML» su un database.
  const chiavi = (V.schema.collections || []).map((c) => chiaveDi(c.name));
  for (const k of chiavi) V.doc.nodi[k] = { x: 0, y: 0, bloccato: false, compresso: true };
  disponi({ registra: false });
  statoFinale();
  aggiornaElencoDiagrammi(salvati);
}

/** Registra un'istantanea PRIMA di modificare: un gesto, una voce. */
function segnaGesto() {
  V.cronologia.segna(V.doc);
  aggiornaComandi();
}

function modificato() {
  mostraStato('modificato');
  clearTimeout(V.timerSalvataggio);
  V.timerSalvataggio = setTimeout(salvaOra, ATTESA_AUTOSAVE);
  aggiornaComandi();
}

async function salvaOra() {
  if (!V.ambito || !V.idDiagramma) return;
  const congelato = congelaContesto(V.contesto);
  try {
    const esito = await archivio.salva(V.ambito, V.idDiagramma, {
      nome: V.doc.nome, doc: V.doc, baseRevisione: V.revisione,
    });
    if (!ancoraQui(congelato)) return;
    if (esito.conflitto) {
      // Un'altra finestra ha salvato dopo di noi: sovrascrivere in silenzio
      // sarebbe la perdita di lavoro che la revisione esiste per impedire.
      mostraStato('errore', 'Un’altra finestra ha salvato questo diagramma. Usa «Esporta» e riapri, oppure rinomina questo diagramma.');
      return;
    }
    V.revisione = esito.revisione;
    mostraStato('salvato');
  } catch (err) {
    mostraStato('errore', err.message);
  }
}

/* ============================= Costruzione ================================ */

function collezione(nome) {
  return (V.schema.collections || []).find((c) => c.name === nome) || null;
}

/** Campi da mostrare su un nodo: i completi se già letti, altrimenti quelli dello schema. */
function campiDi(chiave) {
  const parti = leggiChiave(chiave);
  const dettaglio = V.dettagli.get(chiave);
  if (dettaglio && dettaglio.fields) return dettaglio.fields;
  const c = parti ? collezione(parti.nome) : null;
  return (c && c.fields) || [];
}

function linksCorrenti() {
  return collegamenti(V.schema, { conn: connId(), db: V.contesto.db })
    .filter((l) => V.doc.nodi[l.da] && V.doc.nodi[l.a]);
}

/**
 * Membri nascosti perché dentro un gruppo COMPRESSO, come mappa elemento →
 * segnaposto esterno. Un arco che punta a un nodo non disegnato sparirebbe:
 * chi disegna riceve gli archi riscritti sul segnaposto, chi ragiona
 * (ispettore, righe collegate) continua a usare `linksCorrenti`, cioè la
 * topologia vera. Con i gruppi annidati il segnaposto è il compresso più
 * esterno, l'unico disegnato.
 */
function dentroGruppoCompresso() {
  return nascondiglioGruppi(V.doc.gruppi);
}

function linksDisegnati() {
  const dentro = dentroGruppoCompresso();
  if (!dentro.size) return { reali: linksCorrenti(), logiche: V.doc.logiche };
  return {
    reali: collegamentiCompressi(linksCorrenti(), dentro),
    logiche: collegamentiCompressi(V.doc.logiche, dentro),
  };
}

/**
 * Tutto ciò che serve per disegnare, calcolato una volta sola: topologia
 * vera, riscrittura sui segnaposto, marcatori FK e irrisolti. Lo usano il
 * disegno intero e le vie incrementali (aggiunta e sostituzione di un nodo),
 * che devono vedere gli stessi archi del ridisegno completo.
 */
function contestoDisegno() {
  const chiaviSchema = new Set((V.schema.collections || []).map((c) => chiaveDi(c.name)));
  const { irrisolti } = riconcilia(V.doc, chiaviSchema);
  const dentro = dentroGruppoCompresso();
  const { reali, logiche } = linksDisegnati();
  const campiFk = new Map();
  for (const l of reali) {
    if (!campiFk.has(l.da)) campiFk.set(l.da, new Set());
    for (const p of l.coppie) campiFk.get(l.da).add(p.campo);
  }
  return {
    dentro, reali, logiche, campiFk,
    irrisolti: new Set(irrisolti),
    instradamenti: V.doc.instradamenti || {},
  };
}

/** Il modello di UN nodo per il tavolo, con le stesse regole del disegno intero. */
function modelloNodo(chiave, nodo, campiFk, insiemeIrrisolti) {
  const parti = leggiChiave(chiave) || { nome: '?', db: '' };
  const fk = (campiFk && campiFk.get(chiave)) || new Set();
  const c = collezione(parti.nome);
  return {
    chiave,
    titolo: parti.nome,
    sottotitolo: insiemeIrrisolti && insiemeIrrisolti.has(chiave) ? 'non risolto' : (parti.db || ''),
    campi: campiDi(chiave).map((f) => ({ ...f, fk: fk.has(f.name) })),
    x: nodo.x, y: nodo.y, compresso: nodo.compresso !== false, bloccato: !!nodo.bloccato,
    righe: c ? c.rowsApprox : null,
  };
}

function modelloDisegno() {
  const { dentro, reali, logiche, campiFk, irrisolti: insiemeIrrisolti, instradamenti } = contestoDisegno();
  const nodi = Object.entries(V.doc.nodi)
    .filter(([chiave]) => !dentro.has(chiave))
    .map(([chiave, nodo]) => modelloNodo(chiave, nodo, campiFk, insiemeIrrisolti));
  const entita = V.doc.entita.filter((e) => !dentro.has(e.id));
  const note = V.doc.note.filter((n) => !dentro.has(n.id));
  // Un gruppo coperto da un compresso esterno non si disegna affatto: né
  // cornice né segnaposto, è tutto dietro il segnaposto esterno. Gli altri
  // portano la profondità, così le cornici esterne finiscono sotto.
  const profondita = profonditaGruppi(V.doc.gruppi);
  const gruppi = V.doc.gruppi.filter((g) => !dentro.has(g.id)).map((g) => ({
    id: g.id,
    nome: g.nome,
    compresso: !!g.compresso,
    membri: g.membri.filter((m) => thisPresente(m) || V.doc.gruppi.some((x) => x.id === m)),
    profondita: profondita.get(g.id) || 0,
    ...(g.compresso
      ? { ...posizioneSegnaposto(V.doc, g), conteggio: foglieGruppo(V.doc, g).length }
      : {}),
  }));
  return {
    nodi, links: reali, note, entita,
    logiche, irrisolti: insiemeIrrisolti, gruppi,
    instradamenti,
  };
}

/** Un membro di gruppo che non esiste più nel documento (nodo rimosso). */
function thisPresente(chiave) {
  return !!V.doc.nodi[chiave]
    || V.doc.entita.some((e) => e.id === chiave)
    || V.doc.note.some((n) => n.id === chiave);
}

function monta() {
  const canvas = $('#uml-canvas');
  canvas.innerHTML = '';
  canvas.classList.remove('uml-vuoto');
  V.tavola = new Tavola(canvas, {
    onSelezione: (chiavi) => { V.selezione = chiavi; aggiornaIspettore(); aggiornaComandi(); aggiornaCatalogo(); },
    onInizioGesto: () => segnaGesto(),
    onFineGesto: (posizioni) => {
      for (const [chiave, p] of posizioni) {
        if (V.doc.nodi[chiave]) Object.assign(V.doc.nodi[chiave], p);
        const ent = V.doc.entita.find((e) => e.id === chiave);
        if (ent) Object.assign(ent, p);
        const nota = V.doc.note.find((n) => n.id === chiave);
        if (nota) Object.assign(nota, p);
        // Il segnaposto di un gruppo compresso non ha una posizione propria:
        // spostarlo sposta le foglie nascoste della stessa quantità, a
        // qualunque profondità, così quando il gruppo si espande le ritrova
        // dove il segnaposto le ha portate.
        const gruppo = V.doc.gruppi.find((g) => g.id === chiave);
        if (gruppo) {
          const prima = posizioneSegnaposto(V.doc, gruppo);
          const dx = p.x - prima.x;
          const dy = p.y - prima.y;
          for (const m of foglieGruppo(V.doc, gruppo)) {
            const membro = V.doc.nodi[m]
              || V.doc.entita.find((e) => e.id === m)
              || V.doc.note.find((n) => n.id === m);
            if (membro) { membro.x += dx; membro.y += dy; }
          }
        }
      }
      // Le cornici degli espansi seguono i membri senza ricostruire il grafo.
      if (V.tavola) V.tavola.aggiornaSfondiGruppi();
      modificato();
    },
    onApriDati: (chiave) => apriDati(chiave),
    onCollega: (gesto) => creaRelazioneLogica(gesto),
    onInstrada: (id, vertici) => instradaCollegamento(id, vertici),
    onRilascio: (chiave, punto) => aggiungiAlDiagramma(chiave, punto),
    onZoom: (s) => { const el = $('#uml-zoom-valore'); if (el) el.textContent = `${Math.round(s * 100)}%`; },
    onMenu: (x, y, chiavi) => menuNodo(x, y, chiavi),
    onMenuVuoto: (x, y, punto) => menuCanvas(x, y, punto),
    onVista: () => { /* la minimappa si aggiorna da sé */ },
  });
  V.tavola.modifica = V.modifica;
  V.tavola.aggancio = $('#uml-aggancio') ? $('#uml-aggancio').getAttribute('aria-pressed') === 'true' : true;
  V.tavola.monta(modelloDisegno());
  const mini = $('#uml-minimap');
  if (mini) { mini.innerHTML = ''; V.tavola.montaMinimappa(mini); }
  // «Adatta alla vista» ha bisogno della MISURA del canvas, e il canvas può
  // non averla ancora: la vista UML viene mostrata nello stesso giro in cui la
  // si monta, e un contenitore largo zero fa uscire `adatta` senza fare nulla —
  // il diagramma resta allora dov'è caduto, spesso mezzo fuori dallo schermo.
  const tavola = V.tavola;
  const adattaAppenaMisurabile = () => {
    if (V.tavola !== tavola || tavola.smontato) return;
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0) { tavola.adatta(); return; }
    requestAnimationFrame(adattaAppenaMisurabile);
  };
  requestAnimationFrame(adattaAppenaMisurabile);
  aggiornaCatalogo();
  aggiornaIspettore();
  aggiornaComandi();
  aggiornaTitolo();
}

/** Ridisegna il canvas dal documento, conservando vista e selezione. */
function ridisegna() {
  if (!V.tavola) return;
  const scala = V.tavola.scala;
  const t = V.tavola.paper.translate();
  V.tavola.monta(modelloDisegno());
  V.tavola.paper.scale(scala, scala);
  V.tavola.paper.translate(t.tx, t.ty);
  V.tavola.imposta(V.selezione);
  sincronizzaPannelli();
}

/** Catalogo, ispettore e comandi seguono documento e selezione. */
function sincronizzaPannelli() {
  aggiornaCatalogo();
  aggiornaIspettore();
  aggiornaComandi();
}

function smonta() {
  clearTimeout(V.timerSalvataggio);
  if (V.tavola) { V.tavola.distruggi(); V.tavola = null; }
}

function messaggio(html) {
  const canvas = $('#uml-canvas');
  if (!canvas) return;
  smonta();
  canvas.classList.add('uml-vuoto');
  canvas.innerHTML = `<div class="uml-msg">${html}</div>`;
}

/* =============================== Comandi ================================== */

function applica(doc) {
  V.doc = doc;
  ridisegna();
  modificato();
}

function annulla() {
  const precedente = V.cronologia.annulla(V.doc);
  if (!precedente) return;
  if (V.tavola && stessaStruttura(V.doc, precedente)) {
    // Solo posizioni: le celle esistenti si spostano, senza ricostruire.
    V.doc = precedente;
    V.tavola.sposta(posizioniDocumento(V.doc));
    V.tavola.imposta(V.selezione);
    sincronizzaPannelli();
  } else {
    V.doc = precedente;
    ridisegna();
  }
  modificato();
}

function ripeti() {
  const successivo = V.cronologia.ripeti(V.doc);
  if (!successivo) return;
  if (V.tavola && stessaStruttura(V.doc, successivo)) {
    V.doc = successivo;
    V.tavola.sposta(posizioniDocumento(V.doc));
    V.tavola.imposta(V.selezione);
    sincronizzaPannelli();
  } else {
    V.doc = successivo;
    ridisegna();
  }
  modificato();
}

/**
 * Posizioni di tutto ciò che ha una cella: foglie del documento più i
 * segnaposto dei gruppi compressi, ricalcolati dai membri. Le cornici degli
 * espansi non hanno posizione propria e seguono da sole.
 */
function posizioniDocumento(doc) {
  const out = new Map();
  for (const [k, n] of Object.entries(doc.nodi || {})) out.set(k, { x: n.x, y: n.y });
  for (const e of doc.entita || []) out.set(e.id, { x: e.x, y: e.y });
  for (const n of doc.note || []) out.set(n.id, { x: n.x, y: n.y });
  for (const g of doc.gruppi || []) {
    if (g.compresso) out.set(g.id, posizioneSegnaposto(doc, g));
  }
  return out;
}

function disponi({ registra = true } = {}) {
  if (registra) segnaGesto();
  const chiavi = Object.keys(V.doc.nodi);
  const bloccati = new Set(chiavi.filter((k) => V.doc.nodi[k].bloccato));
  const altezze = new Map(chiavi.map((k) => {
    const campi = campiDi(k);
    const visti = campiVisibili(campi.length, V.doc.nodi[k].compresso !== false);
    return [k, altezzaNodo(visti, campi.length > visti)];
  }));
  const posizioni = disposizione(chiavi, linksCorrenti(), { bloccati, altezze });
  for (const [k, p] of posizioni) Object.assign(V.doc.nodi[k], p);
  if (registra) { ridisegna(); V.tavola.adatta(); modificato(); }
}

function aggiungiAlDiagramma(chiave, punto) {
  if (V.doc.nodi[chiave]) {
    showToast('Quell’oggetto è già nel diagramma: è evidenziato.', 'info');
    V.selezione = [chiave];
    V.tavola.imposta(V.selezione);
    V.tavola.centraSu([chiave]);
    aggiornaIspettore();
    return;
  }
  segnaGesto();
  V.doc.nodi[chiave] = { x: punto.x, y: punto.y, bloccato: false, compresso: true };
  V.selezione = [chiave];
  // Un nodo in più non richiede di ridisegnare gli altri cento: si aggiunge
  // la cella e gli archi che lo toccano, con le stesse regole del ridisegno.
  const ctx = contestoDisegno();
  const tocca = (l) => l.da === chiave || l.a === chiave;
  V.tavola.aggiungi({
    nodi: [modelloNodo(chiave, V.doc.nodi[chiave], ctx.campiFk, ctx.irrisolti)],
    links: ctx.reali.filter(tocca),
    logiche: ctx.logiche.filter(tocca),
    instradamenti: ctx.instradamenti,
  });
  V.tavola.imposta(V.selezione);
  sincronizzaPannelli();
  modificato();
}

function rimuoviDalDiagramma(chiavi) {
  // I collegamenti dello SCHEMA non si tolgono: non sono nel documento. Se la
  // selezione è fatta solo di quelli, non c'è nulla da registrare nella
  // storia e dirlo è meglio che annullare il nulla.
  const toglibili = chiavi.filter((k) => V.doc.nodi[k]
    || V.doc.entita.some((e) => e.id === k)
    || V.doc.note.some((n) => n.id === k)
    || V.doc.logiche.some((l) => l.id === k)
    || V.doc.gruppi.some((g) => g.id === k));
  if (!toglibili.length) {
    showToast('I collegamenti dello schema non si tolgono: nascondi un nodo o comprimi un gruppo.', 'info');
    return;
  }
  segnaGesto();
  for (const k of toglibili) {
    delete V.doc.nodi[k];
    V.doc.entita = V.doc.entita.filter((e) => e.id !== k);
    V.doc.note = V.doc.note.filter((n) => n.id !== k);
    V.doc.logiche = V.doc.logiche.filter((l) => l.id !== k && l.da !== k && l.a !== k);
    // Togliere un segnaposto scioglie il gruppo ma tiene i membri; togliere
    // un membro lo toglie anche dal gruppo, che senza membri non ha senso.
    if (V.doc.gruppi.some((g) => g.id === k)) {
      V.doc.gruppi = V.doc.gruppi.filter((g) => g.id !== k);
    } else {
      for (const g of V.doc.gruppi) g.membri = g.membri.filter((m) => m !== k);
      V.doc.gruppi = V.doc.gruppi.filter((g) => g.membri.length > 0);
    }
  }
  V.selezione = [];
  ridisegna();
  modificato();
  showToast('Rimosso dal DIAGRAMMA. Nel database non è cambiato nulla.', 'info');
}

function commutaNodo(chiavi, campo) {
  // Placchette, archi e segnaposto non hanno l'interruttore: senza chiavi
  // commutabili non c'è gesto, e di certo non una voce di storia sul nulla.
  const toglici = chiavi.filter((k) => V.doc.nodi[k] || V.doc.entita.some((e) => e.id === k));
  if (!toglici.length) return;
  segnaGesto();
  for (const k of toglici) {
    const nodo = V.doc.nodi[k] || V.doc.entita.find((e) => e.id === k);
    nodo[campo] = !nodo[campo];
  }
  // Una compressione rifà UNA cella e gli archi che la toccano, non il grafo.
  const ctx = contestoDisegno();
  for (const k of toglici) {
    if (ctx.dentro.has(k)) continue;
    if (V.doc.nodi[k]) {
      V.tavola.sostituisci({
        chiave: k,
        nodo: modelloNodo(k, V.doc.nodi[k], ctx.campiFk, ctx.irrisolti),
        links: ctx.reali, logiche: ctx.logiche, instradamenti: ctx.instradamenti,
      });
    } else {
      const ent = V.doc.entita.find((e) => e.id === k);
      V.tavola.sostituisci({
        chiave: k,
        entita: { id: ent.id, nome: ent.nome, x: ent.x, y: ent.y, bloccato: ent.bloccato, campi: ent.campi },
        links: ctx.reali, logiche: ctx.logiche, instradamenti: ctx.instradamenti,
      });
    }
  }
  V.tavola.imposta(V.selezione);
  sincronizzaPannelli();
  modificato();
}

/** Scrive nel documento le posizioni decise da un allineamento o una distribuzione. */
function applicaPosizioni(mappa) {
  for (const [chiave, p] of mappa) {
    const nodo = V.doc.nodi[chiave]
      || V.doc.entita.find((e) => e.id === chiave)
      || V.doc.note.find((n) => n.id === chiave);
    if (nodo) Object.assign(nodo, p);
  }
}

/**
 * Allinea gli elementi scelti. È un gesto come gli altri: una voce di storia,
 * i bloccati fermi (li calcola `allinea`, che li usa come bordo ma non li
 * muove) e niente scritture nel database.
 */
function allineaSelezione(modo) {
  if (!ALLINEAMENTI[modo]) return;
  if (V.selezione.length < 2) {
    showToast('Scegli almeno due elementi da allineare.', 'info');
    return;
  }
  const mossa = allinea(V.tavola.riquadri(V.selezione), modo);
  if (!mossa.size) {
    showToast('Gli elementi scelti sono già allineati così.', 'info');
    return;
  }
  segnaGesto();
  applicaPosizioni(mossa);
  ridisegna();
  modificato();
}

function distribuisciSelezione(asse) {
  if (V.selezione.length < 3) {
    showToast('Scegli almeno tre elementi da distribuire.', 'info');
    return;
  }
  const mossa = distribuisci(V.tavola.riquadri(V.selezione), asse);
  if (!mossa.size) {
    showToast('Gli elementi scelti hanno già spazi uguali.', 'info');
    return;
  }
  segnaGesto();
  applicaPosizioni(mossa);
  ridisegna();
  modificato();
}

async function aggiungiNota(punto) {
  const testo = await chiediTesto({
    titolo: 'Nuova nota', etichetta: 'Testo della nota', valore: '',
  });
  if (testo == null) return;
  segnaGesto();
  V.doc.note.push({ id: nuovoId('nota'), x: punto.x, y: punto.y, w: 220, h: 110, testo });
  ridisegna();
  modificato();
}

async function aggiungiEntita(punto) {
  const nome = await chiediTesto({
    titolo: 'Nuova entità di progetto',
    sottotitolo: 'Esiste solo nel diagramma: non viene creata alcuna tabella.',
    etichetta: 'Nome', valore: 'nuova_entita',
  });
  if (!nome) return;
  segnaGesto();
  V.doc.entita.push({ id: nuovoId('ent'), nome, x: punto.x, y: punto.y, bloccato: false, campi: [{ nome: 'id', tipo: 'integer' }] });
  ridisegna();
  modificato();
}

function creaRelazioneLogica({ da, a, campoDa, campoA }) {
  if (!da || !a) return;
  segnaGesto();
  V.doc.logiche.push({
    id: nuovoId('log'), da, a, etichetta: '', cardinalita: '1-N',
    campoDa: campoDa || '', campoA: campoA || '',
  });
  ridisegna();
  modificato();
  // Una linea disegnata non è un vincolo: dirlo una volta è ciò che impedisce
  // di credere di aver appena creato una FK.
  showToast('Relazione LOGICA aggiunta al diagramma. Nel database non è stato creato alcun vincolo.', 'info');
}

/* ------------------------------- Gruppi ----------------------------------- */

/** Il gruppo a cui la selezione corrisponde esattamente, o un suo segnaposto. */
function gruppoSelezionato() {
  if (V.selezione.length === 1) {
    const segnaposto = V.doc.gruppi.find((g) => g.id === V.selezione[0]);
    if (segnaposto) return segnaposto;
  }
  const scelti = new Set(V.selezione);
  return V.doc.gruppi.find((g) => g.membri.length > 0
    && g.membri.length === scelti.size
    && g.membri.every((m) => scelti.has(m))) || null;
}

async function raggruppaSelezione(chiavi) {
  const elementi = chiavi.filter((k) => V.doc.nodi[k]
    || V.doc.entita.some((e) => e.id === k)
    || V.doc.note.some((n) => n.id === k)
    || V.doc.gruppi.some((g) => g.id === k));
  if (elementi.length < 2) {
    showToast('Scegli almeno due elementi da raggruppare.', 'info');
    return;
  }
  const nome = await chiediTesto({
    titolo: 'Nuovo gruppo',
    etichetta: 'Nome',
    valore: `Gruppo ${V.doc.gruppi.length + 1}`,
  });
  if (!nome) return;
  segnaGesto();
  // Un figlio sta in un gruppo solo, e raggruppare crea sempre una radice
  // nuova: per questo l'interfaccia non può creare cicli — un ciclo può
  // arrivare solo da un file, ed è `normalizzaGruppi` a romperlo.
  const svuotati = [];
  for (const g of V.doc.gruppi) {
    const prima = g.membri.length;
    g.membri = g.membri.filter((m) => !elementi.includes(m));
    if (prima > 0 && g.membri.length === 0) svuotati.push(g.nome);
  }
  V.doc.gruppi = V.doc.gruppi.filter((g) => g.membri.length > 0);
  const gruppo = { id: nuovoId('grp'), nome, membri: elementi, compresso: false, x: 0, y: 0 };
  V.doc.gruppi.push(gruppo);
  V.selezione = [...elementi];
  ridisegna();
  V.tavola.imposta(V.selezione);
  modificato();
  if (svuotati.length) showToast(`Il gruppo «${svuotati[0]}» è rimasto vuoto ed è stato tolto.`, 'info');
}

function commutaGruppo(gruppo) {
  segnaGesto();
  gruppo.compresso = !gruppo.compresso;
  V.selezione = gruppo.compresso ? [gruppo.id] : [...gruppo.membri];
  ridisegna();
  V.tavola.imposta(V.selezione);
  modificato();
  if (gruppo.compresso) {
    showToast(`${foglieGruppo(V.doc, gruppo).length} elementi raccolti nel gruppo: gli archi seguono il segnaposto.`, 'info');
  }
}

function sciogliGruppo(gruppo) {
  segnaGesto();
  V.doc.gruppi = V.doc.gruppi.filter((g) => g.id !== gruppo.id);
  V.selezione = [...gruppo.membri];
  ridisegna();
  V.tavola.imposta(V.selezione);
  modificato();
}

async function rinominaGruppo(gruppo) {
  const nome = await chiediTesto({ titolo: 'Rinomina gruppo', etichetta: 'Nome', valore: gruppo.nome });
  if (!nome) return;
  segnaGesto();
  gruppo.nome = nome;
  ridisegna();
  modificato();
}

/* ------------------------- Instradamento manuale -------------------------- */

/**
 * Scrive i vertici trascinati nel documento. La voce di storia è già stata
 * aperta dal tavolo al primo movimento: qui non si registra nulla, altrimenti
 * un trascinamento diventerebbe N voci quante sono le notifiche intermedie.
 * Senza vertici, l'instradamento torna automatico.
 */
function instradaCollegamento(idLink, vertici) {
  const puliti = (Array.isArray(vertici) ? vertici : [])
    .filter((v) => v && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)))
    .slice(0, 50)
    .map((v) => ({ x: Math.round(Number(v.x)), y: Math.round(Number(v.y)) }));
  V.doc.instradamenti = V.doc.instradamenti || {};
  if (!puliti.length) delete V.doc.instradamenti[idLink];
  else V.doc.instradamenti[idLink] = puliti;
  modificato();
}

/* =============================== Catalogo ================================= */

function aggiornaCatalogo() {
  const el = $('#uml-catalogo-lista');
  if (!el || !V.schema) return;
  const filtro = V.filtroCatalogo.trim().toLowerCase();
  const scelte = new Set(V.selezione);
  const voci = (V.schema.collections || []).map((c) => {
    const chiave = chiaveDi(c.name);
    const campi = (c.fields || []).map((f) => f.name);
    const perCampo = filtro && campi.some((n) => n.toLowerCase().includes(filtro));
    return { c, chiave, perCampo, visibile: !filtro || c.name.toLowerCase().includes(filtro) || perCampo };
  }).filter((v) => v.visibile);

  if (!voci.length) {
    el.innerHTML = '<li class="uml-cat-vuoto">Nessun oggetto corrisponde alla ricerca.</li>';
    return;
  }
  el.innerHTML = voci.map(({ c, chiave, perCampo }) => {
    const dentro = !!V.doc.nodi[chiave];
    return `<li class="uml-cat-voce${dentro ? ' dentro' : ''}${scelte.has(chiave) ? ' scelta' : ''}"
      draggable="true" data-chiave="${esc(chiave)}" title="${esc(c.name)} — ${dentro ? 'già nel diagramma' : 'trascina sul diagramma'}">
      <i data-lucide="${dentro ? 'check-square' : 'table-2'}" aria-hidden="true"></i>
      <span class="uml-cat-nome">${esc(c.name)}</span>
      <span class="uml-cat-meta">${c.rowsApprox == null ? '' : `~${c.rowsApprox}`}</span>
      ${perCampo ? '<span class="uml-cat-badge">campo</span>' : ''}
    </li>`;
  }).join('');
  refreshLucideIcons(el);

  disegnaPiedeCatalogo();
}

/**
 * Che cosa manca ancora, per risorsa. «Riepilogo progressivo» diceva soltanto
 * quante tabelle erano state lette: con tre cursori indipendenti possono
 * mancare le tabelle, le colonne di una tabella o le relazioni, e sono tre
 * cose diverse — nascondere la differenza vuol dire far cercare all'utente in
 * un elenco che non sa di essere incompleto proprio dove lui sta guardando.
 */
function disegnaPiedeCatalogo(stato = '') {
  const piede = $('#uml-catalogo-piede');
  if (!piede || !V.schema) return;
  const page = V.schema.schemaPage;
  const n = V.schema.collections.length;
  if (stato) { piede.innerHTML = esc(stato); return; }
  // Quanti oggetti del catalogo NON sono sul diagramma. Sono due conteggi
  // diversi e nessuno dei due implica l'altro: un diagramma nuovo nasce con le
  // tabelle lette FINO A QUEL MOMENTO, quindi su un catalogo che arriva a
  // pezzi quelle delle pagine successive restano nel catalogo e basta — e
  // «tutti i metadati letti» diceva il vero sui metadati mentre taceva
  // sull'unica cosa che l'utente sta guardando, cioè che il disegno non le
  // contiene. Vale anche dopo un «Rimuovi dal diagramma»: la voce del catalogo
  // resta, il nodo no.
  const fuori = (V.schema.collections || [])
    .filter((c) => !V.doc.nodi[chiaveDi(c.name)]).length;
  const nota = fuori ? ` · ${fuori} non sul diagramma (trascinali dal catalogo)` : '';
  if (!page || page.complete) {
    piede.innerHTML = `${n} oggetti · tutti i metadati letti${esc(nota)}`;
    return;
  }
  const mancano = [
    page.fine && !page.fine.collezioni ? `${page.totals.collections - n} oggetti` : '',
    page.fine && !page.fine.campi ? `${page.omitted.fields} colonne` : '',
    page.fine && !page.fine.relazioni ? `${page.omitted.relations} relazioni` : '',
  ].filter(Boolean);
  piede.innerHTML = `${n} oggetti letti${esc(nota)} · mancano ${esc(mancano.join(', '))}.
    <button type="button" id="uml-altri" class="link-btn">Leggi il resto</button>`;
  const altri = $('#uml-altri');
  if (altri) altri.onclick = () => completaSchema();
}

/**
 * Legge il resto dello schema, seguendo i TRE cursori finché non finiscono.
 *
 * Non è un ciclo «carica altri» che l'utente deve premere finché non succede
 * più niente: ogni giro avanza la risorsa che lo dichiara incompleta — il
 * catalogo, le relazioni, e le colonne delle tabelle che ne hanno ancora. Il
 * tetto sui giri non è cautela generica: è ciò che impedisce a una risposta
 * che non avanza (un cursore che torna sempre lo stesso) di diventare un
 * ciclo infinito contro il proprio server.
 *
 * Se il catalogo cambia mentre si pagina, il server lo dichiara
 * (`revisioneCambiata`) e si riparte da capo: fondere due mezzi cataloghi
 * diversi credendoli lo stesso è il difetto che la revisione esiste per
 * impedire.
 */
async function completaSchema({ maxGiri = 40 } = {}) {
  const congelato = congelaContesto(V.contesto);
  const btn = $('#uml-altri');
  if (btn) { btn.disabled = true; btn.textContent = 'lettura…'; }
  try {
    for (let giro = 0; giro < maxGiri; giro++) {
      const page = V.schema && V.schema.schemaPage;
      if (!page || page.complete) break;
      const cursori = page.cursori || {};
      const richiesta = {
        tabId: congelato.tabId, db: congelato.db, progressive: true, ...BUDGET,
        revisione: page.revisione,
        cursor: cursori.collezioni || 0,
        relationCursor: cursori.relazioni || 0,
        fieldCursors: cursori.campi || {},
      };
      const next = await emit('db:schema', richiesta);
      if (!ancoraQui(congelato)) return;
      if (next.schemaPage && next.schemaPage.revisioneCambiata) {
        // Il catalogo è cambiato sotto: ciò che era stato letto descrive uno
        // schema che non c'è più.
        V.schema = next;
        showToast('Lo schema del database è cambiato durante la lettura: riletto da capo.', 'info');
      } else {
        V.schema = unisciSchema(V.schema, next);
      }
      if (next._state) { next._state.dbSchema = V.schema; next._state.dbSchemaFor = congelato.db; }
      aggiornaCatalogo();
      disegnaPiedeCatalogo(`lettura… ${V.schema.collections.length} oggetti`);
      // Un cursore che non avanza è un contratto rotto, non una pagina vuota:
      // fermarsi e dirlo è meglio che ripetere la stessa richiesta.
      if (!avanzato(page, V.schema.schemaPage)) break;
    }
    ridisegna();
    disegnaPiedeCatalogo();
  } catch (err) {
    showToast(err.message, 'error');
    disegnaPiedeCatalogo();
  }
}

function avanzato(prima, dopo) {
  if (!prima || !dopo) return false;
  return JSON.stringify(prima.cursori || {}) !== JSON.stringify(dopo.cursori || {})
    || prima.complete !== dopo.complete;
}

/* ============================== Ispettore ================================= */

function aggiornaIspettore() {
  const el = $('#uml-ispettore-corpo');
  if (!el) return;
  if (V.selezione.length !== 1) {
    el.innerHTML = V.selezione.length
      ? `<p class="hint">${V.selezione.length} elementi selezionati.</p>`
      : '<p class="hint">Scegli un nodo o un collegamento per vederne i metadati.</p>';
    return;
  }
  const chiave = V.selezione[0];
  const link = linksCorrenti().find((l) => l.id === chiave)
    || V.doc.logiche.find((l) => l.id === chiave);
  if (link) { el.innerHTML = schedaCollegamento(link); refreshLucideIcons(el); return; }
  const gruppo = V.doc.gruppi.find((g) => g.id === chiave);
  if (gruppo) { el.innerHTML = schedaGruppo(gruppo); collegaIspettore(el, chiave); return; }
  const ent = V.doc.entita.find((e) => e.id === chiave);
  if (ent) { el.innerHTML = schedaEntita(ent); collegaIspettore(el, chiave); return; }
  const nota = V.doc.note.find((n) => n.id === chiave);
  if (nota) { el.innerHTML = schedaNota(nota); collegaIspettore(el, chiave); return; }
  el.innerHTML = schedaOggetto(chiave);
  collegaIspettore(el, chiave);
  chiediDettagli(chiave);
}

function schedaOggetto(chiave) {
  const parti = leggiChiave(chiave);
  if (!parti) return '<p class="error">Identità del nodo non leggibile.</p>';
  const c = collezione(parti.nome);
  const dettaglio = V.dettagli.get(chiave);
  const campi = campiDi(chiave);
  const nodo = V.doc.nodi[chiave] || {};
  const completezza = dettaglio && dettaglio.fields
    ? '<span class="uml-stato-dato ok">caricato</span>'
    : (dettaglio && dettaglio.errore
      ? '<span class="uml-stato-dato assente">non disponibile</span>'
      : (c && c.fieldsPage && !c.fieldsPage.complete
        ? '<span class="uml-stato-dato parziale">parziale</span>'
        : '<span class="uml-stato-dato attesa">in lettura…</span>'));
  // MongoDB non DICHIARA i campi: li si osserva su un campione. Dirlo non è
  // pignoleria — senza, un campo raro assente da questo elenco è
  // indistinguibile da un campo che non esiste, e l'elenco ha l'aria di essere
  // esaustivo proprio perché non dice il contrario. Vale finché lo schema
  // osservato resta campionato, anche dopo l'arrivo dei dettagli.
  const campionamento = V.schema && V.schema.schemaPage && V.schema.schemaPage.campionamento;
  const notaCampione = campionamento
    ? `<p class="hint">Campi <strong>osservati</strong> su ${campionamento.documenti} documenti per collection,
       letti ${esc(dataLeggibile(campionamento.quando))}. Un campione più grande non certifica comunque
       l’assenza di altri campi.</p>`
    : '';
  const uscenti = linksCorrenti().filter((l) => l.da === chiave);
  const entranti = linksCorrenti().filter((l) => l.a === chiave);

  return `
    <h4 class="uml-isp-titolo">${esc(parti.nome)}</h4>
    <p class="uml-isp-sotto">${esc(parti.db)} · ${esc(parti.tipo)} ${completezza}</p>
    ${c && c.rowsApprox != null ? `<p class="hint">Righe stimate: ~${c.rowsApprox} (stima del motore, non un conteggio).</p>` : ''}
    ${notaCampione}
    <div class="uml-isp-azioni">
      <button type="button" class="ghost" data-isp="dati"><i data-lucide="table-2"></i> Dati</button>
      <button type="button" class="ghost" data-isp="griglia"><i data-lucide="external-link"></i> Apri nella griglia</button>
      <button type="button" class="ghost" data-isp="espandi"><i data-lucide="${nodo.compresso === false ? 'chevrons-down-up' : 'chevrons-up-down'}"></i> ${nodo.compresso === false ? 'Comprimi' : 'Espandi'}</button>
      <button type="button" class="ghost" data-isp="blocca" aria-pressed="${!!nodo.bloccato}"><i data-lucide="${nodo.bloccato ? 'lock' : 'lock-open'}"></i> ${nodo.bloccato ? 'Sbloccato' : 'Blocca'}</button>
      <button type="button" class="ghost" data-isp="rimuovi"><i data-lucide="eye-off"></i> Rimuovi dal diagramma</button>
    </div>
    <h5 class="uml-isp-sez">Campi (${campi.length})</h5>
    <table class="uml-isp-tab"><tbody>
      ${campi.map((f) => `<tr>
        <td>${f.pk ? '<span class="uml-tag">PK</span> ' : ''}${esc(f.name)}</td>
        <td class="mono">${esc((f.types || []).join('|'))}</td>
        <td class="mono dim">${f.nullable === false ? 'NOT NULL' : ''}</td>
      </tr>`).join('')}
    </tbody></table>
    ${dettaglio && dettaglio.indexes && dettaglio.indexes.length ? `
      <h5 class="uml-isp-sez">Indici (${dettaglio.indexes.length})</h5>
      <ul class="uml-isp-elenco">${dettaglio.indexes.map((i) => `<li class="mono">${esc(i.name)} ${i.unique ? '<span class="uml-tag">UNIQUE</span>' : ''} <span class="dim">${esc(Object.keys(i.key || {}).join(', '))}</span></li>`).join('')}</ul>` : ''}
    <h5 class="uml-isp-sez">Relazioni (${uscenti.length + entranti.length})</h5>
    <ul class="uml-isp-elenco">
      ${[...uscenti.map((l) => ({ l, verso: '→' })), ...entranti.map((l) => ({ l, verso: '←' }))].map(({ l, verso }) => `
        <li>
          <span class="uml-tag ${l.origine === VINCOLO ? 'vincolo' : 'ipotesi'}">${l.origine === VINCOLO ? 'FK' : 'ipotesi'}</span>
          ${verso} <strong>${esc(verso === '→' ? l.aNome : l.daNome)}</strong>
          <span class="mono dim">${esc(l.coppie.map((p) => `${p.campo}${p.colonna ? `→${p.colonna}` : ''}`).join(', '))}</span>
          ${l.composta ? '<span class="uml-tag">composta</span>' : ''}
          ${l.esterna ? '<span class="uml-tag">altro schema</span>' : ''}
          ${verso === '→' ? `<button type="button" class="link-btn" data-collegati="${esc(l.id)}">righe collegate</button>` : ''}
        </li>`).join('') || '<li class="dim">Nessuna.</li>'}
    </ul>`;
}

/** Data leggibile, o la stringa grezza se il server ne ha mandata una strana. */
function dataLeggibile(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleString('it-IT');
}

function schedaCollegamento(l) {
  const logica = !l.origine || l.origine === 'logica';
  const manuale = V.doc.instradamenti && V.doc.instradamenti[l.id];
  return `
    <h4 class="uml-isp-titolo">${esc(l.nome || (logica ? 'Relazione logica' : 'Collegamento'))}</h4>
    <p class="uml-isp-sotto">Origine: <strong>${esc(logica ? 'logica del diagramma' : (l.origine === VINCOLO ? 'vincolo del database' : 'rilevata (ipotesi)'))}</strong></p>
    ${logica ? '<p class="hint">Esiste solo nel diagramma: nel database non c’è alcun vincolo corrispondente.</p>' : ''}
    ${l.origine === 'rilevata' ? '<p class="hint">Dedotta dal nome del campo e dai tipi osservati: la cardinalità è un’ipotesi, non un vincolo.</p>' : ''}
    ${manuale ? '<p class="hint">Instradato a mano: i vertici sono salvati nel diagramma.</p>' : ''}
    <h5 class="uml-isp-sez">Coppie di colonne</h5>
    <ul class="uml-isp-elenco mono">
      ${(l.coppie || []).map((p) => `<li>${esc(p.campo)} → ${esc(p.colonna || '—')}</li>`).join('')
      || `<li>${esc(l.campoDa || '—')} → ${esc(l.campoA || '—')}</li>`}
    </ul>
    ${(manuale || logica) ? `<div class="uml-isp-azioni">
      ${manuale ? '<button type="button" class="ghost" data-isp="raddrizza"><i data-lucide="spline"></i> Raddrizza</button>' : ''}
      ${logica ? '<button type="button" class="ghost" data-isp="rimuovi"><i data-lucide="trash-2"></i> Elimina la relazione</button>' : ''}
    </div>` : ''}`;
}

function schedaEntita(ent) {
  return `
    <h4 class="uml-isp-titolo">${esc(ent.nome)}</h4>
    <p class="uml-isp-sotto">Entità di progetto · esiste solo nel diagramma</p>
    <h5 class="uml-isp-sez">Campi</h5>
    <ul class="uml-isp-elenco mono">${ent.campi.map((c) => `<li>${esc(c.nome)} <span class="dim">${esc(c.tipo)}</span></li>`).join('') || '<li class="dim">Nessuno.</li>'}</ul>
    <div class="uml-isp-azioni">
      <button type="button" class="ghost" data-isp="campo"><i data-lucide="plus"></i> Aggiungi campo</button>
      <button type="button" class="ghost" data-isp="rinomina"><i data-lucide="square-pen"></i> Rinomina</button>
      <button type="button" class="ghost" data-isp="rimuovi"><i data-lucide="trash-2"></i> Elimina</button>
    </div>`;
}

function schedaNota(nota) {
  return `
    <h4 class="uml-isp-titolo">Nota</h4>
    <p class="uml-isp-sotto">${esc(displayValueBreve(nota.testo, 300).text ?? '')}</p>
    <div class="uml-isp-azioni">
      <button type="button" class="ghost" data-isp="rinomina"><i data-lucide="square-pen"></i> Modifica testo</button>
      <button type="button" class="ghost" data-isp="rimuovi"><i data-lucide="trash-2"></i> Elimina</button>
    </div>`;
}

/** Nome leggibile di un membro di gruppo per l'elenco dell'ispettore. */
function nomeMembro(chiave) {
  const sub = V.doc.gruppi.find((g) => g.id === chiave);
  if (sub) return `${sub.nome} (gruppo, ${foglieGruppo(V.doc, sub).length} elementi)`;
  const ent = V.doc.entita.find((e) => e.id === chiave);
  if (ent) return `${ent.nome} (progetto)`;
  const nota = V.doc.note.find((n) => n.id === chiave);
  if (nota) return `Nota: ${displayValueBreve(nota.testo, 40).text ?? ''}`;
  const parti = leggiChiave(chiave);
  return parti ? parti.nome : chiave;
}

function schedaGruppo(gruppo) {
  const foglie = foglieGruppo(V.doc, gruppo).length;
  return `
    <h4 class="uml-isp-titolo">${esc(gruppo.nome)}</h4>
    <p class="uml-isp-sotto">Gruppo · ${foglie} elementi${foglie !== gruppo.membri.length ? ` in ${gruppo.membri.length} voci` : ''} · ${gruppo.compresso ? 'compresso' : 'espanso'}</p>
    ${gruppo.compresso ? '<p class="hint">I membri sono nascosti nel segnaposto; gli archi seguono il gruppo.</p>' : ''}
    <h5 class="uml-isp-sez">Membri</h5>
    <ul class="uml-isp-elenco">${gruppo.membri.map((m) => `<li>${esc(nomeMembro(m))}</li>`).join('') || '<li class="dim">Nessuno.</li>'}</ul>
    <div class="uml-isp-azioni">
      <button type="button" class="ghost" data-isp="gruppo-comprimi"><i data-lucide="${gruppo.compresso ? 'unfold-vertical' : 'fold-vertical'}"></i> ${gruppo.compresso ? 'Espandi' : 'Comprimi'}</button>
      <button type="button" class="ghost" data-isp="gruppo-rinomina"><i data-lucide="square-pen"></i> Rinomina</button>
      <button type="button" class="ghost" data-isp="gruppo-sciogli"><i data-lucide="ungroup"></i> Sciogli</button>
    </div>`;
}

function collegaIspettore(el, chiave) {
  refreshLucideIcons(el);
  el.querySelectorAll('[data-isp]').forEach((btn) => {
    btn.onclick = () => azioneIspettore(btn.dataset.isp, chiave);
  });
  el.querySelectorAll('[data-collegati]').forEach((btn) => {
    btn.onclick = () => apriCollegati(btn.dataset.collegati);
  });
}

async function azioneIspettore(azione, chiave) {
  const gruppo = V.doc.gruppi.find((g) => g.id === chiave);
  if (gruppo) {
    if (azione === 'gruppo-comprimi') { commutaGruppo(gruppo); return; }
    if (azione === 'gruppo-rinomina') { rinominaGruppo(gruppo); return; }
    if (azione === 'gruppo-sciogli') { sciogliGruppo(gruppo); return; }
    if (azione === 'rimuovi') { rimuoviDalDiagramma([chiave]); return; }
    return;
  }
  if (azione === 'raddrizza') {
    segnaGesto();
    instradaCollegamento(chiave, []);
    ridisegna();
    return;
  }
  const parti = leggiChiave(chiave);
  if (azione === 'dati') { apriDati(chiave); return; }
  if (azione === 'griglia' && parti) { selectCollection(parti.db, parti.nome); setView('data'); return; }
  if (azione === 'espandi') { commutaNodo([chiave], 'compresso'); return; }
  if (azione === 'blocca') { commutaNodo([chiave], 'bloccato'); return; }
  if (azione === 'rimuovi') { rimuoviDalDiagramma([chiave]); return; }
  if (azione === 'rinomina') {
    const nota = V.doc.note.find((n) => n.id === chiave);
    const ent = V.doc.entita.find((e) => e.id === chiave);
    const valore = nota ? nota.testo : (ent ? ent.nome : '');
    const nuovo = await chiediTesto({ titolo: nota ? 'Testo della nota' : 'Nome dell’entità', etichetta: 'Valore', valore });
    if (nuovo == null) return;
    segnaGesto();
    if (nota) nota.testo = nuovo; else if (ent) ent.nome = nuovo;
    ridisegna();
    modificato();
    return;
  }
  if (azione === 'campo') {
    const ent = V.doc.entita.find((e) => e.id === chiave);
    if (!ent) return;
    const nome = await chiediTesto({ titolo: 'Nuovo campo', etichetta: 'nome tipo', valore: 'campo integer' });
    if (!nome) return;
    const [n, ...tipo] = nome.trim().split(/\s+/);
    segnaGesto();
    ent.campi.push({ nome: n, tipo: tipo.join(' ') });
    ridisegna();
    modificato();
  }
}

/**
 * Metadati COMPLETI dell'oggetto scelto. Lo schema progressivo taglia i campi
 * al tetto di pagina; `collection:stats` invece porta l'elenco intero di quella
 * sola tabella, indici compresi — è la via con cui «tutti i metadati
 * autorizzati sono raggiungibili» senza scaricare l'intero database.
 */
async function chiediDettagli(chiave) {
  if (V.dettagli.has(chiave)) return;
  const parti = leggiChiave(chiave);
  if (!parti || !parti.nome) return;
  const congelato = congelaContesto(V.contesto);
  try {
    const res = await emit('collection:stats', { tabId: congelato.tabId, db: parti.db, coll: parti.nome });
    if (!ancoraQui(congelato)) return;
    V.dettagli.set(chiave, { fields: res.fields || [], indexes: res.indexes || [], stats: res.stats || null });
    // NON si ridisegna il canvas: `ridisegna()` ricostruisce tutte le celle, e
    // questa risposta arriva mentre l'utente sta ancora tenendo premuto il
    // nodo appena scelto — ricostruirlo sotto le dita ANNULLA il gesto in
    // corso, e il primo trascinamento dopo ogni selezione non faceva nulla.
    // La sintesi resta sul nodo, i metadati completi vanno nell'ispettore: è
    // la distinzione che il diagramma dichiara, non un ripiego.
    if (V.selezione.length === 1 && V.selezione[0] === chiave) aggiornaIspettore();
  } catch (err) {
    if (!ancoraQui(congelato)) return;
    V.dettagli.set(chiave, { fields: null, indexes: [], errore: err.message });
    if (V.selezione.length === 1 && V.selezione[0] === chiave) {
      const el = $('#uml-ispettore-corpo');
      if (el) el.insertAdjacentHTML('beforeend', `<p class="error">Metadati non disponibili: ${esc(err.message)}</p>`);
    }
  }
}

/* ============================ Pannello dati =============================== */

function apriDati(chiave, opzioni = {}) {
  const parti = leggiChiave(chiave);
  if (!parti || !parti.nome) return;
  const pannello = $('#uml-dati');
  pannello.classList.remove('hidden');
  V.dati = {
    chiave, db: parti.db, coll: parti.nome, skip: 0, docs: [], columns: [],
    filtro: opzioni.filtro || null, titolo: opzioni.titolo || null, rigaScelta: null,
  };
  leggiPaginaDati();
}

async function leggiPaginaDati() {
  const d = V.dati;
  if (!d) return;
  const corpo = $('#uml-dati-corpo');
  corpo.innerHTML = '<div class="uml-msg">Lettura…</div>';
  $('#uml-dati-titolo').textContent = d.titolo || `${d.db} · ${d.coll}`;
  const congelato = congelaContesto({ ...V.contesto, chiave: d.chiave, skip: d.skip });
  try {
    const res = await emit('collection:find', {
      tabId: V.contesto.tabId, db: d.db, coll: d.coll,
      ...(d.filtro ? { filtro: d.filtro } : {}),
      limit: RIGHE_PAGINA, skip: d.skip, deferCount: true,
    });
    if (!V.dati || V.dati.chiave !== congelato.chiave || V.dati.skip !== congelato.skip) return;
    if (!ancoraQui(V.contesto)) return;
    d.docs = res.docs || [];
    d.columns = res.columns || [];
    disegnaDati();
  } catch (err) {
    corpo.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  }
}

function disegnaDati() {
  const d = V.dati;
  const corpo = $('#uml-dati-corpo');
  const colonne = d.columns && d.columns.length
    ? d.columns
    : [...new Set(d.docs.flatMap((r) => Object.keys(r)))];
  if (!d.docs.length) {
    corpo.innerHTML = '<div class="uml-msg">Nessuna riga in questa pagina.</div>';
  } else {
    corpo.innerHTML = `<table class="uml-dati-tab"><thead><tr>${colonne.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${d.docs.map((r, i) => `<tr data-riga="${i}" class="${d.rigaScelta === i ? 'scelta' : ''}">${colonne.map((c) => {
        // Come la griglia: testo breve più classe del tipo, mai l'oggetto.
        const { text, cls } = displayValueBreve(r[c], 120);
        return `<td${cls ? ` class="${cls}"` : ''}>${esc(text ?? '')}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table>`;
    corpo.querySelectorAll('tr[data-riga]').forEach((tr) => {
      tr.onclick = () => {
        d.rigaScelta = Number(tr.dataset.riga);
        disegnaDati();
        aggiornaIspettore();
      };
    });
  }
  disegnaDettaglioRiga();
  $('#uml-dati-pagina').textContent = `righe ${d.skip + 1}–${d.skip + d.docs.length}`;
  $('#uml-dati-prec').disabled = d.skip === 0;
  $('#uml-dati-succ').disabled = d.docs.length < RIGHE_PAGINA;
}

/**
 * La riga scelta per INTERO, in Extended JSON.
 *
 * La tabella accorcia i valori a 120 caratteri — deve, altrimenti una colonna
 * con dentro un documento renderebbe illeggibili tutte le altre — e con i soli
 * valori accorciati un sottodocumento, un array o un testo lungo non si possono
 * leggere affatto. `buildJsonNode` è lo stesso albero della griglia: i tipi
 * BSON restano tipi, e nessun numero passa da `Number`.
 */
function disegnaDettaglioRiga() {
  const pannello = $('#uml-dati-json');
  if (!pannello) return;
  const d = V.dati;
  const acceso = $('#uml-dati-dettaglio') && $('#uml-dati-dettaglio').getAttribute('aria-pressed') === 'true';
  pannello.classList.toggle('hidden', !acceso);
  if (!acceso) return;
  const riga = d && d.rigaScelta != null ? d.docs[d.rigaScelta] : null;
  pannello.innerHTML = '';
  if (!riga) {
    pannello.innerHTML = '<p class="hint">Scegli una riga per vederla per intero.</p>';
    return;
  }
  pannello.appendChild(buildJsonNode(riga, null, true));
}

/**
 * Righe collegate da una FK: il filtro usa TUTTE le coppie del vincolo, non
 * solo la prima. Con una sola coppia, su una FK composta, si otterrebbero le
 * righe di un altro ordine che condividono il primo pezzo di chiave.
 */
function apriCollegati(idLink) {
  const link = linksCorrenti().find((l) => l.id === idLink);
  if (!link) return;
  const d = V.dati;
  const riga = d && d.rigaScelta != null && d.chiave === link.da ? d.docs[d.rigaScelta] : null;
  if (!riga) {
    showToast('Scegli prima una riga nel pannello dati dell’oggetto di partenza.', 'info');
    apriDati(link.da);
    return;
  }
  const condizioni = link.coppie
    .filter((p) => p.colonna)
    .map((p) => ({ campo: p.colonna, operatore: 'uguale', valore: riga[p.campo] }));
  if (condizioni.length !== link.coppie.length) {
    showToast('Questa relazione non dichiara la colonna di destinazione: le righe collegate non sono risolvibili.', 'warning');
    return;
  }
  apriDati(link.a, {
    filtro: { condizioni, unione: 'e' },
    titolo: `${link.aNome} collegate a ${link.daNome}`,
  });
}

/* ========================== Import ed esportazione ======================== */

function scarica(nomeFile, contenuto, tipo) {
  const blob = contenuto instanceof Blob ? contenuto : new Blob([contenuto], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeFile;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function nomeFile(estensione) {
  return `${(V.doc.nome || 'diagramma').replace(/[^\w.-]+/g, '_')}.${estensione}`;
}

async function esporta(formato, soloSelezione = false) {
  try {
    if (formato === 'json') {
      scarica(nomeFile('codedb-uml.json'), JSON.stringify(V.doc, null, 2), 'application/json');
      return;
    }
    if (formato === 'svg') {
      scarica(nomeFile('svg'), V.tavola.esportaSvg({ soloSelezione }), 'image/svg+xml');
      return;
    }
    const png = await V.tavola.esportaPng({ soloSelezione });
    if (!png) throw new Error('Il PNG non è stato prodotto.');
    scarica(nomeFile('png'), png, 'image/png');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function importa() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { showToast('File troppo grande (oltre 8 MB): non è un diagramma.', 'error'); return; }
    let grezzo;
    try {
      grezzo = JSON.parse(await file.text());
    } catch (err) {
      showToast(`File non leggibile: ${err.message}`, 'error');
      return;
    }
    const { doc, avvisi } = validaDocumento(grezzo);
    const chiaviSchema = new Set((V.schema.collections || []).map((c) => chiaveDi(c.name)));
    const { irrisolti } = riconcilia(doc, chiaviSchema);
    const riepilogo = [
      `Nodi: ${Object.keys(doc.nodi).length}`,
      `Note: ${doc.note.length}`,
      `Entità di progetto: ${doc.entita.length}`,
      `Relazioni logiche: ${doc.logiche.length}`,
      irrisolti.length ? `Non risolti nello schema corrente: ${irrisolti.length}` : '',
      ...avvisi,
    ].filter(Boolean).join('\n');
    // Il documento corrente non viene sostituito senza una scelta esplicita.
    const conferma = await chiediTesto({
      titolo: 'Importare questo diagramma?',
      sottotitolo: `${riepilogo}\n\nIl diagramma aperto verrà sostituito. Scrivi il nome da dare a quello importato.`,
      etichetta: 'Nome', valore: doc.nome,
    });
    if (conferma == null) return;
    segnaGesto();
    doc.nome = conferma || doc.nome;
    applica(doc);
    aggiornaTitolo();
  };
  input.click();
}

/* ============================== Diagrammi ================================= */

function aggiornaElencoDiagrammi(lista) {
  const sel = $('#uml-diagrammi');
  if (!sel) return;
  const elenco = lista && lista.length ? lista : [{ id: V.idDiagramma, nome: V.doc.nome }];
  sel.innerHTML = elenco.map((d) => `<option value="${esc(d.id)}"${d.id === V.idDiagramma ? ' selected' : ''}>${esc(d.nome)}</option>`).join('');
}

async function apriDiagramma(id) {
  const record = await archivio.leggi(V.ambito, id).catch(() => null);
  if (!record) { showToast('Diagramma non trovato.', 'error'); return; }
  const { doc, avvisi } = validaDocumento(record.doc);
  V.doc = doc;
  V.idDiagramma = record.id;
  V.revisione = record.revisione || 0;
  V.cronologia.azzera();
  V.selezione = [];
  ridisegna();
  V.tavola.adatta();
  aggiornaTitolo();
  mostraStato('salvato');
  if (avvisi.length) showToast(avvisi[0], 'warning');
}

async function nuovoDiagramma() {
  const nome = await chiediTesto({ titolo: 'Nuovo diagramma', etichetta: 'Nome', valore: `Diagramma ${new Date().toLocaleDateString('it-IT')}` });
  if (!nome) return;
  V.doc = documentoVuoto(nome);
  V.idDiagramma = nuovoId('dia');
  V.revisione = 0;
  V.cronologia.azzera();
  V.selezione = [];
  ridisegna();
  aggiornaTitolo();
  await salvaOra();
  aggiornaElencoDiagrammi(await archivio.elenca(V.ambito).catch(() => []));
}

/** Rinomina, duplica o elimina il diagramma aperto. */
function menuDiagramma(x, y) {
  showContextMenu(x, y, [
    { icona: 'square-pen', label: 'Rinomina diagramma…', action: rinominaDiagramma },
    { icona: 'copy', label: 'Duplica diagramma', action: duplicaDiagramma },
    '---',
    { icona: 'trash-2', label: 'Elimina diagramma…', danger: true, action: eliminaDiagramma },
  ]);
}

async function rinominaDiagramma() {
  const nome = await chiediTesto({ titolo: 'Rinomina diagramma', etichetta: 'Nome', valore: V.doc.nome });
  if (!nome) return;
  segnaGesto();
  V.doc.nome = nome;
  aggiornaTitolo();
  await salvaOra();
  aggiornaElencoDiagrammi(await archivio.elenca(V.ambito).catch(() => []));
}

async function duplicaDiagramma() {
  V.doc = { ...clona(V.doc), nome: `${V.doc.nome} (copia)` };
  V.idDiagramma = nuovoId('dia');
  V.revisione = 0;
  V.cronologia.azzera();
  aggiornaTitolo();
  await salvaOra();
  aggiornaElencoDiagrammi(await archivio.elenca(V.ambito).catch(() => []));
  aggiornaComandi();
}

async function eliminaDiagramma() {
  const conferma = await chiediTesto({
    titolo: 'Eliminare questo diagramma?',
    sottotitolo: `«${V.doc.nome}» verrà tolto da questo browser. Le tabelle del database non vengono toccate.
Scrivi ELIMINA per confermare.`,
    etichetta: 'Conferma', valore: '',
  });
  if (conferma !== 'ELIMINA') return;
  try {
    await archivio.elimina(V.ambito, V.idDiagramma);
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }
  const restanti = await archivio.elenca(V.ambito).catch(() => []);
  if (restanti.length) { await apriDiagramma(restanti[0].id); aggiornaElencoDiagrammi(restanti); return; }
  V.doc = documentoVuoto(V.contesto.db ? `Schema ${V.contesto.db}` : 'Diagramma');
  V.idDiagramma = nuovoId('dia');
  V.revisione = 0;
  V.cronologia.azzera();
  V.selezione = [];
  ridisegna();
  aggiornaTitolo();
  aggiornaElencoDiagrammi([]);
}

function aggiornaTitolo() {
  const el = $('#uml-nome');
  if (el) el.textContent = V.doc.nome;
}

function mostraStato(stato, dettaglio = '') {
  V.stato = stato;
  const el = $('#uml-stato');
  if (!el) return;
  el.className = `uml-stato ${stato}`;
  el.textContent = { salvato: 'Salvato', modificato: 'Modifiche non salvate', errore: 'Non salvato' }[stato] || stato;
  el.title = dettaglio || '';
  if (stato === 'errore' && dettaglio) showToast(dettaglio, 'warning');
}

function aggiornaComandi() {
  const imposta = (sel, attivo, motivo) => {
    const el = $(sel);
    if (!el) return;
    el.disabled = !attivo;
    if (motivo) el.title = motivo;
  };
  imposta('#uml-undo', V.cronologia.puoAnnullare, V.cronologia.puoAnnullare ? 'Annulla (Ctrl+Z)' : 'Non c’è ancora nulla da annullare');
  imposta('#uml-redo', V.cronologia.puoRipetere, V.cronologia.puoRipetere ? 'Ripeti (Ctrl+Maiusc+Z)' : 'Nulla da ripetere');
  const inModifica = V.modifica;
  imposta('#uml-nota', inModifica, inModifica ? 'Aggiungi una nota' : 'Passa a «Modifica diagramma» per aggiungere note');
  imposta('#uml-entita', inModifica, inModifica ? 'Aggiungi un’entità di progetto' : 'Passa a «Modifica diagramma»');
  imposta('#uml-disponi', Object.keys(V.doc.nodi).length > 0, 'Dispone i nodi non bloccati');
  imposta('#uml-ordina-btn', inModifica && V.selezione.length >= 2,
    V.selezione.length >= 2
      ? 'Allinea o distribuisci gli elementi scelti'
      : 'Scegli almeno due elementi da allineare o distribuire');
  imposta('#uml-rimuovi', V.selezione.length > 0, V.selezione.length ? 'Toglie gli elementi scelti dal diagramma' : 'Scegli prima un elemento');
  imposta('#uml-centra', V.selezione.length > 0, V.selezione.length ? 'Centra sulla selezione' : 'Scegli prima un elemento');
  for (const el of document.querySelectorAll('#uml-mode-esplora, #uml-mode-modifica')) {
    el.setAttribute('aria-pressed', String((el.id === 'uml-mode-modifica') === V.modifica));
  }
}

/* ================================= Menu ================================== */

function menuNodo(x, y, chiavi) {
  const uno = chiavi.length === 1 ? chiavi[0] : null;
  if (uno) {
    const reale = linksCorrenti().find((l) => l.id === uno);
    const logica = !reale && V.doc.logiche.find((l) => l.id === uno);
    if (reale || logica) { menuCollegamento(x, y, reale || logica, !!logica); return; }
  }
  const parti = uno ? leggiChiave(uno) : null;
  const gruppo = gruppoSelezionato();
  showContextMenu(x, y, [
    ...(parti && parti.nome && V.doc.nodi[uno] ? [
      { icona: 'table-2', label: 'Dati dell’oggetto', action: () => apriDati(uno) },
      { icona: 'external-link', label: 'Apri nella griglia', action: () => { selectCollection(parti.db, parti.nome); setView('data'); } },
      { icona: 'columns-2', label: 'Affianca in Split-View', action: () => addOrSplitPane(null, 'right', { db: parti.db, coll: parti.nome, tabId: V.contesto.tabId }) },
      '---',
    ] : []),
    { icona: 'chevrons-up-down', label: 'Espandi / comprimi', action: () => commutaNodo(chiavi, 'compresso') },
    { icona: 'lock', label: 'Blocca / sblocca posizione', action: () => commutaNodo(chiavi, 'bloccato') },
    { icona: 'crosshair', label: 'Centra qui', action: () => V.tavola.centraSu(chiavi) },
    ...(gruppo ? [
      '---',
      { icona: gruppo.compresso ? 'unfold-vertical' : 'fold-vertical', label: gruppo.compresso ? 'Espandi il gruppo' : 'Comprimi il gruppo', action: () => commutaGruppo(gruppo) },
      { icona: 'ungroup', label: 'Sciogli il gruppo', action: () => sciogliGruppo(gruppo) },
    ] : (chiavi.length >= 2 ? [
      '---',
      { icona: 'group', label: 'Raggruppa la selezione…', action: () => raggruppaSelezione(chiavi) },
    ] : [])),
    '---',
    { icona: 'eye-off', label: 'Rimuovi dal diagramma', action: () => rimuoviDalDiagramma(chiavi) },
  ]);
}

function menuCanvas(x, y, punto) {
  showContextMenu(x, y, [
    { icona: 'sticky-note', label: 'Aggiungi nota…', action: () => aggiungiNota(punto) },
    { icona: 'box', label: 'Aggiungi entità di progetto…', action: () => aggiungiEntita(punto) },
    '---',
    { icona: 'layout-grid', label: 'Disponi i nodi', action: () => disponi() },
    { icona: 'maximize', label: 'Adatta alla vista', action: () => V.tavola.adatta() },
  ]);
}

/** Menu di un singolo collegamento: raddrizza, ed elimina se è logico. */
function menuCollegamento(x, y, link, logica) {
  const manuale = V.doc.instradamenti && V.doc.instradamenti[link.id];
  const voci = [
    ...(manuale ? [{ icona: 'spline', label: 'Raddrizza il collegamento', action: () => { segnaGesto(); instradaCollegamento(link.id, []); ridisegna(); } }] : []),
    ...(logica ? [{ icona: 'trash-2', label: 'Elimina la relazione', danger: true, action: () => rimuoviDalDiagramma([link.id]) }] : []),
  ];
  // Un vincolo dello schema senza vertici manuali non ha operazioni: aprire
  // un menu vuoto sarebbe un clic che non dice nulla.
  if (!voci.length) return;
  showContextMenu(x, y, voci);
}

/* =============================== Cablaggio =============================== */

function impostaModalita(modifica) {
  V.modifica = modifica;
  if (V.tavola) {
    V.tavola.modifica = modifica;
    // Uscendo dalla modifica le maniglie dei vertici restano orfane: via.
    if (!modifica) V.tavola.nascondiStrumenti();
  }
  $('#uml-canvas').classList.toggle('in-modifica', modifica);
  aggiornaComandi();
}

export function initUml() {
  const bar = $('#view-uml');
  if (!bar) return;

  $('#uml-mode-esplora')?.addEventListener('click', () => impostaModalita(false));
  $('#uml-mode-modifica')?.addEventListener('click', () => impostaModalita(true));
  $('#uml-undo')?.addEventListener('click', annulla);
  $('#uml-redo')?.addEventListener('click', ripeti);
  $('#uml-disponi')?.addEventListener('click', () => disponi());
  $('#uml-adatta')?.addEventListener('click', () => V.tavola && V.tavola.adatta());
  $('#uml-centra')?.addEventListener('click', () => V.tavola && V.tavola.centraSu(V.selezione));
  $('#uml-zoom-piu')?.addEventListener('click', () => V.tavola && V.tavola.zoomA(V.tavola.scala * 1.2));
  $('#uml-zoom-meno')?.addEventListener('click', () => V.tavola && V.tavola.zoomA(V.tavola.scala / 1.2));
  $('#uml-rimuovi')?.addEventListener('click', () => V.selezione.length && rimuoviDalDiagramma(V.selezione));
  $('#uml-nota')?.addEventListener('click', () => aggiungiNota(centroVista()));
  $('#uml-entita')?.addEventListener('click', () => aggiungiEntita(centroVista()));
  $('#uml-refresh')?.addEventListener('click', () => loadUml(true));
  $('#uml-importa')?.addEventListener('click', importa);
  $('#uml-nuovo')?.addEventListener('click', nuovoDiagramma);
  $('#uml-diagrammi')?.addEventListener('change', (e) => apriDiagramma(e.target.value));

  const aggancio = $('#uml-aggancio');
  aggancio?.addEventListener('click', () => {
    const attivo = aggancio.getAttribute('aria-pressed') !== 'true';
    aggancio.setAttribute('aria-pressed', String(attivo));
    if (V.tavola) V.tavola.aggancio = attivo;
  });

  const ispettoreToggle = $('#uml-ispettore-toggle');
  ispettoreToggle?.addEventListener('click', () => {
    const chiuso = $('#uml-ispettore').classList.toggle('chiuso');
    ispettoreToggle.setAttribute('aria-pressed', String(!chiuso));
  });
  $('#uml-dati-chiudi')?.addEventListener('click', () => { $('#uml-dati').classList.add('hidden'); V.dati = null; });
  $('#uml-dati-prec')?.addEventListener('click', () => { V.dati.skip = Math.max(0, V.dati.skip - RIGHE_PAGINA); leggiPaginaDati(); });
  $('#uml-dati-succ')?.addEventListener('click', () => { V.dati.skip += RIGHE_PAGINA; leggiPaginaDati(); });
  $('#uml-dati-griglia')?.addEventListener('click', () => {
    if (!V.dati) return;
    selectCollection(V.dati.db, V.dati.coll);
    setView('data');
  });
  $('#uml-dati-affianca')?.addEventListener('click', () => {
    if (!V.dati) return;
    addOrSplitPane(null, 'right', { db: V.dati.db, coll: V.dati.coll, tabId: V.contesto.tabId });
  });
  const dettaglio = $('#uml-dati-dettaglio');
  dettaglio?.addEventListener('click', () => {
    dettaglio.setAttribute('aria-pressed', String(dettaglio.getAttribute('aria-pressed') !== 'true'));
    disegnaDettaglioRiga();
  });
  $('#uml-diagramma-menu')?.addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menuDiagramma(r.left, r.bottom + 4);
  });

  for (const [id, formato] of [['#uml-esp-json', 'json'], ['#uml-esp-svg', 'svg'], ['#uml-esp-png', 'png']]) {
    $(id)?.addEventListener('click', () => esporta(formato, $('#uml-esp-selezione')?.checked));
  }

  initToolbarDropdown('#uml-esporta-btn', '#uml-esporta-menu');

  // «Ordina» allinea o distribuisce la selezione: le voci leggono il modo dal
  // proprio attributo, così aggiungere un modo in futuro è una riga di HTML.
  document.querySelectorAll('#uml-ordina-menu [data-allinea]').forEach((voce) => {
    voce.addEventListener('click', () => allineaSelezione(voce.dataset.allinea));
  });
  document.querySelectorAll('#uml-ordina-menu [data-distribuisci]').forEach((voce) => {
    voce.addEventListener('click', () => distribuisciSelezione(voce.dataset.distribuisci));
  });

  initToolbarDropdown('#uml-ordina-btn', '#uml-ordina-menu');

  const cerca = $('#uml-cerca');
  cerca?.addEventListener('input', () => { V.filtroCatalogo = cerca.value; aggiornaCatalogo(); });

  // Catalogo: trascinamento verso il canvas, doppio clic per aggiungere al
  // centro. Ogni gesto di trascinamento ha la sua alternativa a pulsante.
  const lista = $('#uml-catalogo-lista');
  lista?.addEventListener('dragstart', (e) => {
    const voce = e.target.closest('[data-chiave]');
    if (!voce) return;
    e.dataTransfer.setData('application/x-codedb-uml', voce.dataset.chiave);
    e.dataTransfer.effectAllowed = 'copy';
  });
  lista?.addEventListener('dblclick', (e) => {
    const voce = e.target.closest('[data-chiave]');
    if (voce) aggiungiAlDiagramma(voce.dataset.chiave, centroVista());
  });
  lista?.addEventListener('click', (e) => {
    const voce = e.target.closest('[data-chiave]');
    if (!voce || !V.tavola) return;
    const chiave = voce.dataset.chiave;
    if (!V.doc.nodi[chiave]) return;
    V.selezione = [chiave];
    V.tavola.imposta(V.selezione);
    V.tavola.centraSu([chiave]);
    aggiornaIspettore();
    aggiornaCatalogo();
  });

  // La tastiera vale solo quando il fuoco è nella vista UML e non in un campo
  // di testo: intercettare Ctrl+Z mentre si scrive una nota sarebbe peggio che
  // non averla affatto.
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'uml' || !V.tavola) return;
    const dentroTesto = e.target.closest('input, textarea, [contenteditable="true"]');
    if (dentroTesto) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) ripeti(); else annulla();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      ripeti();
    } else if (e.key === 'Delete' && V.selezione.length && V.modifica) {
      e.preventDefault();
      rimuoviDalDiagramma(V.selezione);
    } else if (e.key === 'Escape') {
      V.selezione = [];
      V.tavola.imposta([]);
      aggiornaIspettore();
      aggiornaComandi();
    } else if (V.modifica && V.selezione.length && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const passo = e.shiftKey ? 1 : 10;
      const d = { ArrowLeft: [-passo, 0], ArrowRight: [passo, 0], ArrowUp: [0, -passo], ArrowDown: [0, passo] }[e.key];
      segnaGesto();
      for (const k of V.selezione) {
        const nodo = V.doc.nodi[k] || V.doc.entita.find((x) => x.id === k) || V.doc.note.find((x) => x.id === k);
        if (nodo && !nodo.bloccato) { nodo.x += d[0]; nodo.y += d[1]; }
      }
      ridisegna();
      modificato();
    }
  });

  // Una DDL o un cambio di schema non azzerano il layout: si rilegge lo schema
  // e si riconcilia. Un oggetto sparito resta nel diagramma come non risolto.
  socket.on('schema:changed', (info) => {
    if (state.view !== 'uml' || !V.contesto) return;
    if (info && info.tabId && info.tabId !== V.contesto.tabId) return;
    loadUml(true);
  });

  window.addEventListener('beforeunload', () => { if (V.stato === 'modificato') salvaOra(); });
}

/**
 * Lo stato della vista, per chi deve OSSERVARLO: `test/e2e-uml.js` guarda il
 * documento e il tavolo dopo gesti veri. Non è una via per modificarli — le
 * modifiche passano dai comandi, che sono ciò che va provato.
 */
export function statoUml() {
  return V;
}

function centroVista() {
  if (!V.tavola) return { x: 40, y: 40 };
  const v = V.tavola.vistaCorrente();
  return { x: Math.round(v.x + v.w / 2 - 130), y: Math.round(v.y + v.h / 2 - 60) };
}

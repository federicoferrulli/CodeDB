'use strict';
// Vista UML di sola consultazione. Le risposte asincrone restano legate al contesto di apertura.

import { state } from './state.js';
import { activeTab } from './tabs.js';
import {
  $, emit, esc, showToast, showContextMenu, refreshLucideIcons, displayValueBreve,
  initToolbarDropdown, buildJsonNode,
} from './utils.js';
import { congelaContesto, contestoCorrente } from './coerenza-richieste.js';
import {
  chiaveOggetto, leggiChiave, unisciSchema, collegamenti, disposizione, documentoVuoto,
  validaDocumento, riconcilia, VINCOLO, collegamentiCompressi,
  nascondiglioGruppi, foglieGruppo, posizioneSegnaposto, profonditaGruppi,
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
const diagrammiDatabase = new Map();

/** Stato della vista. Il canvas è uno solo, quindi questo oggetto è uno solo. */
const V = {
  tavola: null,
  contesto: null,      // { tabId, connId, db } del diagramma montato
  schema: null,
  doc: documentoVuoto(),
  idDiagramma: null,
  ambito: null,
  selezione: [],
  dettagli: new Map(), // chiave -> { fields, indexes, relazioni } completi
  dati: null,          // { chiave, db, coll, docs, columns, skip, rigaScelta }
  filtroCatalogo: '',
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
  const modalita = state.coll ? 'tabella' : 'database';
  return { tabId: t ? t.id : null, connId: connId(), db: state.db || null, dbType: state.dbType,
    modalita, coll: modalita === 'tabella' ? state.coll : null };
}

function ancoraQui(congelato) {
  return contestoCorrente({ ...contestoOra(), generazione: V.generazione }, congelato);
}

function semplice() { return V.contesto?.modalita === 'tabella'; }

function chiaveDi(nome, db = state.db) {
  return chiaveOggetto({ conn: connId(), db, nome });
}

/* ================================ Ingresso =============================== */

export function loadUml(force) {
  if (!state.db) {
    messaggio('Apri un database per vedere il diagramma.');
    return;
  }
  const ctx = contestoOra();
  $('#view-uml').classList.toggle('uml-semplice', ctx.modalita === 'tabella');
  const cambiato = !V.contesto || V.contesto.tabId !== ctx.tabId
    || V.contesto.connId !== ctx.connId || V.contesto.db !== ctx.db
    || V.contesto.modalita !== ctx.modalita || V.contesto.coll !== ctx.coll;
  // Tornare sulla stessa vista conserva zoom e selezione.
  if (!cambiato && !force && V.tavola && V.schema) return;
  avvia(ctx, force);
}

async function avvia(ctx, force) {
  const mia = ++V.generazione;
  const congelato = congelaContesto({ ...ctx, generazione: mia });
  messaggio(`<span role="status">Caricamento…</span>${ctx.modalita === 'database'
    ? `<div class="uml-skeleton" aria-hidden="true">${`<div class="uml-skeleton-nodo">
        <div class="skeleton skeleton-block"></div>
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text"></div>
      </div>`.repeat(4)}</div>` : ''}`, true);
  try {
    await caricaJoint();
  } catch {
    if (ancoraQui(congelato)) messaggio('<span class="error">Impossibile caricare il diagramma. Riprova.</span>');
    return;
  }
  if (mia !== V.generazione || !ancoraQui(congelato)) return;

  smonta();
  V.contesto = congelato;
  V.schema = null;
  V.idDiagramma = null;
  V.dettagli.clear();
  V.dati = null;
  $('#uml-dati').classList.add('hidden');
  V.selezione = [];
  V.ambito = archivio.ambitoDi({ utente: utenteCorrente(), conn: ctx.connId, db: ctx.db });

  const schema = await leggiSchema(congelato, force);
  if (!schema || mia !== V.generazione || !ancoraQui(congelato)) return;
  V.schema = schema;

  await completaSchema({ ridisegno: false });
  if (mia !== V.generazione || !ancoraQui(congelato)) return;
  if (semplice()) preparaTabella();
  else await ripristinaDiagramma(congelato);
  if (mia !== V.generazione || !ancoraQui(congelato)) return;
  monta();
}

/** La tabella selezionata e le relazioni dirette, in entrata e in uscita. */
function preparaTabella() {
  const riferimento = chiaveDi(V.contesto.coll);
  const chiavi = new Set([riferimento]);
  for (const l of collegamenti(V.schema, { conn: connId(), db: V.contesto.db })) {
    if (l.da === riferimento || l.a === riferimento) { chiavi.add(l.da); chiavi.add(l.a); }
  }
  V.doc = documentoVuoto(V.contesto.coll);
  for (const k of chiavi) V.doc.nodi[k] = { x: 0, y: 0, bloccato: false, compresso: false };
  V.selezione = [riferimento];
  disponi();
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
  try { salvati = await archivio.elenca(V.ambito); }
  catch (err) { if (ancoraQui(congelato)) showToast(err.message, 'warning'); }
  if (!ancoraQui(congelato)) return;
  const id = diagrammiDatabase.get(V.ambito);
  const record = id ? await archivio.leggi(V.ambito, id).catch(() => null) : null;
  if (!ancoraQui(congelato)) return;
  if (record) {
    const { doc, avvisi } = validaDocumento(record.doc);
    V.doc = doc;
    V.idDiagramma = record.id;
    if (avvisi.length) showToast(avvisi[0], 'warning');
  } else {
    V.doc = documentoVuoto(`Schema ${congelato.db}`);
    V.idDiagramma = null;
    for (const c of V.schema.collections || []) {
      V.doc.nodi[chiaveDi(c.name)] = { x: 0, y: 0, bloccato: false, compresso: true };
    }
    disponi();
  }
  aggiornaElencoDiagrammi(salvati);
}

/* ============================= Costruzione ================================ */

function collezione(nome, db = V.contesto.db) {
  if (db !== V.contesto.db) return null;
  return (V.schema.collections || []).find((c) => c.name === nome) || null;
}

/** Campi da mostrare su un nodo: i completi se già letti, altrimenti quelli dello schema. */
function campiDi(chiave) {
  const parti = leggiChiave(chiave);
  const dettaglio = V.dettagli.get(chiave);
  if (dettaglio && dettaglio.fields) return dettaglio.fields;
  const c = parti ? collezione(parti.nome, parti.db) : null;
  return (c && c.fields) || [];
}

function linksCorrenti() {
  const riferimento = semplice() ? chiaveDi(V.contesto.coll) : null;
  return collegamenti(V.schema, { conn: connId(), db: V.contesto.db })
    .filter((l) => V.doc.nodi[l.da] && V.doc.nodi[l.a]
      && (!riferimento || l.da === riferimento || l.a === riferimento));
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
  const c = collezione(parti.nome, parti.db);
  return {
    chiave,
    titolo: parti.nome,
    sottotitolo: parti.db !== V.contesto.db ? `${parti.db} · altro schema`
      : (insiemeIrrisolti?.has(chiave) ? 'non risolto' : parti.db),
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
    nodi, links: reali, note, entita, logiche, irrisolti: insiemeIrrisolti, gruppi,
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
  $('#uml-nome').textContent = V.doc.nome;
  canvas.setAttribute('aria-busy', 'false');
  canvas.innerHTML = '';
  canvas.classList.remove('uml-vuoto');
  V.tavola = new Tavola(canvas, {
    onSelezione: (chiavi) => { V.selezione = chiavi; aggiornaIspettore(); aggiornaComandi(); aggiornaCatalogo(); },
    onApriDati: (chiave) => apriDati(chiave),
    onZoom: (s) => { const el = $('#uml-zoom-valore'); if (el) el.textContent = `${Math.round(s * 100)}%`; },
    onMenu: (x, y, chiavi) => menuNodo(x, y, chiavi),
    onMenuVuoto: (x, y) => menuCanvas(x, y),
    onVista: () => { /* la minimappa si aggiorna da sé */ },
  });
  V.tavola.modifica = false;
  V.tavola.monta(modelloDisegno());
  V.tavola.imposta(V.selezione);
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
  if (V.tavola) { V.tavola.distruggi(); V.tavola = null; }
}

function messaggio(html, caricamento = false) {
  const canvas = $('#uml-canvas');
  if (!canvas) return;
  smonta();
  canvas.setAttribute('aria-busy', String(caricamento));
  canvas.classList.add('uml-vuoto');
  canvas.innerHTML = `<div class="uml-msg">${html}</div>`;
}

/* =============================== Comandi ================================== */

function disponi() {
  const chiavi = Object.keys(V.doc.nodi);
  const bloccati = new Set(chiavi.filter((k) => V.doc.nodi[k].bloccato));
  const altezze = new Map(chiavi.map((k) => {
    const campi = campiDi(k);
    const visti = campiVisibili(campi.length, V.doc.nodi[k].compresso !== false);
    return [k, altezzaNodo(visti, campi.length > visti)];
  }));
  const posizioni = disposizione(chiavi, linksCorrenti(), { bloccati, altezze });
  for (const [k, p] of posizioni) Object.assign(V.doc.nodi[k], p);
}

function commutaNodo(chiavi) {
  // Placchette, archi e segnaposto non hanno l'interruttore: senza chiavi
  // commutabili non c'è gesto, e di certo non una voce di storia sul nulla.
  const toglici = chiavi.filter((k) => V.doc.nodi[k] || V.doc.entita.some((e) => e.id === k));
  if (!toglici.length) return;
  for (const k of toglici) {
    const nodo = V.doc.nodi[k] || V.doc.entita.find((e) => e.id === k);
    nodo.compresso = !nodo.compresso;
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
}

function commutaGruppo(gruppo) {
  gruppo.compresso = !gruppo.compresso;
  V.selezione = gruppo.compresso ? [gruppo.id] : [...gruppo.membri];
  ridisegna();
  V.tavola.imposta(V.selezione);
}

/* =============================== Catalogo ================================= */

function aggiornaCatalogo() {
  const el = $('#uml-catalogo-lista');
  if (!el || !V.schema) return;
  const filtro = V.filtroCatalogo.trim().toLowerCase();
  const scelte = new Set(V.selezione);
  const voci = (V.schema.collections || []).filter((c) => !semplice() || V.doc.nodi[chiaveDi(c.name)]).map((c) => {
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
      data-chiave="${esc(chiave)}" title="${esc(c.name)} — ${dentro ? 'centra sul diagramma' : 'non presente nel diagramma salvato'}">
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
  const fuori = (V.schema.collections || [])
    .filter((c) => !V.doc.nodi[chiaveDi(c.name)]).length;
  const nota = !semplice() && fuori ? ` · ${fuori} non sul diagramma` : '';
  if (!page || page.complete) {
    piede.innerHTML = semplice()
      ? `${esc(V.contesto.coll)} · relazioni dirette`
      : `${n} oggetti · tutti i metadati letti${esc(nota)}`;
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
async function completaSchema({ maxGiri = 40, ridisegno = true } = {}) {
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
      if (ridisegno) { aggiornaCatalogo(); disegnaPiedeCatalogo(`Caricamento… ${V.schema.collections.length} oggetti`); }
      // Un cursore che non avanza è un contratto rotto, non una pagina vuota:
      // fermarsi e dirlo è meglio che ripetere la stessa richiesta.
      if (!avanzato(page, V.schema.schemaPage)) break;
    }
    if (ridisegno && ancoraQui(congelato)) {
      if (semplice()) preparaTabella();
      else if (!V.idDiagramma) {
        for (const c of V.schema.collections || []) {
          V.doc.nodi[chiaveDi(c.name)] ||= { x: 0, y: 0, bloccato: false, compresso: true };
        }
        disponi();
      }
      ridisegna();
      disegnaPiedeCatalogo();
    }
  } catch (err) {
    if (!ancoraQui(congelato)) return;
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
  if (link) { el.innerHTML = schedaCollegamento(link); collegaIspettore(el, chiave); return; }
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
  const c = collezione(parti.nome, parti.db);
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
`;
}

function schedaEntita(ent) {
  return `
    <h4 class="uml-isp-titolo">${esc(ent.nome)}</h4>
    <p class="uml-isp-sotto">Entità di progetto · esiste solo nel diagramma</p>
    <h5 class="uml-isp-sez">Campi</h5>
    <ul class="uml-isp-elenco mono">${ent.campi.map((c) => `<li>${esc(c.nome)} <span class="dim">${esc(c.tipo)}</span></li>`).join('') || '<li class="dim">Nessuno.</li>'}</ul>
`;
}

function schedaNota(nota) {
  return `
    <h4 class="uml-isp-titolo">Nota</h4>
    <p class="uml-isp-sotto">${esc(displayValueBreve(nota.testo, 300).text ?? '')}</p>
`;
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

function azioneIspettore(azione, chiave) {
  const gruppo = V.doc.gruppi.find((g) => g.id === chiave);
  if (azione === 'gruppo-comprimi' && gruppo) { commutaGruppo(gruppo); return; }
  const parti = leggiChiave(chiave);
  if (azione === 'dati') { apriDati(chiave); return; }
  if (azione === 'griglia' && parti) { selectCollection(parti.db, parti.nome); setView('data'); return; }
  if (azione === 'espandi') commutaNodo([chiave]);
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

/* ============================== Esportazione ============================== */

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

/* ============================== Diagrammi ================================= */

function aggiornaElencoDiagrammi(lista) {
  const sel = $('#uml-diagrammi');
  const elenco = [{ id: '', nome: `Schema ${V.contesto.db}` }, ...lista];
  sel.innerHTML = elenco.map((d) => `<option value="${esc(d.id)}"${d.id === (V.idDiagramma || '') ? ' selected' : ''}>${esc(d.nome)}</option>`).join('');
}

function apriDiagramma(id) {
  diagrammiDatabase.set(V.ambito, id);
  avvia(contestoOra(), false);
}

function aggiornaComandi() {
  $('#view-uml').classList.toggle('uml-semplice', semplice());
  $('#uml-centra').disabled = !V.selezione.length;
}

/* ================================= Menu ================================== */

function menuNodo(x, y, chiavi) {
  const uno = chiavi.length === 1 ? chiavi[0] : null;
  const parti = uno ? leggiChiave(uno) : null;
  const gruppo = V.doc.gruppi.find((g) => g.id === uno);
  showContextMenu(x, y, [
    ...(parti && V.doc.nodi[uno] ? [
      { icona: 'table-2', label: 'Dati dell’oggetto', action: () => apriDati(uno) },
      { icona: 'external-link', label: 'Apri nella griglia', action: () => { selectCollection(parti.db, parti.nome); setView('data'); } },
      { icona: 'columns-2', label: 'Affianca in Split-View', action: () => addOrSplitPane(null, 'right', { db: parti.db, coll: parti.nome, tabId: V.contesto.tabId }) },
    ] : []),
    ...(chiavi.some((k) => V.doc.nodi[k]) ? [
      { icona: 'chevrons-up-down', label: 'Espandi / comprimi', action: () => commutaNodo(chiavi) },
    ] : []),
    ...(gruppo ? [
      { icona: 'unfold-vertical', label: gruppo.compresso ? 'Espandi il gruppo' : 'Comprimi il gruppo', action: () => commutaGruppo(gruppo) },
    ] : []),
    { icona: 'crosshair', label: 'Centra qui', action: () => V.tavola.centraSu(chiavi) },
  ]);
}

function menuCanvas(x, y) {
  showContextMenu(x, y, [
    { icona: 'maximize', label: 'Adatta alla vista', action: () => V.tavola.adatta() },
  ]);
}

/* =============================== Cablaggio =============================== */

export function initUml() {
  const bar = $('#view-uml');
  if (!bar) return;
  $('#uml-adatta')?.addEventListener('click', () => V.tavola && V.tavola.adatta());
  $('#uml-centra')?.addEventListener('click', () => V.tavola && V.tavola.centraSu(V.selezione));
  $('#uml-zoom-piu')?.addEventListener('click', () => V.tavola && V.tavola.zoomA(V.tavola.scala * 1.2));
  $('#uml-zoom-meno')?.addEventListener('click', () => V.tavola && V.tavola.zoomA(V.tavola.scala / 1.2));
  $('#uml-refresh')?.addEventListener('click', () => loadUml(true));
  $('#uml-diagrammi')?.addEventListener('change', (e) => apriDiagramma(e.target.value));

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
  for (const [id, formato] of [['#uml-esp-json', 'json'], ['#uml-esp-svg', 'svg'], ['#uml-esp-png', 'png']]) {
    $(id)?.addEventListener('click', () => esporta(formato, $('#uml-esp-selezione')?.checked));
  }

  initToolbarDropdown('#uml-esporta-btn', '#uml-esporta-menu');

  const cerca = $('#uml-cerca');
  cerca?.addEventListener('input', () => { V.filtroCatalogo = cerca.value; aggiornaCatalogo(); });

  const lista = $('#uml-catalogo-lista');
  lista?.addEventListener('click', (e) => {
    const voce = e.target.closest('[data-chiave]');
    if (!voce || !V.tavola) return;
    const chiave = voce.dataset.chiave;
    if (!V.doc.nodi[chiave]) return;
    V.selezione = [chiave];
    V.tavola.imposta(V.selezione);
    V.tavola.centraSu([chiave]);
    sincronizzaPannelli();
  });

  document.addEventListener('keydown', (e) => {
    if (state.view !== 'uml' || !V.tavola || e.key !== 'Escape') return;
    if (e.target.closest('input, select, textarea, [role="combobox"], [role="option"], [role="checkbox"], [contenteditable="true"]')) return;
    V.selezione = [];
    V.tavola.imposta([]);
    sincronizzaPannelli();
  });

  // Le modifiche fatte nelle altre viste aggiornano lo schema osservato.
  socket.on('schema:changed', (info) => {
    if (state.view !== 'uml' || !V.contesto) return;
    if (info && info.tabId && info.tabId !== V.contesto.tabId) return;
    loadUml(true);
  });

}

/** Stato osservabile dai test della vista. */
export function statoUml() {
  return V;
}

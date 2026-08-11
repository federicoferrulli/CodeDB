'use strict';

/**
 * Temi: applicazione, persistenza ed editor.
 *
 * Diviso in due, come `charts.js`/`chart-option.js`: qui c'è tutto ciò che
 * tocca il DOM e `localStorage`, mentre il calcolo dei colori sta nel modulo
 * foglia `theme-colori.js`, provato in Node. La ragione è la stessa: un tema
 * mal derivato non lancia errori, si applica e basta.
 *
 * Tre cose non ovvie, tutte imparate dal fatto che il tema è la PRIMA cosa che
 * si vede:
 *
 *  1. Il tema viene applicato da uno script in linea nell'`<head>`, non da
 *     qui. Questo modulo è ESM e quindi differito: quando venisse eseguito, la
 *     pagina è già stata dipinta almeno una volta, e su un tema chiaro si
 *     vedrebbe un lampo nero a ogni avvio. Lo script in linea (index.html)
 *     scrive `data-theme` prima del primo paint; questo modulo si limita a
 *     riprendere lo stesso stato e a poterlo cambiare a caldo. Le due copie
 *     devono restare d'accordo sui nomi delle chiavi: sono le costanti qui
 *     sotto, ripetute in index.html con un commento che rimanda a questo file.
 *
 *  2. "Automatico" non è un terzo tema ma un rinvio al sistema operativo, e va
 *     seguito nel tempo: chi ha il passaggio automatico chiaro/scuro al
 *     tramonto si aspetta che l'applicazione aperta lo segua senza riavviarla.
 *     Da qui il `matchMedia(...).addEventListener`.
 *
 *  3. Un tema personalizzato è un insieme di SCARTI su una base, iniettato
 *     come regola CSS. Il suo `id` finisce dentro un selettore, quindi è
 *     validato da `validaTema()` prima di essere scritto: un tema si importa
 *     da file, cioè è un dato che arriva da fuori.
 */

import { $, esc, toast, chiaveStorage, conCaricamento } from './utils.js';
import {
  CAMPI, TEMI_BASE, eBase, scelteIniziali, derivaTokens, diagnostica,
  validaTema, cssDelTema, nomeFile, leggiHex, scriviHex, SOGLIA_TESTO,
} from './theme-colori.js';

/* Ripetute nello script in linea di index.html: cambiarle qui e non là
   significa un lampo del tema sbagliato a ogni avvio. */
const CHIAVE_TEMA = chiaveStorage('tema');
const CHIAVE_TEMI = chiaveStorage('temi');
const ID_STILE = 'codedb-tema-custom';

let inModifica = null;   // tema in corso di modifica nell'editor (copia di lavoro)
let mediaScuro = null;

/* ==========================================================================
   Persistenza
   ========================================================================== */

/** I temi dell'utente, come mappa id → tema. Tollera storage illeggibile. */
export function temiSalvati() {
  try {
    const grezzo = JSON.parse(localStorage.getItem(CHIAVE_TEMI) || '{}');
    const out = {};
    for (const [id, t] of Object.entries(grezzo)) {
      const v = validaTema({ ...t, id });
      // Un tema corrotto viene SALTATO, non fa fallire il caricamento degli
      // altri né l'avvio dell'applicazione.
      if (v.ok) out[id] = v.tema;
    }
    return out;
  } catch { return {}; }
}

function scriviTemi(temi) {
  try {
    localStorage.setItem(CHIAVE_TEMI, JSON.stringify(temi));
    return true;
  } catch {
    toast('Spazio esaurito: il tema non è stato salvato.', true);
    return false;
  }
}

/** L'id del tema scelto ('auto' | 'dark' | 'light' | id personalizzato). */
export function temaCorrente() {
  try { return localStorage.getItem(CHIAVE_TEMA) || 'auto'; } catch { return 'auto'; }
}

/* ==========================================================================
   Applicazione
   ========================================================================== */

function sistemaPreferisceScuro() {
  return !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Scrive nel documento il tema `id`, senza toccare la preferenza salvata. */
export function applicaTema(id) {
  const radice = document.documentElement;
  const temi = temiSalvati();
  const custom = temi[id];

  // La BASE decide il verso di tutto (velature, ombre, colori di codice):
  // `data-theme` resta sempre 'dark' o 'light', anche per un tema dell'utente.
  let base;
  if (custom) base = custom.base;
  else if (id === 'light') base = 'light';
  else if (id === 'dark') base = 'dark';
  else base = sistemaPreferisceScuro() ? 'dark' : 'light';

  radice.setAttribute('data-theme', base);

  if (custom) {
    radice.setAttribute('data-theme-custom', custom.id);
    iniettaCss(cssDelTema(custom));
  } else {
    radice.removeAttribute('data-theme-custom');
    iniettaCss('');
  }

  // I moduli che disegnano su canvas (grafici, grafo 3D, mappe) non ereditano
  // nulla dal CSS: si ridisegnano quando sentono questo evento.
  document.dispatchEvent(new CustomEvent('codedb:tema', { detail: { id, base } }));
}

function iniettaCss(css) {
  let el = document.getElementById(ID_STILE);
  if (!css) { if (el) el.textContent = ''; return; }
  if (!el) {
    el = document.createElement('style');
    el.id = ID_STILE;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

/** Applica `id` e lo ricorda. */
export function scegliTema(id) {
  try { localStorage.setItem(CHIAVE_TEMA, id); } catch { /* si applica comunque */ }
  applicaTema(id);
}

/* ==========================================================================
   Avvio
   ========================================================================== */

export function initTheme() {
  // Lo script in linea ha già dipinto il tema giusto: qui si riallinea solo il
  // caso del tema personalizzato, il cui CSS quello script non conosce.
  applicaTema(temaCorrente());

  // "Automatico" segue il sistema anche a finestra aperta.
  if (window.matchMedia) {
    mediaScuro = window.matchMedia('(prefers-color-scheme: dark)');
    const seSistemaCambia = () => { if (temaCorrente() === 'auto') applicaTema('auto'); };
    if (mediaScuro.addEventListener) mediaScuro.addEventListener('change', seSistemaCambia);
    else if (mediaScuro.addListener) mediaScuro.addListener(seSistemaCambia);   // Safari vecchi
  }

  const btn = $('#btn-theme');
  if (btn) btn.addEventListener('click', apriModale);

  const chiudi = $('#btn-close-theme-modal');
  if (chiudi) chiudi.addEventListener('click', chiudiModale);

  const overlay = $('#modal-theme');
  if (overlay) {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) chiudiModale(); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) chiudiModale();
  });

  const nuovo = $('#btn-tema-nuovo');
  if (nuovo) nuovo.addEventListener('click', () => apriEditor(null));

  const importa = $('#btn-tema-importa');
  const file = $('#tema-import-file');
  if (importa && file) {
    importa.addEventListener('click', () => file.click());
    file.addEventListener('change', () => importaDaFile(file));
  }

  // Elenco dei temi: un solo gestore delegato, il corpo si riscrive a ogni
  // apertura e riattaccare i gestori ogni volta è il modo classico di
  // accumularne dieci copie.
  const elenco = $('#theme-list');
  if (elenco) elenco.addEventListener('click', suClicElenco);

  const pannello = $('#theme-editor');
  if (pannello) {
    pannello.addEventListener('input', suModificaEditor);
    pannello.addEventListener('change', suModificaEditor);
    pannello.addEventListener('click', suClicEditor);
  }
}

/* ==========================================================================
   Modale: elenco dei temi
   ========================================================================== */

function apriModale() {
  const m = $('#modal-theme');
  if (!m) return;
  chiudiEditor();
  disegnaElenco();
  m.classList.remove('hidden');
}

function chiudiModale() {
  const m = $('#modal-theme');
  if (!m) return;
  m.classList.add('hidden');
  // Uscire senza salvare rimette il tema che era in uso: l'anteprima dal vivo
  // ha cambiato l'aspetto dell'applicazione, e lasciarcela sarebbe una
  // modifica mai confermata.
  if (inModifica) { inModifica = null; applicaTema(temaCorrente()); }
}

function anteprimaTema(tema) {
  // Il quadratino dell'elenco mostra i colori VERI del tema, derivati come
  // farebbe l'applicazione: un campione dipinto a mano mentirebbe.
  const t = derivaTokens(tema.scelte, tema.base);
  return `<span class="tema-campione" style="background:${t['--bg']};border-color:${t['--border-2'] || 'transparent'}">
      <i style="background:${t['--accent']}"></i>
      <i style="background:${t['--success']}"></i>
      <i style="background:${t['--warning']}"></i>
      <i style="background:${t['--danger']}"></i>
    </span>`;
}

function campioneBase(base) {
  const t = derivaTokens(scelteIniziali(base), base);
  return `<span class="tema-campione" style="background:${t['--bg']}">
      <i style="background:${t['--accent']}"></i>
      <i style="background:${t['--success']}"></i>
      <i style="background:${t['--warning']}"></i>
      <i style="background:${t['--danger']}"></i>
    </span>`;
}

function disegnaElenco() {
  const el = $('#theme-list');
  if (!el) return;
  const scelto = temaCorrente();
  const temi = temiSalvati();

  const carta = (id, nome, nota, campione, azioni) => `
    <div class="tema-card ${id === scelto ? 'attiva' : ''}" data-tema="${esc(id)}" role="button" tabindex="0">
      ${campione}
      <div class="tema-card-testo">
        <strong>${esc(nome)}</strong>
        <small>${esc(nota)}</small>
      </div>
      <div class="tema-card-azioni">${azioni}</div>
    </div>`;

  const base = TEMI_BASE.map((t) => {
    const nota = t.id === 'auto'
      ? `Segue il sistema (ora: ${sistemaPreferisceScuro() ? 'scuro' : 'chiaro'})`
      : 'Tema predefinito';
    const campione = t.id === 'auto'
      ? campioneBase(sistemaPreferisceScuro() ? 'dark' : 'light')
      : campioneBase(t.base);
    // Da un predefinito si può PARTIRE: è il modo più naturale di farsi un
    // tema, e senza questo bottone bisognerebbe ricostruirlo da zero.
    return carta(t.id, t.nome, nota, campione,
      t.id === 'auto' ? '' : `<button type="button" class="btn-icona" data-azione="duplica" data-id="${esc(t.id)}" title="Crea un tema partendo da questo">⧉</button>`);
  }).join('');

  const miei = Object.values(temi).map((t) => carta(
    t.id, t.nome, `Personalizzato · base ${t.base === 'light' ? 'chiara' : 'scura'}`,
    anteprimaTema(t),
    `<button type="button" class="btn-icona" data-azione="modifica" data-id="${esc(t.id)}" title="Modifica">✎</button>
     <button type="button" class="btn-icona" data-azione="duplica" data-id="${esc(t.id)}" title="Duplica">⧉</button>
     <button type="button" class="btn-icona" data-azione="esporta" data-id="${esc(t.id)}" title="Esporta in un file">⭳</button>
     <button type="button" class="btn-icona pericolo" data-azione="elimina" data-id="${esc(t.id)}" title="Elimina">🗑</button>`,
  )).join('');

  el.innerHTML = base
    + (miei ? `<div class="tema-sezione">I tuoi temi</div>${miei}` : '');
}

function suClicElenco(e) {
  const azione = e.target.closest('[data-azione]');
  if (azione) {
    e.stopPropagation();
    const id = azione.dataset.id;
    if (azione.dataset.azione === 'modifica') apriEditor(id);
    if (azione.dataset.azione === 'duplica') duplica(id);
    if (azione.dataset.azione === 'esporta') esporta(id);
    if (azione.dataset.azione === 'elimina') elimina(id);
    return;
  }
  const carta = e.target.closest('[data-tema]');
  if (!carta) return;
  scegliTema(carta.dataset.tema);
  disegnaElenco();
}

/* ==========================================================================
   Azioni sui temi
   ========================================================================== */

function idLibero(radice) {
  const temi = temiSalvati();
  let id = radice, n = 2;
  while (temi[id] || eBase(id)) { id = `${radice}-${n}`; n++; }
  return id;
}

function duplica(id) {
  const temi = temiSalvati();
  const partenza = temi[id];
  const base = partenza ? partenza.base : (id === 'light' ? 'light' : 'dark');
  const scelte = partenza ? { ...partenza.scelte } : scelteIniziali(base);
  const nome = partenza ? `${partenza.nome} (copia)` : `Tema ${base === 'light' ? 'chiaro' : 'scuro'} mio`;
  apriEditor(null, { id: idLibero('tema'), nome, base, scelte });
}

function elimina(id) {
  const temi = temiSalvati();
  if (!temi[id]) return;
  if (!window.confirm(`Eliminare il tema "${temi[id].nome}"? L'operazione non è reversibile.`)) return;
  delete temi[id];
  scriviTemi(temi);
  // Se era quello in uso si torna all'automatico, altrimenti l'applicazione
  // resterebbe con i colori di un tema che non esiste più.
  if (temaCorrente() === id) scegliTema('auto');
  chiudiEditor();
  disegnaElenco();
  toast('Tema eliminato.');
}

function esporta(id) {
  const tema = temiSalvati()[id];
  if (!tema) return;
  const blob = new Blob([JSON.stringify({ codedb: 'tema', versione: 1, ...tema }, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nomeFile(tema);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importaDaFile(input) {
  const file = input.files && input.files[0];
  input.value = '';                                  // permette di reimportare lo stesso file
  if (!file) return;
  const lettore = new FileReader();
  lettore.onload = () => {
    let grezzo;
    try { grezzo = JSON.parse(String(lettore.result)); } catch {
      toast('Il file non è un JSON valido.', true);
      return;
    }
    const temi = temiSalvati();
    // Un id già preso non sovrascrive in silenzio il tema esistente.
    const proposto = String(grezzo && grezzo.id || 'importato');
    const v = validaTema({ ...grezzo, id: temi[proposto] || eBase(proposto) ? idLibero(proposto) : proposto });
    if (!v.ok) { toast(`Tema non importabile — ${v.errore}`, true); return; }
    apriEditor(null, v.tema);
    toast('Tema caricato: controlla i colori e salva.');
  };
  lettore.onerror = () => toast('Impossibile leggere il file.', true);
  lettore.readAsText(file);
}

/* ==========================================================================
   Editor
   ========================================================================== */

function apriEditor(id, bozza) {
  const temi = temiSalvati();
  if (bozza) inModifica = { ...bozza, scelte: { ...bozza.scelte } };
  else if (id && temi[id]) inModifica = { ...temi[id], scelte: { ...temi[id].scelte } };
  else {
    const base = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    inModifica = { id: idLibero('tema'), nome: 'Tema mio', base, scelte: scelteIniziali(base) };
  }
  disegnaEditor();
  $('#theme-editor').classList.remove('hidden');
  anteprima(true);   // apertura: nessuna raffica da limitare
}

function chiudiEditor() {
  const p = $('#theme-editor');
  if (p) p.classList.add('hidden');
  // Prima di dimenticare il tema in modifica: un'anteprima in coda scatterebbe
  // DOPO il ripristino e rimetterebbe i colori appena annullati.
  fermaAnteprima();
  inModifica = null;
}

function disegnaEditor() {
  const p = $('#theme-editor');
  if (!p || !inModifica) return;
  const t = inModifica;

  const campi = CAMPI.map((c) => `
    <label class="tema-campo">
      <span class="tema-campo-nome">${esc(c.etichetta)}</span>
      <span class="tema-campo-desc">${esc(c.descrizione)}</span>
      <span class="tema-campo-input">
        <input type="color" data-scelta="${c.chiave}" value="${esc(t.scelte[c.chiave])}" />
        <input type="text" class="tema-campo-hex" data-scelta-hex="${c.chiave}"
               value="${esc(t.scelte[c.chiave])}" spellcheck="false" maxlength="7" />
      </span>
    </label>`).join('');

  p.innerHTML = `
    <div class="tema-editor-head">
      <h3>${esc(t.nome)}</h3>
      <p class="modal-hint">I colori che non scegli qui restano quelli del tema di base: un tema
        personalizzato è un insieme di scarti, non una palette da riempire.</p>
    </div>

    <div class="tema-editor-riga">
      <label class="tema-campo tema-campo-largo">
        <span class="tema-campo-nome">Nome</span>
        <input type="text" id="tema-nome" value="${esc(t.nome)}" maxlength="60" />
      </label>
      <label class="tema-campo">
        <span class="tema-campo-nome">Base</span>
        <span class="tema-campo-desc">Decide il verso di velature, ombre e colori del codice</span>
        <select id="tema-base">
          <option value="dark" ${t.base === 'dark' ? 'selected' : ''}>Scura</option>
          <option value="light" ${t.base === 'light' ? 'selected' : ''}>Chiara</option>
        </select>
      </label>
    </div>

    <div class="tema-campi">${campi}</div>

    <div id="tema-avvisi" class="tema-avvisi"></div>

    <div class="tema-editor-azioni">
      <button type="button" class="btn btn-primary" data-editor="salva">Salva e applica</button>
      <button type="button" class="btn btn-secondary" data-editor="ripristina">Ripristina i colori della base</button>
      <button type="button" class="btn btn-secondary" data-editor="annulla">Annulla</button>
    </div>`;

  aggiornaAvvisi();
}

/** Applica al documento il tema in modifica, senza salvarlo. */
/*
 * Costo dell'anteprima, misurato invece che immaginato.
 *
 * Riscrivere una custom property su `:root` invalida lo stile calcolato di
 * OGNI elemento che potrebbe ereditarla, cioè dell'intero documento. Il
 * calcolo dei token e la scrittura del foglio sono gratis (75 token costano
 * quanto un fotogramma vuoto, e il gestore sta sotto il mezzo millisecondo):
 * quello che si paga è il RICALCOLO, e scala con il DOM dietro la modale.
 * Misurato in Chrome con GPU, trascinando il colore:
 *
 *     celle nella pagina      0     500    2000    6000   12000
 *     fotogrammi al secondo  60      60      60      18     8,6
 *
 * A schermo vuoto non si vede nulla — ed è la ragione per cui il difetto non
 * era emerso dal primo collaudo. Con una griglia dati aperta sì: 200 righe per
 * 30 colonne fanno esattamente 6000 celle, e la virtualizzazione non aiuta
 * perché sotto le 200 righe la griglia le disegna tutte.
 *
 * Quindi l'anteprima si LIMITA nel tempo invece di seguire ogni evento del
 * selettore di colore (che ne manda uno per movimento del mouse). Tre
 * proprietà, tutte necessarie:
 *   - il primo evento si applica SUBITO, altrimenti trascinare sembrerebbe non
 *     fare niente per un decimo di secondo;
 *   - durante il trascinamento si applica al più una volta ogni
 *     `ANTEPRIMA_MS`, che è quanto basta perché l'occhio segua una tinta che
 *     cambia su tutta l'interfaccia;
 *   - l'ULTIMO valore si applica sempre (coda), altrimenti l'anteprima
 *     resterebbe ferma su un colore intermedio e diverso da quello scelto —
 *     che poi è esattamente il colore che verrebbe salvato.
 */
const ANTEPRIMA_MS = 120;
let timerAnteprima = null;
let anteprimaArretrata = false;

function applicaAnteprima() {
  if (!inModifica) return;
  document.documentElement.setAttribute('data-theme', inModifica.base);
  document.documentElement.setAttribute('data-theme-custom', inModifica.id);
  iniettaCss(cssDelTema(inModifica));
  document.dispatchEvent(new CustomEvent('codedb:tema',
    { detail: { id: inModifica.id, base: inModifica.base } }));
}

/** `subito`: per i gesti singoli (apertura, cambio base, ripristino), dove non
 *  c'è alcuna raffica da limitare e aspettare sarebbe solo latenza. */
function anteprima(subito = false) {
  if (!inModifica) return;
  if (subito) {
    clearTimeout(timerAnteprima);
    timerAnteprima = null;
    anteprimaArretrata = false;
    applicaAnteprima();
    return;
  }
  if (timerAnteprima) { anteprimaArretrata = true; return; }
  applicaAnteprima();
  timerAnteprima = setTimeout(() => {
    timerAnteprima = null;
    if (!anteprimaArretrata) return;
    anteprimaArretrata = false;
    anteprima();                       // la coda: applica l'ultimo valore
  }, ANTEPRIMA_MS);
}

/** Ferma la limitazione: alla chiusura dell'editor non deve restare in volo un
 *  timer che ridipinge il tema in anteprima dopo che è stato ripristinato. */
function fermaAnteprima() {
  clearTimeout(timerAnteprima);
  timerAnteprima = null;
  anteprimaArretrata = false;
}

function aggiornaAvvisi() {
  const box = $('#tema-avvisi');
  if (!box || !inModifica) return;
  const avvisi = diagnostica(inModifica.scelte);
  if (!avvisi.length) {
    box.className = 'tema-avvisi ok';
    box.innerHTML = '✓ Tutti i colori scelti sono leggibili sullo sfondo.';
    return;
  }
  box.className = 'tema-avvisi attenzione';
  box.innerHTML = `<strong>Da controllare</strong><ul>${
    avvisi.map((a) => `<li>${esc(a.messaggio)}</li>`).join('')}</ul>`;
}

function suModificaEditor(e) {
  if (!inModifica) return;
  const el = e.target;

  if (el.id === 'tema-nome') { inModifica.nome = el.value; return; }

  if (el.id === 'tema-base') {
    // Cambiare base senza toccare i colori darebbe un ibrido illeggibile
    // (testo chiaro su sfondo chiaro): si riparte dalla palette di quella base.
    inModifica.base = el.value === 'light' ? 'light' : 'dark';
    inModifica.scelte = scelteIniziali(inModifica.base);
    disegnaEditor();
    anteprima(true);   // cambio base: un gesto solo
    return;
  }

  const chiave = el.dataset.scelta || el.dataset.sceltaHex;
  if (!chiave) return;
  const rgb = leggiHex(el.value);
  // La casella di testo accetta di essere scritta a metà (`#6f`): si aspetta
  // che diventi un colore valido invece di rifiutare ogni battuta.
  if (!rgb) return;
  const hex = scriviHex(rgb);
  inModifica.scelte[chiave] = hex;

  // Tiene allineate le due caselle della stessa riga senza ridisegnare tutto,
  // che farebbe perdere il fuoco a ogni carattere digitato.
  const colore = $(`#theme-editor [data-scelta="${chiave}"]`);
  const testo = $(`#theme-editor [data-scelta-hex="${chiave}"]`);
  if (colore && colore !== el) colore.value = hex;
  if (testo && testo !== el) testo.value = hex;

  aggiornaAvvisi();
  // `change` arriva alla CHIUSURA del selettore nativo: è il valore definitivo
  // e va messo subito, senza aspettare la coda della limitazione.
  anteprima(e.type === 'change');
}

function suClicEditor(e) {
  const btn = e.target.closest('[data-editor]');
  if (!btn || !inModifica) return;
  const azione = btn.dataset.editor;

  if (azione === 'annulla') { chiudiEditor(); applicaTema(temaCorrente()); disegnaElenco(); return; }

  if (azione === 'ripristina') {
    inModifica.scelte = scelteIniziali(inModifica.base);
    disegnaEditor();
    anteprima(true);   // un gesto solo: nessuna raffica da limitare
    return;
  }

  if (azione === 'salva') {
    conCaricamento(btn, async () => {
      const nome = ($('#tema-nome').value || '').trim();
      const v = validaTema({ ...inModifica, nome: nome || inModifica.id });
      if (!v.ok) { toast(v.errore, true); return; }

      // Un tema illeggibile si può salvare — è una scelta dell'utente, non un
      // errore — ma non in silenzio: chi ha sbagliato un colore deve poter
      // tornare indietro prima di ritrovarsi l'interfaccia inutilizzabile.
      const avvisi = diagnostica(v.tema.scelte);
      const grave = avvisi.some((a) => a.campo === 'fg' && a.rapporto < SOGLIA_TESTO);
      if (grave && !window.confirm(
        'Con questi colori il testo è difficile da leggere sullo sfondo.\n\nSalvare lo stesso?')) return;

      const temi = temiSalvati();
      temi[v.tema.id] = v.tema;
      if (!scriviTemi(temi)) return;
      inModifica = null;
      scegliTema(v.tema.id);
      chiudiEditor();
      disegnaElenco();
      toast(`Tema "${v.tema.nome}" salvato e applicato.`);
    });
  }
}

/** Usata dai moduli che disegnano su canvas: legge un token dal documento. */
export function tokenTema(nome, fallback = '') {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
    return v || fallback;
  } catch { return fallback; }
}

/** `true` se il tema in vigore è chiaro. */
export function temaChiaro() {
  return document.documentElement.getAttribute('data-theme') === 'light';
}

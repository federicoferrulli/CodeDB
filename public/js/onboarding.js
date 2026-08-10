'use strict';

/* ---------------------------------------------------------------------------
 * Guida introduttiva (onboarding): benvenuto, tour guidato, primi passi.
 *
 * Tre pezzi, un solo modulo perché condividono stato e chiusura:
 *
 *  1. MODALE DI BENVENUTO (`#onboarding-overlay`) — si apre da sola al primo
 *     avvio e offre tre vie: creare la prima connessione, fare il giro guidato,
 *     o essere lasciati in pace. Riaperta dal menu Impostazioni diventa l'“hub” della
 *     guida (rifai il tour, mostra i primi passi, novità della versione).
 *  2. TOUR GUIDATO — un riquadro luminoso sull'elemento REALE dell'interfaccia
 *     più un fumetto. I passi dichiarano un selettore e sono SALTATI se
 *     l'elemento non esiste o non è visibile: prima di connettersi metà
 *     interfaccia non c'è, e un tour che indica il vuoto è peggio di nessun
 *     tour. Per la stessa ragione i testi non promettono ciò che non si vede.
 *  3. CHECKLIST “primi passi” — pannello in basso a destra che si spunta da
 *     solo quando l'utente compie davvero l'azione (`segnaTraguardo`, chiamato
 *     dai moduli interessati). Non è un elenco di istruzioni da eseguire: è il
 *     riflesso di quello che è già successo.
 *
 * Perché lo spotlight NON usa `.overlay`: quella classe applica
 * `backdrop-filter: blur(12px)` a tutto il viewport (vedi la nota su
 * `#geomap-overlay` in CLAUDE.md). Qui sarebbe due volte sbagliato — il tour
 * deve mostrare NITIDO l'elemento di cui parla, e riposiziona il riquadro a
 * ogni scroll/resize, cioè ripagherebbe la sfocatura a schermo intero a ogni
 * fotogramma. Si usa quindi un oscuramento con `box-shadow` attorno al buco.
 *
 * Lo stato (visto/versione/traguardi) vive in `onboarding-stato.js`, modulo
 * foglia e provato in Node: qui c'è solo interfaccia.
 * ------------------------------------------------------------------------- */

import { $, esc, emit, refreshLucideIcons } from './utils.js';
import { openConnModal } from './connection.js';
import {
  TRAGUARDI, leggiStato, aggiornaStato, completati, tuttoFatto, decidiAvvio,
} from './onboarding-stato.js';

let versioneApp = null;
let tour = null; // { passi, i, elSpot, elFumetto, onReflow }

/* --------------------------- Passi del tour ------------------------------- */

const PASSI = [
  {
    sel: '#conn-sidebar',
    titolo: 'Le tue connessioni',
    testo: 'Qui stanno le connessioni salvate, raggruppabili in cartelle. Le credenziali non passano mai dal browser: '
      + 'restano sul server, cifrate nel vault.',
  },
  {
    sel: '#conn-add-btn',
    titolo: 'Aggiungi una connessione',
    testo: 'MongoDB, MySQL o PostgreSQL — parametri separati oppure URI completa, con tunnel SSH opzionale.',
  },
  {
    sel: '#tab-bar',
    opzionale: true,
    titolo: 'Un tab per connessione',
    testo: 'Ogni tab ha la propria sessione sul server: puoi lavorare su più database insieme senza che si disturbino.',
  },
  {
    sel: '#sidebar',
    opzionale: true,
    titolo: 'Database e tabelle',
    testo: 'L\'albero dei database della connessione aperta. Tasto destro per creare, rinominare, eliminare. '
      + 'Su PostgreSQL questo livello è lo schema.',
  },
  {
    sel: '.view-tabs',
    opzionale: true,
    // Erano cinque quando UML e Grafo 3D erano schede: ora descrivono lo
    // SCHEMA e stanno nel menu Visualizza, e su un tab a livello database
    // applyViewTabsFor ne nasconde altre due. Un passo del tour che indica
    // schede inesistenti è peggio di nessun passo.
    titolo: 'Tre viste sugli stessi dati',
    testo: 'Dati (griglia modificabile), Dettagli (indici e schema) e ⚡ Query & Aggregate. UML e Grafo 3D descrivono lo schema e stanno nel menu Visualizza.',
  },
  {
    sel: '.view-tab[data-view="query"]',
    opzionale: true,
    titolo: 'Query, script e grafici',
    testo: 'SQL, pipeline MQL o sintassi mongosh — su MongoDB anche le SELECT, tradotte. Più istruzioni diventano '
      + 'uno script con pausa e ripresa; i risultati si vedono come tabella, albero JSON o grafico.',
  },
  {
    sel: '#conn-settings-btn',
    titolo: 'Impostazioni',
    testo: 'Backup e ripristino, Storico Azioni, Salute delle connessioni, passphrase del vault — e questa guida, '
      + 'se vuoi rivederla.',
  },
];

/* ------------------------------ Avvio ------------------------------------- */

export function initOnboarding() {
  const btn = $('#btn-onboarding');
  if (btn) {
    btn.addEventListener('click', () => apriHub()); // il menu lo chiude main.js
  }

  const overlay = $('#onboarding-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) chiudiEProsegui();
    });
  }
  const chiudi = $('#onboarding-close');
  // Chiudere con la ✕ vale come "l'ho vista": senza, il benvenuto tornerebbe
  // al riavvio successivo, che è esattamente il modo di renderlo odioso.
  if (chiudi) chiudi.addEventListener('click', chiudiEProsegui);

  document.addEventListener('keydown', (e) => {
    if (tour) {
      if (e.key === 'Escape') { e.preventDefault(); fineTour(); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); vaiAlPasso(tour.i + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); vaiAlPasso(tour.i - 1); }
      return;
    }
    if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) chiudiEProsegui();
  });

  // La checklist si ridisegna da sé quando un traguardo viene raggiunto: i
  // moduli che lo segnalano non conoscono questo file.
  document.addEventListener('codedb:traguardo', () => disegnaChecklist());

  avvioAutomatico();
}

/* --------------------------- Barriere d'accesso ---------------------------
 * Prima della guida possono esserci due schermate che vanno superate: lo
 * SBLOCCO DEL VAULT (`#vault-overlay`, aperto da `checkVaultStatus`) e il
 * LOGIN utente con RBAC attivo (`#login-overlay`). Sono `.overlay`, quindi
 * sfocano l'intero viewport: partire lì sopra significa mostrare un benvenuto
 * e un tour che indicano un'interfaccia illeggibile e non cliccabile — e per
 * giunta rubano l'attenzione all'unica cosa da fare, cioè inserire la
 * passphrase. La guida quindi ASPETTA che spariscano.
 * ------------------------------------------------------------------------ */

const BARRIERE = ['#vault-overlay', '#login-overlay'];

function barrieraAperta() {
  return BARRIERE.some((sel) => {
    const el = document.querySelector(sel);
    return el && !el.classList.contains('hidden');
  });
}

/**
 * Risolve quando nessuna barriera è più aperta.
 *
 * @param {{apparira?: boolean}} [opz] con `apparira: true` la barriera è ATTESA
 *   ma potrebbe non essere ancora nel DOM (la modale del vault si apre alla
 *   risposta di `vault:status`): si concede una finestra di cortesia perché
 *   compaia, invece di concludere che non ci sia.
 */
// Attesa in corso, MEMOIZZATA.
//
// `disegnaChecklist` richiama `attendiAccesso()` a ogni invocazione mentre una
// barriera è aperta, ed è agganciata all'evento `codedb:traguardo` oltre a
// essere chiamata da cinque punti diversi: ogni chiamata creava due nuovi
// MutationObserver (uno per barriera) sullo stesso nodo, e nessuno di essi si
// disconnetteva finché il vault restava bloccato — cioè per tutto il tempo in
// cui l'utente cerca la passphrase. Le promesse restituite, mai risolte,
// tenevano appese anche le catene `.then`. Con la memoizzazione l'osservatore è
// uno solo e la promessa è condivisa da tutti i chiamanti.
let attesaInCorso = null;

async function attendiAccesso(opz) {
  if (opz && opz.apparira && !barrieraAperta()) {
    for (let i = 0; i < 30 && !barrieraAperta(); i++) {
      await new Promise((r) => setTimeout(r, 100)); // max 3 s
    }
  }
  if (!barrieraAperta()) return Promise.resolve();
  if (attesaInCorso) return attesaInCorso;

  attesaInCorso = new Promise((resolve) => {
    let osservatore = null;
    const chiudi = () => {
      if (osservatore) osservatore.disconnect();
      osservatore = null;
      attesaInCorso = null;
    };
    osservatore = new MutationObserver(() => {
      if (barrieraAperta()) return;
      chiudi();
      // Un istante dopo lo sblocco: la sidebar delle connessioni si sta ancora
      // popolando (`loadSavedConnections`) e il tour misura elementi reali.
      setTimeout(resolve, 400);
    });
    let agganciati = 0;
    for (const sel of BARRIERE) {
      const el = document.querySelector(sel);
      if (el) { osservatore.observe(el, { attributes: true, attributeFilter: ['class'] }); agganciati++; }
    }
    // Nessuna barriera nel DOM: la promessa non si risolverebbe mai, e con essa
    // resterebbe appeso chi la attende.
    if (!agganciati) { chiudi(); resolve(); }
  });
  return attesaInCorso;
}

/**
 * Decide cosa mostrare all'avvio. La versione dell'app arriva dal server
 * (`app:info`): se non risponde si prosegue lo stesso — senza versione si può
 * comunque decidere il primo benvenuto, si perdono solo le novità.
 */
async function avvioAutomatico() {
  await attendiAccesso();

  // `emit` mette in coda finché il socket non è connesso: con RBAC attivo
  // questa risposta arriva quindi solo DOPO il login, che è esattamente il
  // momento giusto per proseguire.
  try {
    const res = await emit('app:info');
    versioneApp = (res && res.version) || null;
  } catch { /* server muto o non ancora pronto: la guida non dipende da questo */ }

  // Il vault va chiesto, non dedotto dal DOM: `checkVaultStatus` decide con una
  // risposta asincrona, quindi quando la guida parte l'overlay della passphrase
  // spesso NON è ancora aperto — guardare solo le classi lasciava comparire il
  // benvenuto un istante prima della richiesta di passphrase, che poi gli si
  // sovrapponeva sfocando tutto (segnalato da Keus).
  try {
    const v = await emit('vault:status');
    if (v && v.locked) await attendiAccesso({ apparira: true });
  } catch { /* nessuna risposta: si prosegue col solo controllo sul DOM */ }

  await attendiAccesso();

  const stato = leggiStato();
  const { azione, novita } = decidiAvvio({ stato, versione: versioneApp });

  if (azione === 'benvenuto') apriBenvenuto();
  else if (azione === 'novita') apriNovita(novita);
  else if (!tuttoFatto(stato) && !stato.checklistChiusa && stato.visto) disegnaChecklist();
}

/* ----------------------------- Modale ------------------------------------- */

function apriModale(html) {
  const overlay = $('#onboarding-overlay');
  const corpo = $('#onboarding-body');
  if (!overlay || !corpo) return;
  corpo.innerHTML = html;
  overlay.classList.remove('hidden');
  refreshLucideIcons();

  corpo.querySelectorAll('[data-azione]').forEach((el) => {
    el.addEventListener('click', () => eseguiAzione(el.dataset.azione));
  });
}

function chiudiModale() {
  const overlay = $('#onboarding-overlay');
  if (overlay) overlay.classList.add('hidden');
}

/** Chiusura "normale" (✕, Esc, clic fuori): vale come guida vista. */
function chiudiEProsegui() {
  segnaVista();
  chiudiModale();
  disegnaChecklist();
}

function eseguiAzione(azione) {
  if (azione === 'chiudi') { segnaVista(); chiudiModale(); disegnaChecklist(); return; }
  if (azione === 'connessione') {
    segnaVista();
    chiudiModale();
    disegnaChecklist();
    openConnModal();
    return;
  }
  if (azione === 'tour') { segnaVista(); chiudiModale(); avviaTour(); return; }
  if (azione === 'checklist') {
    segnaVista();
    chiudiModale();
    aggiornaStato({ checklistChiusa: false });
    disegnaChecklist(true);
  }
}

/** "L'utente ha visto la guida di QUESTA versione": niente benvenuto al prossimo avvio. */
function segnaVista() {
  aggiornaStato({ visto: true, versioneVista: versioneApp || leggiStato().versioneVista || '0.0.0' });
}

function apriBenvenuto() {
  apriModale(`
    <div class="onb-hero">
      <i data-lucide="database-zap"></i>
      <h2>Benvenuto in CodeDB</h2>
      <p>Un client unico per <strong>MongoDB</strong>, <strong>MySQL</strong> e <strong>PostgreSQL</strong>:
         esplori i dati, scrivi query e script, disegni grafici, fai backup — e, se usi un assistente AI,
         gli apri un accesso controllato con MCP.</p>
    </div>
    <div class="onb-scelte">
      <button type="button" class="onb-scelta primaria" data-azione="connessione">
        <i data-lucide="plug-zap"></i>
        <span class="onb-scelta-titolo">Crea la prima connessione</span>
        <span class="onb-scelta-nota">Vado al sodo: apro il form e mi collego.</span>
      </button>
      <button type="button" class="onb-scelta" data-azione="tour">
        <i data-lucide="compass"></i>
        <span class="onb-scelta-titolo">Fammi fare un giro</span>
        <span class="onb-scelta-nota">Due minuti sull'interfaccia, si interrompe quando vuoi.</span>
      </button>
      <button type="button" class="onb-scelta" data-azione="chiudi">
        <i data-lucide="hand"></i>
        <span class="onb-scelta-titolo">Esploro da solo</span>
        <span class="onb-scelta-nota">Riapri la guida dal menu Impostazioni quando ti serve.</span>
      </button>
    </div>
  `);
}

/** Stessa modale, riaperta dal menu Impostazioni da chi CodeDB lo conosce già. */
function apriHub() {
  const stato = leggiStato();
  const fatti = completati(stato);
  apriModale(`
    <div class="onb-hero compatto">
      <i data-lucide="life-buoy"></i>
      <h2>Guida introduttiva</h2>
      <p>Primi passi completati: <strong>${fatti} di ${TRAGUARDI.length}</strong>${versioneApp ? ` · CodeDB ${esc(versioneApp)}` : ''}</p>
    </div>
    <div class="onb-scelte">
      <button type="button" class="onb-scelta primaria" data-azione="tour">
        <i data-lucide="compass"></i>
        <span class="onb-scelta-titolo">Rifai il giro guidato</span>
        <span class="onb-scelta-nota">Il tour si adatta a ciò che è aperto adesso.</span>
      </button>
      <button type="button" class="onb-scelta" data-azione="checklist">
        <i data-lucide="list-checks"></i>
        <span class="onb-scelta-titolo">Mostra i primi passi</span>
        <span class="onb-scelta-nota">Il pannello con gli obiettivi ancora aperti.</span>
      </button>
      <button type="button" class="onb-scelta" data-azione="connessione">
        <i data-lucide="plug-zap"></i>
        <span class="onb-scelta-titolo">Nuova connessione</span>
        <span class="onb-scelta-nota">Apre il form di connessione.</span>
      </button>
    </div>
  `);
}

/** Novità dopo un aggiornamento: si apre una volta sola per versione. */
function apriNovita(voci) {
  const blocchi = voci.map((v) => `
    <div class="onb-novita-blocco">
      <h3>Versione ${esc(v.versione)}</h3>
      <ul>${v.punti.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
    </div>
  `).join('');

  apriModale(`
    <div class="onb-hero compatto">
      <i data-lucide="sparkles"></i>
      <h2>CodeDB è stata aggiornata</h2>
      <p>Ecco cosa è cambiato dall'ultima volta che l'hai usata.</p>
    </div>
    <div class="onb-novita">${blocchi}</div>
    <div class="onb-scelte orizzontali">
      <button type="button" class="onb-scelta" data-azione="tour">
        <i data-lucide="compass"></i><span class="onb-scelta-titolo">Rivedi il giro guidato</span>
      </button>
      <button type="button" class="onb-scelta primaria" data-azione="chiudi">
        <i data-lucide="check"></i><span class="onb-scelta-titolo">Ho capito</span>
      </button>
    </div>
  `);
  // Le novità di questa versione sono state mostrate: non si riapre più.
  segnaVista();
}

/* -------------------------------- Tour ------------------------------------ */

function visibile(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none';
}

/** Passi effettivamente mostrabili ADESSO (vedi nota in testa al file). */
function passiDisponibili() {
  return PASSI.filter((p) => {
    const el = document.querySelector(p.sel);
    if (visibile(el)) return true;
    return false; // sia gli opzionali sia gli altri: indicare il nulla non aiuta
  });
}

export async function avviaTour() {
  // Stesso motivo dell'avvio automatico: sopra la schermata della passphrase
  // il tour indicherebbe un'interfaccia sfocata e inaccessibile.
  await attendiAccesso();
  fineTour();
  const passi = passiDisponibili();
  if (!passi.length) return;

  const elSpot = document.createElement('div');
  elSpot.className = 'onb-spot';
  const elFumetto = document.createElement('div');
  elFumetto.className = 'onb-fumetto';
  document.body.append(elSpot, elFumetto);

  const onReflow = () => posizionaPasso();
  window.addEventListener('resize', onReflow);
  window.addEventListener('scroll', onReflow, true);

  tour = { passi, i: 0, elSpot, elFumetto, onReflow };
  vaiAlPasso(0);
}

function vaiAlPasso(i) {
  if (!tour) return;
  if (i < 0) return;
  if (i >= tour.passi.length) { fineTour(true); return; }
  tour.i = i;

  const p = tour.passi[i];
  const ultimo = i === tour.passi.length - 1;
  tour.elFumetto.innerHTML = `
    <div class="onb-fumetto-head">
      <span class="onb-passo-n">Passo ${i + 1} di ${tour.passi.length}</span>
      <button type="button" class="onb-chiudi" data-tour="fine" aria-label="Chiudi la guida">✕</button>
    </div>
    <h3>${esc(p.titolo)}</h3>
    <p>${esc(p.testo)}</p>
    <div class="onb-fumetto-azioni">
      <button type="button" class="ghost" data-tour="salta">Salta</button>
      <span class="spazio"></span>
      <button type="button" class="ghost" data-tour="prec" ${i === 0 ? 'disabled' : ''}>Indietro</button>
      <button type="button" class="primary" data-tour="succ">${ultimo ? 'Ho finito' : 'Avanti'}</button>
    </div>
  `;
  tour.elFumetto.querySelectorAll('[data-tour]').forEach((b) => {
    b.addEventListener('click', () => {
      const a = b.dataset.tour;
      if (a === 'succ') vaiAlPasso(tour.i + 1);
      else if (a === 'prec') vaiAlPasso(tour.i - 1);
      else fineTour();
    });
  });

  const el = document.querySelector(p.sel);
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  posizionaPasso();
}

function posizionaPasso() {
  if (!tour) return;
  const p = tour.passi[tour.i];
  const el = document.querySelector(p.sel);
  if (!el) { vaiAlPasso(tour.i + 1); return; }

  const r = el.getBoundingClientRect();
  const pad = 6;
  const s = tour.elSpot.style;
  s.top = `${r.top - pad}px`;
  s.left = `${r.left - pad}px`;
  s.width = `${r.width + pad * 2}px`;
  s.height = `${r.height + pad * 2}px`;

  // Posizione del fumetto: sotto l'elemento se c'è spazio, altrimenti sopra,
  // altrimenti A LATO. Il terzo caso non è teorico: la barra delle connessioni
  // e l'albero dei database sono alti quanto la finestra, quindi sopra e sotto
  // non c'è nulla e il fumetto finirebbe SULL'elemento che sta indicando.
  const f = tour.elFumetto;
  const M = 12;
  const w = Math.min(360, window.innerWidth - M * 2);
  f.style.width = `${w}px`;
  const h = f.offsetHeight || 200;

  let top;
  let left;
  if (r.bottom + M + h < window.innerHeight) {
    top = r.bottom + M;
    left = r.left + r.width / 2 - w / 2;
  } else if (r.top - M - h > 0) {
    top = r.top - h - M;
    left = r.left + r.width / 2 - w / 2;
  } else {
    top = Math.max(M, Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - M));
    left = (r.right + M + w < window.innerWidth) ? r.right + M : r.left - w - M;
  }
  f.style.top = `${Math.max(M, top)}px`;
  f.style.left = `${Math.max(M, Math.min(left, window.innerWidth - w - M))}px`;
}

function fineTour(completato) {
  if (!tour) return;
  window.removeEventListener('resize', tour.onReflow);
  window.removeEventListener('scroll', tour.onReflow, true);
  tour.elSpot.remove();
  tour.elFumetto.remove();
  tour = null;
  segnaVista();
  if (completato) {
    // Finito il giro, il seguito naturale sono i primi passi.
    aggiornaStato({ checklistChiusa: false });
    disegnaChecklist(true);
  } else {
    disegnaChecklist();
  }
}

/* ------------------------------ Checklist --------------------------------- */

/**
 * Disegna (o aggiorna) il pannello dei primi passi.
 * @param {boolean} forza mostra il pannello anche se l'utente l'aveva chiuso
 */
export function disegnaChecklist(forza) {
  // Il pannello sta a z-index 8000, cioè SOPRA le modali (`.overlay`, z-index
  // 100): senza questo controllo comparirebbe a galla sulla schermata della
  // passphrase, che è il momento in cui l'utente non può fare nient'altro.
  if (barrieraAperta()) {
    attendiAccesso().then(() => disegnaChecklist(forza));
    return;
  }

  const stato = leggiStato();
  let box = $('#onb-checklist');

  const daNascondere = (!forza && (stato.checklistChiusa || tuttoFatto(stato))) || !stato.visto;
  if (daNascondere && !(tuttoFatto(stato) && box)) {
    if (box) box.remove();
    return;
  }

  if (!box) {
    box = document.createElement('aside');
    box.id = 'onb-checklist';
    box.className = 'onb-checklist';
    document.body.appendChild(box);
  }

  const fatti = completati(stato);
  const perc = Math.round((fatti / TRAGUARDI.length) * 100);
  const finito = tuttoFatto(stato);

  box.innerHTML = `
    <div class="onb-check-head">
      <span><i data-lucide="list-checks"></i> Primi passi</span>
      <span class="onb-check-conteggio">${fatti}/${TRAGUARDI.length}</span>
      <button type="button" class="onb-chiudi" data-check="chiudi" aria-label="Nascondi i primi passi">✕</button>
    </div>
    <div class="onb-barra"><span style="width:${perc}%"></span></div>
    <ul class="onb-check-lista">
      ${TRAGUARDI.map((t) => {
    const ok = Boolean(stato.traguardi[t.id]);
    return `<li class="${ok ? 'fatto' : ''}">
          <i data-lucide="${ok ? 'check-circle-2' : 'circle'}"></i>
          <span class="onb-check-testo">
            <strong>${esc(t.etichetta)}</strong>
            ${ok ? '' : `<em>${esc(t.aiuto)}</em>`}
          </span>
        </li>`;
  }).join('')}
    </ul>
    ${finito ? '<p class="onb-check-fine">Ci sei. Da qui in poi il pannello non ricompare.</p>' : ''}
  `;

  box.querySelector('[data-check="chiudi"]').addEventListener('click', () => {
    aggiornaStato({ checklistChiusa: true });
    box.remove();
  });
  refreshLucideIcons();
}

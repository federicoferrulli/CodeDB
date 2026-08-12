'use strict';

/* ---------------------------------------------------------------------------
 * Pannello "Sessioni & Query attive": cosa sta girando ADESSO sul server di
 * database, di chiunque sia.
 *
 * È il gemello rivolto all'esterno del pannello Salute (`health.js`): là si
 * guardano le connessioni di CodeDB — le nostre —, qui tutte quelle del
 * server, comprese quelle di altre applicazioni e i processi di servizio del
 * DBMS. Le due domande sono diverse ("CodeDB sta bene?" contro "chi sta
 * occupando il database?") e per questo restano due pannelli.
 *
 * Tre scelte non ovvie:
 *
 *  1. **La connessione si sceglie da un elenco, non è quella del tab attivo.**
 *     Il monitor descrive un SERVER: legarlo al tab costringerebbe a cambiare
 *     scheda — e quindi a perdere di vista la query lenta — per guardare
 *     l'altro database. Il `tabId` viaggia perciò esplicito nel payload, che
 *     per contratto (vedi `emit` in utils.js) vince sul tab attivo.
 *
 *  2. **Il motivo per cui una riga non è terminabile arriva dal server.**
 *     Qui non si decide nulla: `blocchi.query` / `blocchi.connessione` sono
 *     già frasi in italiano, e l'unica cosa che fa il client è disabilitare il
 *     pulsante e metterle nel `title`. Riapplicare le regole sarebbe una
 *     seconda copia di `motivoNonTerminabile`, destinata a divergere.
 *
 *  3. **Il pulsante disabilitato spiega sempre perché.** Un "Termina" grigio e
 *     muto accanto alla riga che si vuole uccidere è la ricetta per credere a
 *     un guasto dell'applicazione.
 * ------------------------------------------------------------------------- */

import { $, emit, esc, cut, toast, iniziaCaricamento, conCaricamento } from './utils.js';
import { tabs } from './tabs.js';

let autoTimer = null;
let tabIdCorrente = null;
// Ultima risposta del server: serve al menu contestuale delle azioni (per
// ritrovare la riga cliccata) senza rileggere il DOM.
let ultimeSessioni = [];
let ultimaRisposta = null;
// Le righe su cui non si può agire (CodeDB, processi di servizio) partono
// nascoste: vedi `#sessions-hidden` in index.html.
let mostraNonAzionabili = false;
// Disciplina delle richieste sovrapposte (vedi `carica`).
let inVolo = false;
let ultimoGiro = 0;

const REFRESH_MS = 5000;

export function initSessions() {
  const btn = $('#btn-sessions');
  if (btn) btn.addEventListener('click', apri);

  const close = $('#btn-close-sessions-modal');
  if (close) close.addEventListener('click', chiudi);

  const refresh = $('#btn-refresh-sessions');
  if (refresh) refresh.addEventListener('click', () => {
    const fine = iniziaCaricamento(refresh, '');
    Promise.resolve(carica()).finally(fine);
  });

  const sel = $('#sessions-conn-select');
  if (sel) sel.addEventListener('change', () => {
    tabIdCorrente = sel.value || null;
    // Cambiando server la tabella precedente non c'entra più nulla: si
    // svuota, invece di lasciare le righe del server di prima sotto il nome
    // del nuovo finché non arriva la risposta.
    $('#sessions-list').dataset.loaded = '';
    carica();
  });

  // Filtro di sola presentazione: si ridisegna quello che c'è già, senza
  // tornare al server (i dati sono gli stessi, cambia cosa se ne mostra).
  const soloAttive = $('#sessions-only-active');
  if (soloAttive) soloAttive.addEventListener('change', () => disegna(ultimeSessioni, ultimaRisposta));

  // "Mostra anche quelle su cui non puoi agire": un interruttore che vive
  // nella riga riassuntiva sotto la tabella, non fra i filtri in cima —
  // serve una volta ogni tanto e non deve occupare spazio permanente.
  const nascosti = $('#sessions-hidden');
  if (nascosti) nascosti.addEventListener('click', (e) => {
    if (!e.target.closest('[data-toggle-nascosti]')) return;
    mostraNonAzionabili = !mostraNonAzionabili;
    disegna(ultimeSessioni, ultimaRisposta);
  });

  // Il pulsante del verdetto agisce sulla sessione che il server ha indicato.
  const verdetto = $('#sessions-verdict');
  if (verdetto) verdetto.addEventListener('click', onClickLista);

  const auto = $('#sessions-auto-refresh');
  if (auto) auto.addEventListener('change', () => {
    if (auto.checked) avviaAuto(); else fermaAuto();
  });

  // Un solo gestore delegato: il corpo della tabella viene riscritto a ogni
  // refresh, quindi agganciare i pulsanti riga per riga significherebbe
  // riagganciarli ogni cinque secondi.
  const lista = $('#sessions-list');
  if (lista) lista.addEventListener('click', onClickLista);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal-sessions').classList.contains('hidden')) chiudi();
  });
}

function apri() {
  const modal = $('#modal-sessions');
  if (!modal) return;
  if (!popolaConnessioni()) {
    toast('Apri prima una connessione: il monitor mostra le sessioni di un server di database.', true);
    return;
  }
  modal.classList.remove('hidden');
  carica();
  if ($('#sessions-auto-refresh').checked) avviaAuto();
}

function chiudi() {
  $('#modal-sessions').classList.add('hidden');
  fermaAuto();
}

function avviaAuto() {
  fermaAuto();
  // `_bg: true` come per il polling della griglia: l'auto-refresh non è
  // un'azione dell'utente e non deve finire nello Storico Azioni, che
  // altrimenti si riempirebbe da solo finché il pannello resta aperto.
  autoTimer = setInterval(() => carica({ auto: true }), REFRESH_MS);
}

function fermaAuto() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
}

/** Riempie l'elenco delle connessioni aperte; false se non ce n'è nessuna. */
function popolaConnessioni() {
  const sel = $('#sessions-conn-select');
  if (!sel) return false;
  const aperti = tabs.list.filter((t) => t.id);
  if (!aperti.length) return false;

  if (!tabIdCorrente || !aperti.some((t) => t.id === tabIdCorrente)) {
    tabIdCorrente = tabs.activeId || aperti[0].id;
  }
  sel.innerHTML = aperti
    .map((t) => `<option value="${esc(t.id)}"${t.id === tabIdCorrente ? ' selected' : ''}>${esc(t.label || t.connName || 'connessione')}</option>`)
    .join('');
  return true;
}

async function carica({ auto = false } = {}) {
  const container = $('#sessions-list');
  if (!container) return;

  // L'elenco delle connessioni si rilegge a ogni giro, non solo all'apertura:
  // il pannello resta aperto per minuti mentre l'utente apre e chiude tab, e
  // se la connessione monitorata viene chiusa ogni refresh fallirebbe con
  // "nessuna connessione attiva per questo tab" — un errore che sembra un
  // guasto del monitor mentre è solo un tab che non c'è più.
  if (!popolaConnessioni()) {
    container.innerHTML = '<div class="empty-state">Nessuna connessione aperta: il monitor mostra le sessioni di un server di database.</div>';
    $('#sessions-verdict').innerHTML = '';
    $('#sessions-hidden').classList.add('hidden');
    fermaAuto();
    return;
  }

  // Su un server carico `db:sessions` può metterci più dei 5 s dell'auto-
  // refresh. Due protezioni distinte, perché i due problemi lo sono:
  //
  //  · un TICK automatico mentre una richiesta è già in volo si salta — non ha
  //    senso accumulare interrogazioni su un server che sta già faticando,
  //    ed è proprio la situazione in cui il pannello viene aperto;
  //  · le richieste VOLUTE (apertura, pulsante Aggiorna, refresh dopo un kill)
  //    partono sempre, ma disegna solo l'ULTIMA arrivata: senza il numero di
  //    giro una risposta vecchia potrebbe arrivare dopo una nuova e riscrivere
  //    la tabella con uno stato superato — e su un pannello che serve a
  //    decidere chi terminare, mostrare il passato per il presente è il
  //    difetto peggiore che possa avere.
  if (auto && inVolo) return;
  inVolo = true;
  const giro = ++ultimoGiro;
  if (!container.dataset.loaded) {
    container.innerHTML = '<div class="loading-spinner">Lettura delle sessioni sul server…</div>';
  }
  try {
    const res = await emit('db:sessions', { tabId: tabIdCorrente, _bg: auto });
    if (giro !== ultimoGiro) return; // sorpassata da una richiesta più recente
    ultimeSessioni = res.sessioni || [];
    ultimaRisposta = res;
    mostraNota(res);
    disegna(ultimeSessioni, res);
    container.dataset.loaded = '1';
  } catch (err) {
    if (giro !== ultimoGiro) return; // errore di una richiesta ormai superata
    ultimeSessioni = [];
    ultimaRisposta = null;
    container.dataset.loaded = '';
    container.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    $('#sessions-verdict').innerHTML = '';
    $('#sessions-hidden').classList.add('hidden');
    // Un errore ripetuto ogni cinque secondi è solo rumore: l'auto-refresh si
    // ferma da solo e resta il pulsante Aggiorna.
    fermaAuto();
    const auto2 = $('#sessions-auto-refresh');
    if (auto2) auto2.checked = false;
  } finally {
    // Solo l'ultima richiesta libera il flag: una superata che finisce dopo
    // rimetterebbe "libero" mentre una più recente è ancora in volo.
    if (giro === ultimoGiro) inVolo = false;
  }
}

// Note del server: privilegi mancanti (PROCESS, pg_monitor, inprog), elenco
// troncato, MongoDB che non ha sessioni inattive da mostrare. Vanno dette:
// una lista corta per mancanza di privilegi è indistinguibile da un server
// tranquillo, e porta alla conclusione opposta.
function mostraNota(res) {
  const box = $('#sessions-note');
  if (!box) return;
  const note = [];
  if (res.nota) note.push(res.nota);
  if (res.troncato) note.push('Elenco troncato: vengono mostrate solo le prime sessioni, ordinate dalla più vecchia.');
  if (res.capacita && res.capacita.terminaConnessione === false) {
    note.push('Questo database permette di annullare l\'operazione in corso ma non di chiudere la connessione di un altro client.');
  }
  // Va detto solo quando c'è davvero qualcuno in attesa: annunciare un limite
  // che al momento non toglie nulla è rumore, e allena a saltare le note.
  const bloccateSenzaCausa = (res.sessioni || []).some((s) => s.stato === 'in attesa' && !(s.bloccataDa || []).length);
  if (res.capacita && res.capacita.saBloccanti === false && bloccateSenzaCausa) {
    note.push('Questo database non sa dire QUALE sessione tenga il lock: le sessioni in attesa si vedono, chi le blocca va cercato fra le transazioni aperte e le scritture più vecchie.');
  }
  box.innerHTML = note.map((n) => `<div>⚠ ${esc(n)}</div>`).join('');
  box.classList.toggle('hidden', note.length === 0);
}

/* --- Disegno ---------------------------------------------------------------- */

function classeDurata(s) {
  // La soglia ha senso solo su una query in esecuzione: dieci minuti di
  // inattività sono normali, dieci minuti di query no.
  if (s.secondiDi !== 'query' || s.secondi == null) return '';
  if (s.secondi >= 60) return 'health-lat-bad';
  if (s.secondi >= 5) return 'health-lat-warn';
  return 'health-lat-good';
}

function durata(s) {
  if (s.secondi == null) return '<span class="sub-text">—</span>';
  const n = s.secondi;
  let t;
  if (n < 60) t = `${n} s`;
  else if (n < 3600) t = `${Math.floor(n / 60)} m ${Math.round(n % 60)} s`;
  else t = `${Math.floor(n / 3600)} h ${Math.floor((n % 3600) / 60)} m`;
  // Su una sessione ferma il numero misura l'inattività, non una query: la
  // precisazione va sotto e per esteso ("3 s · ferma da" si legge al
  // contrario di come è scritto).
  const che = s.secondiDi === 'inattivita' ? '<div class="sub-text">di inattività</div>' : '';
  return `<span class="health-lat ${classeDurata(s)}">${esc(t)}</span>${che}`;
}

function statoCella(s) {
  const badge = {
    'in attesa': '<span class="health-err">⛔ In attesa</span>',
    attiva: '<span class="health-ok">▶ Attiva</span>',
    inattiva: '<span class="sub-text">⏸ Inattiva</span>',
  }[s.stato] || '<span class="sub-text">?</span>';
  const parti = [badge];
  // Chi blocca gli altri va detto per primo e forte: è la riga su cui agire, e
  // per stato può essere la più innocua della tabella (una "Inattiva" che
  // tiene fermo mezzo database).
  if (s.bloccaAltre) {
    parti.push(`<span class="health-err">blocca ${s.bloccaAltre} ${s.bloccaAltre === 1 ? 'sessione' : 'sessioni'}</span>`);
  }
  if ((s.bloccataDa || []).length) {
    parti.push(`<span class="sub-text">in attesa di ${s.bloccataDa.map((i) => `#${esc(i)}`).join(', ')}</span>`);
  }
  // "Transazione aperta" si segnala solo dove è una SORPRESA: su una sessione
  // ferma, che da un semplice "Inattiva" non si distinguerebbe pur tenendo i
  // lock. Su una sessione che sta eseguendo o aspettando è quasi sempre vero e
  // non aggiunge nulla — è rumore ambrato accanto all'unica riga ambrata che
  // conta davvero.
  if (s.transazioneAperta && s.stato === 'inattiva') parti.push('<span class="health-warn">transazione aperta</span>');
  if (s.dettaglioStato) parti.push(`<span class="sub-text">${esc(cut(s.dettaglioStato, 60))}</span>`);
  return parti.join('<br>');
}

const ETICHETTA = { query: '✖ Annulla query', connessione: '⏻ Termina connessione' };

/**
 * L'azione GIUSTA per lo stato della riga, non tutte quelle possibili.
 *
 * Su una sessione ferma "annulla la query" riesce senza fare nulla — è il
 * pulsante che fa credere di aver risolto —, mentre su una query in corso
 * chiudere la connessione è più violento di quanto serva. Il pannello
 * propone quindi UNA azione in evidenza, quella adatta, e lascia l'altra
 * come riga di testo sotto: raggiungibile, ma non alla pari.
 */
function azioni(s) {
  const bloc = s.blocchi || {};
  if (bloc.query && bloc.connessione) {
    // Nessuna delle due è possibile: si dice perché, una volta sola, al posto
    // di due pulsanti grigi.
    return `<span class="sub-text" title="${esc(bloc.query)}">${esc(cut(bloc.query, 90))}</span>`;
  }
  const preferita = s.stato === 'inattiva' ? 'connessione' : 'query';
  const primo = bloc[preferita] ? (preferita === 'query' ? 'connessione' : 'query') : preferita;
  const secondo = primo === 'query' ? 'connessione' : 'query';

  const classe = primo === 'connessione' ? 'btn-danger' : 'btn-secondary';
  let html = `<button type="button" class="btn btn-sm ${classe}" data-kill="${primo}" data-id="${esc(s.id)}">${ETICHETTA[primo]}</button>`;
  if (!bloc[secondo]) {
    html += `<button type="button" class="sessions-alt" data-kill="${secondo}" data-id="${esc(s.id)}">oppure ${secondo === 'connessione' ? 'termina la connessione' : 'annulla solo la query'}</button>`;
  } else {
    // L'alternativa impedita non sparisce: la sua assenza si noterebbe e non
    // si capirebbe. Una riga di testo con il motivo costa meno di un dubbio.
    html += `<span class="sessions-alt-off" title="${esc(bloc[secondo])}">${esc(cut(bloc[secondo], 60))}</span>`;
  }
  return html;
}

/* --- Il verdetto ------------------------------------------------------------
 * Titolo, spiegazione e — quando c'è — il pulsante che agisce sulla sessione
 * indicata dal server. Nessuna decisione presa qui: `res.diagnosi` arriva già
 * risolta da `db/sessioni.js`, come i motivi di rifiuto.
 * -------------------------------------------------------------------------- */
function disegnaVerdetto(res, sessioni) {
  const box = $('#sessions-verdict');
  if (!box) return;
  const d = res && res.diagnosi;
  if (!d) { box.innerHTML = ''; box.className = 'sessions-verdict'; return; }

  const icona = { allarme: '⛔', attenzione: '⚠', ok: '✓' }[d.livello] || '•';
  box.className = `sessions-verdict sessions-verdict-${d.livello}`;

  let azione = '';
  if (d.azione && !d.azione.impedita) {
    const s = sessioni.find((x) => String(x.id) === String(d.azione.id));
    // Il pulsante del verdetto è lo stesso gesto della tabella (stesso
    // `data-kill`, stesso gestore, stessa conferma): quello che cambia è che
    // qui non bisogna prima trovare la riga giusta.
    azione = `<button type="button" class="btn btn-sm ${d.azione.modo === 'connessione' ? 'btn-danger' : 'btn-secondary'}"
        data-kill="${d.azione.modo}" data-id="${esc(String(d.azione.id))}"
        title="${esc(s && s.query ? cut(s.query, 200) : `Sessione ${d.azione.id}`)}">${ETICHETTA[d.azione.modo]} ${esc(String(d.azione.id))}</button>`;
  } else if (d.azione && d.azione.impedita) {
    azione = `<span class="sub-text">${esc(d.azione.impedita)}</span>`;
  }

  box.innerHTML = `
    <div class="sessions-verdict-testo">
      <div class="sessions-verdict-titolo">${icona} ${esc(d.titolo)}</div>
      ${d.dettaglio ? `<div class="sessions-verdict-dettaglio">${esc(d.dettaglio)}</div>` : ''}
    </div>
    ${azione ? `<div class="sessions-verdict-azione">${azione}</div>` : ''}`;
}

function disegna(sessioni, res) {
  const container = $('#sessions-list');
  if (!container) return;

  const soloAttive = $('#sessions-only-active').checked;
  // Filtro di sola presentazione (nessuna conseguenza sulla sicurezza: le
  // regole su cosa è terminabile stanno sul server).
  //
  // Due esclusioni con ragioni diverse. Le righe NON AZIONABILI (connessioni
  // di CodeDB, processi di servizio) escono perché l'utente non può farci
  // nulla, e moltiplicate per gli otto slot del pool sono quasi sempre la
  // maggioranza dell'elenco: restare significherebbe cercare le due righe che
  // contano dentro dieci che non contano. Le sessioni FERME escono su scelta
  // dell'utente — ma una ferma dentro una transazione aperta, o che sta
  // bloccando qualcuno, non è "ferma" ai fini di questa domanda: sta tenendo
  // il database, e nasconderla vorrebbe dire nascondere la risposta.
  const nonAzionabile = (s) => s.interna || s.nostra;
  const viste = sessioni.filter((s) => {
    if (nonAzionabile(s) && !mostraNonAzionabili) return false;
    if (soloAttive && s.stato === 'inattiva' && !s.transazioneAperta && !s.bloccaAltre) return false;
    return true;
  });

  disegnaVerdetto(res, sessioni);
  riassuntoNascoste(sessioni);

  if (!viste.length) {
    container.innerHTML = `<div class="empty-state">${sessioni.length
      ? 'Nessun\'altra sessione oltre a quelle di servizio: nessuno sta usando questo database in questo momento.'
      : 'Nessuna sessione in corso sul server in questo momento.'}</div>`;
    return;
  }

  const righe = viste.map((s) => {
    const query = s.query
      ? `<code class="sessions-query" title="${esc(s.query)}">${esc(cut(s.query, 140))}${s.queryTroncata ? ' …' : ''}</code>`
      : '<span class="sub-text">—</span>';
    const chi = [
      esc(s.utente || '—'),
      s.host ? `<span class="sub-text">${esc(s.host)}</span>` : '',
      s.nostra ? '<span class="sessions-tag">CodeDB</span>' : '',
      s.interna ? '<span class="sessions-tag">servizio</span>' : '',
    ].filter(Boolean).join('<br>');

    return `
      <tr class="${s.bloccaAltre ? 'sessions-row-blocca' : (s.stato === 'in attesa' ? 'audit-row-err' : '')}">
        <td class="sessions-id">${esc(s.id)}</td>
        <td>${chi}</td>
        <td>${esc(s.db || '—')}</td>
        <td>${statoCella(s)}</td>
        <td>${durata(s)}</td>
        <td>${query}</td>
        <td class="sessions-actions">${azioni(s)}</td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="backup-table sessions-table">
      <thead>
        <tr>
          <th>Id</th><th>Utente</th><th>Database</th><th>Stato</th><th>Durata</th><th>Query</th><th></th>
        </tr>
      </thead>
      <tbody>${righe}</tbody>
    </table>`;
}

// Le righe tolte dalla tabella si CONTANO, non si fanno sparire: "dove sono
// finite le connessioni di CodeDB?" è una domanda che verrebbe, e la risposta
// dev'essere sotto gli occhi invece che in una casella da ricordarsi.
function riassuntoNascoste(tutte) {
  const box = $('#sessions-hidden');
  if (!box) return;
  const nostre = tutte.filter((s) => s.nostra && !s.interna).length;
  const servizio = tutte.filter((s) => s.interna).length;
  if (!nostre && !servizio) { box.classList.add('hidden'); return; }

  const pezzi = [];
  if (nostre) pezzi.push(`${nostre} ${nostre === 1 ? 'connessione' : 'connessioni'} di CodeDB`);
  if (servizio) pezzi.push(`${servizio} ${servizio === 1 ? 'processo' : 'processi'} di servizio del server`);
  box.classList.remove('hidden');
  box.innerHTML = mostraNonAzionabili
    ? `In elenco anche ${pezzi.join(' e ')}, su cui non si può agire. <button type="button" data-toggle-nascosti>Nascondi</button>`
    : `Non mostrate: ${pezzi.join(' e ')}, su cui non si può agire. <button type="button" data-toggle-nascosti>Mostra</button>`;
}

/* --- Terminazione ----------------------------------------------------------- */

async function onClickLista(e) {
  const btn = e.target.closest('button[data-kill]');
  if (!btn || btn.disabled) return;
  const modo = btn.dataset.kill;
  const id = btn.dataset.id;
  const s = ultimeSessioni.find((x) => String(x.id) === String(id));
  if (!s) return;

  // La conferma cita utente e query: si sta interrompendo il lavoro di
  // qualcun altro, e l'id da solo non dice a chi.
  const cosa = modo === 'connessione'
    ? `Terminare la CONNESSIONE ${id}?\n\nLa transazione in corso verrà annullata dal server e il client si troverà disconnesso.`
    : `Annullare la query in corso nella sessione ${id}?\n\nLa sessione resta aperta; la sua transazione, se c'è, no.`;
  const chi = `\n\nUtente: ${s.utente || '—'}${s.db ? ` · Database: ${s.db}` : ''}`;
  const q = s.query ? `\nQuery: ${s.query.slice(0, 200)}${s.query.length > 200 ? '…' : ''}` : '';
  if (!confirm(cosa + chi + q)) return;

  await conCaricamento(btn, async () => {
    try {
      const res = await emit('db:killSession', { tabId: tabIdCorrente, id, modo });
      if (res.terminata) {
        toast(modo === 'connessione' ? `Connessione ${id} terminata.` : `Query della sessione ${id} annullata.`);
      } else {
        // Su PostgreSQL `pg_cancel_backend` restituisce false quando il pid non
        // esiste più: quasi sempre significa che la query è finita da sola nel
        // frattempo, non che l'operazione sia fallita.
        toast(`Nessuna operazione da fermare per la sessione ${id}: potrebbe essere già terminata.`, true);
      }
    } catch (err) {
      toast(err.message, true);
    }
    await carica({ auto: true });
  }, '');
}

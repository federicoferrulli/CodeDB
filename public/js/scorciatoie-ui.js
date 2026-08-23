'use strict';

/* ---------------------------------------------------------------------------
 * Pannello "Scorciatoie da tastiera" (menu Impostazioni) e persistenza delle
 * preferenze. La logica delle combinazioni sta in `scorciatoie.js` (puro);
 * qui c'Ã¨ solo interfaccia e trasporto.
 *
 * Persistenza SOTTO AL TENANT: con RBAC attivo le preferenze vivono nella
 * collezione `prefs` del control plane (`prefs:get`/`prefs:set`, chiave
 * `{ownerId, chiave}`), quindi un utente del tenant le ritrova da qualunque
 * browser. Con RBAC spento il server risponde che non c'Ã¨ un tenant: il
 * ripiego dichiarato Ã¨ il `localStorage` di quel browser.
 * ------------------------------------------------------------------------- */

import {
  CATALOGO, CHIAVE_PREFS, CHIAVE_LOCALE,
  normalizzaCombo, etichettaCombo, mappaEffettiva, impostaMappaAttiva,
} from './scorciatoie.js';
import { $, emit, esc, toast } from './utils.js';

/** Le personalizzazioni correnti SOLO come testi ("Ctrl+K"), non forme normalizzate. */
let personali = leggiLocali();

function leggiLocali() {
  try { return JSON.parse(localStorage.getItem(CHIAVE_LOCALE) || '{}') || {}; } catch { return {}; }
}

function salvaLocali(p) {
  try { localStorage.setItem(CHIAVE_LOCALE, JSON.stringify(p)); } catch { /* quota piena */ }
}

/** Carica le preferenze del tenant (server) e semina la mappa attiva. */
export async function caricaScorciatoie() {
  let personalizzazioni = null;
  let origine = 'predefinite';
  try {
    const res = await emit('prefs:get', { chiave: CHIAVE_PREFS });
    if (res && res.ok && res.valore && typeof res.valore === 'object') {
      personalizzazioni = res.valore;
      origine = 'tenant';
    }
  } catch {
    // RBAC spento o server muto: si parte dal browser.
  }
  if (!personalizzazioni || !Object.keys(personalizzazioni).length) {
    personalizzazioni = leggiLocali();
    origine = Object.keys(personalizzazioni).length ? 'browser' : origine;
  }
  personali = { ...personalizzazioni };
  const { mappa } = mappaEffettiva(personali);
  impostaMappaAttiva(mappa);
  document.dispatchEvent(new CustomEvent('codedb:scorciatoie', { detail: { origine } }));
}

/** Salva le personalizzazioni: server (tenant) se disponibile, browser altrimenti. */
async function salvaScorciatoie(p) {
  personali = { ...p };
  const { mappa, errori } = mappaEffettiva(personali);
  impostaMappaAttiva(mappa);
  salvaLocali(personali); // mirror locale: copre RBAC spento e fa da cache istantanea
  try {
    await emit('prefs:set', { chiave: CHIAVE_PREFS, valore: personali });
    return { dove: 'tenant', errori };
  } catch {
    return { dove: 'browser', errori };
  }
}

/**
 * Il pannello. Una riga per azione del catalogo: etichetta + pulsante che
 * registra la combinazione (si preme il pulsante, si digita la combinazione).
 */
export function apriPannelloScorciatoie() {
  if ($('#scorciatoie-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'scorciatoie-overlay';
  overlay.className = 'overlay hidden';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="modal scorciatoie-modal" style="max-width:560px">
      <h2 id="scorciatoie-title"><i data-lucide="keyboard"></i> Scorciatoie da tastiera</h2>
      <p class="scorciatoie-nota">Clicca una combinazione per cambiarla: quando il pulsante lampeggia,
         premi la combinazione che vuoi. Esc annulla. Le scelte valgono per tutto il tenant.</p>
      <div id="scorciatoie-lista"></div>
      <p id="scorciatoie-errori" class="scorciatoie-errori hidden"></p>
      <div class="scorciatoie-azioni">
        <button type="button" class="ghost" id="scorciatoie-ripristina">Ripristina predefinite</button>
        <span class="spazio"></span>
        <button type="button" class="primary" id="scorciatoie-chiudi">Fatto</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const lista = overlay.querySelector('#scorciatoie-lista');
  let inRegistrazione = null; // id dell'azione in attesa di una combinazione

  const disegna = () => {
    const effettiva = mappaEffettiva(personali).mappa;
    lista.innerHTML = CATALOGO.map((a) => {
      const personalizzata = Boolean(personali[a.id]);
      return `<div class="scorciatoie-riga${inRegistrazione === a.id ? ' attiva' : ''}" data-id="${esc(a.id)}">
        <span class="scorciatoie-nome">${esc(a.etichetta)}
          <em>${esc(a.descrizione)}</em></span>
        <button type="button" class="btn-combo" data-registra="${esc(a.id)}"
          title="Clicca e premi la nuova combinazione">
          ${inRegistrazione === a.id ? 'Premi i tastiâ€¦' : esc(etichettaCombo(effettiva[a.id]) || '?')}
          ${personalizzata ? ' *' : ''}</button>
      </div>`;
    }).join('');
    const { errori } = mappaEffettiva(personali);
    const box = overlay.querySelector('#scorciatoie-errori');
    box.classList.toggle('hidden', !errori.length);
    box.textContent = errori.join(' Â· ');
  };

  // Registrazione: un keydown su document cattura la combinazione mentre una
  // riga e' in attesa. Esc annulla; i soli modificatori vengono ignorati.
  const onKeyDown = (e) => {
    if (!inRegistrazione) return;
    if (e.key === 'Escape') { inRegistrazione = null; disegna(); return; }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const testo = [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '',
      e.shiftKey ? 'Shift' : '', e.key.length === 1 ? e.key.toUpperCase() : e.key]
      .filter(Boolean).join('+');
    if (!normalizzaCombo(testo)) return; // non e' una combinazione sensata
    personali[inRegistrazione] = testo;
    inRegistrazione = null;
    disegna();
  };
  document.addEventListener('keydown', onKeyDown, true);

  lista.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-registra]');
    if (!btn) return;
    inRegistrazione = btn.dataset.registra;
    disegna();
  });

  overlay.addEventListener('click', (e) => {
    if (e.target !== overlay) return;
    chiudi();
  });

  overlay.querySelector('#scorciatoie-ripristina').addEventListener('click', () => {
    personali = {};
    inRegistrazione = null;
    disegna();
    // Il salvataggio NON blocca né il pannello né la lettura: parte in
    // background, perché un socket lento non deve lasciare la modale aperta.
    salvaScorciatoie({}).then(() => {
      toast('Scorciatoie ripristinate.'); // anche qui, senza dettagli interni
    });
  });

  function chiudi() {
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
  }

  // CHIUDI PRIMA, SALVA DOPO: la chiusura è un gesto dell'interfaccia e non può
  // stare in coda dietro una risposta di rete che magari non arriva mai (`emit`
  // non ha timeout). L'utente clicca "Fatto": il pannello si chiude SUBITO, e
  // le preferenze viaggiano da sole; se il salvataggio fallisce, lo dice il
  // toast, non una modale ostaggio del socket.
  overlay.querySelector('#scorciatoie-chiudi').addEventListener('click', () => {
    chiudi();
    salvaScorciatoie(personali).then((esito) => {
      if (esito.errori.length) {
        toast('Attenzione: ' + esito.errori[0], true);
      } else {
        toast('Scorciatoie salvate.'); // la destinazione (tenant o browser) è un dettaglio interno
      }
    });
  });

  overlay.classList.remove('hidden');
  disegna();
}

/** Aggancia la voce di menu e carica le preferenze del tenant all'avvio. */
export function initScorciatoie() {
  const btn = $('#btn-scorciatoie');
  if (btn) btn.addEventListener('click', () => apriPannelloScorciatoie());
  caricaScorciatoie();
}

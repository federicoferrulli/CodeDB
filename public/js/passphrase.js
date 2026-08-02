/**
 * CodeDB — Cambio della passphrase del vault (voce "Cambia Passphrase" in ⋮)
 *
 * Fino a ieri la passphrase si poteva solo SUBIRE: era la chiave stessa dei
 * segreti, quindi cambiarla significava ri-cifrare a mano l'intero
 * `connections.ini` (export con la nuova passphrase, sostituzione del file,
 * riavvio). Ora il vault usa la cifratura a busta (`db/vault.js`) e cambiarla
 * è un'operazione piccola e reversibile: si riavvolge la chiave dati.
 *
 * Il modulo fa poco di suo — la sostanza è lato server — ma si prende cura
 * delle tre cose che qui contano davvero:
 *
 *  · chiedere la passphrase ATTUALE anche a vault sbloccato (chi si siede a
 *    una sessione lasciata aperta non deve poter cambiare la chiave altrui);
 *  · dire prima, non dopo, che il primo cambio su un vault storico ri-cifra i
 *    segreti e crea una copia di sicurezza;
 *  · avvisare che non esiste recupero, e che dal prossimo avvio serve la
 *    passphrase nuova.
 */

import { $, emit, toast } from './utils.js';

const MIN_LUNGHEZZA = 8;

function mostra(el, visibile) {
  if (el) el.classList.toggle('hidden', !visibile);
}

function errore(testo) {
  const el = $('#passphrase-error');
  if (!el) return;
  el.textContent = testo;
  mostra(el, !!testo);
}

function apriModale() {
  const overlay = $('#passphrase-overlay');
  if (!overlay) return;

  errore('');
  mostra($('#passphrase-success'), false);
  ['#passphrase-current', '#passphrase-next', '#passphrase-confirm'].forEach((sel) => {
    const el = $(sel);
    if (el) el.value = '';
  });

  // Lo stato del vault decide cosa mostrare: su un vault ancora nel formato
  // storico il primo cambio comporta una migrazione, e va detto prima.
  emit('vault:status', {})
    .then((res) => {
      if (res && res.locked) {
        toast('Il vault è bloccato: sbloccalo con la passphrase attuale prima di cambiarla.', true);
        overlay.classList.add('hidden');
        return;
      }
      mostra($('#passphrase-migration-note'), !!res && res.formato === 1);
      const attuale = $('#passphrase-current');
      if (attuale) {
        attuale.placeholder = res && res.protetto
          ? 'La passphrase con cui è aperto il vault'
          : 'Lascia vuoto: non ne è mai stata impostata una';
      }
    })
    .catch(() => { /* la modale funziona comunque */ });

  overlay.classList.remove('hidden');
  const primo = $('#passphrase-current');
  if (primo) primo.focus();
}

function chiudiModale() {
  const overlay = $('#passphrase-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function invia(e) {
  e.preventDefault();
  errore('');

  const current = $('#passphrase-current')?.value ?? '';
  const next = $('#passphrase-next')?.value ?? '';
  const confirm = $('#passphrase-confirm')?.value ?? '';

  if (next.length < MIN_LUNGHEZZA) {
    errore(`La nuova passphrase deve essere lunga almeno ${MIN_LUNGHEZZA} caratteri.`);
    return;
  }
  if (next !== confirm) {
    errore('Le due passphrase non coincidono.');
    return;
  }
  if (next === current) {
    errore('La nuova passphrase è identica a quella attuale.');
    return;
  }

  const bottone = $('#passphrase-form')?.querySelector('button[type="submit"]');
  if (bottone) bottone.disabled = true;

  emit('vault:setPassphrase', { current, next })
    .then((res) => {
      const box = $('#passphrase-success');
      if (box) {
        box.textContent = res.migrated
          ? `Passphrase impostata e vault migrato al formato protetto. ${res.avviso || ''}`
          : `Passphrase cambiata. ${res.avviso || ''}`;
        mostra(box, true);
      }
      toast(res.migrated ? 'Vault migrato e passphrase impostata' : 'Passphrase cambiata');
      // La modale resta aperta qualche istante: l'avviso sul prossimo avvio è
      // la cosa più importante di tutta l'operazione.
      setTimeout(chiudiModale, 4000);
    })
    .catch((err) => {
      errore((err && err.message) || 'Cambio passphrase non riuscito.');
    })
    .finally(() => {
      if (bottone) bottone.disabled = false;
    });
}

export function initPassphrase() {
  const apri = $('#btn-change-passphrase');
  const form = $('#passphrase-form');
  const annulla = $('#passphrase-cancel');
  const overlay = $('#passphrase-overlay');

  if (apri) {
    apri.addEventListener('click', () => {
      const menu = $('#header-more-menu');
      if (menu) menu.classList.add('hidden');
      apriModale();
    });
  }
  if (form) form.addEventListener('submit', invia);
  if (annulla) annulla.addEventListener('click', chiudiModale);
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) chiudiModale();
    });
  }
}

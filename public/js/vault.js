'use strict';

import { $, emit, toast } from './utils.js';
import { loadSavedConnections } from './connmanager.js';
import { valutaAvvisoVault } from './passphrase.js';

const MIN_LUNGHEZZA = 8;

export function checkVaultStatus() {
  emit('vault:status', {})
    .then((res) => {
      if (res && res.locked) {
        showVaultModal();
      } else {
        hideVaultModal();
        loadSavedConnections();
        // Vault aperto: se lo è perché non ha mai avuto una passphrase, i
        // segreti salvati sono cifrati con la chiave vuota — cioè leggibili da
        // chiunque abbia il file. L'utente non ha modo di accorgersene: glielo
        // si dice qui.
        valutaAvvisoVault(res);
      }
    })
    .catch(() => {
      // In caso di errore di connessione socket iniziale, prova comunque a caricare
      loadSavedConnections();
    });
}

export function showVaultModal() {
  const overlay = $('#vault-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    mostraReset(false);
    const input = $('#vault-passphrase');
    if (input) input.focus();
  }
}

export function hideVaultModal() {
  const overlay = $('#vault-overlay');
  if (overlay) overlay.classList.add('hidden');
  mostraReset(false);
}

/**
 * Passa fra le due schermate della modale: sblocco e "riparti da zero".
 *
 * Sono alternative, non impilate: chi ha perso la password non ha più niente da
 * fare nel form di sblocco, e tenere in vista entrambi i titoli fa sembrare la
 * ripartenza un passo aggiuntivo dello sblocco invece della sua alternativa.
 * Dalla schermata di ripartenza si torna indietro con un solo pulsante.
 */
function mostraReset(visibile) {
  const blocco = $('#vault-reset');
  if (!blocco) return;
  blocco.classList.toggle('hidden', !visibile);
  $('#vault-unlock')?.classList.toggle('hidden', visibile);
  // Il fuoco si sposta solo a modale aperta: `mostraReset(false)` viene chiamata
  // anche alla chiusura, e lì non c'è nulla su cui posarlo.
  const aperta = !$('#vault-overlay')?.classList.contains('hidden');

  if (!visibile) {
    if (aperta) $('#vault-passphrase')?.focus();
    return;
  }

  // Ogni ingresso riparte pulito: campi vuoti, casella non spuntata, nessun
  // messaggio rimasto dal tentativo precedente.
  ['#vault-reset-next', '#vault-reset-confirm'].forEach((sel) => {
    const el = $(sel);
    if (el) el.value = '';
  });
  const ack = $('#vault-reset-ack');
  if (ack) ack.checked = false;
  erroreReset('');
  $('#vault-reset-success')?.classList.add('hidden');
  if (aperta) $('#vault-reset-next')?.focus();
}

function erroreReset(testo) {
  const el = $('#vault-reset-error');
  if (!el) return;
  el.textContent = testo;
  el.classList.toggle('hidden', !testo);
}

/**
 * Azzera il vault: connessioni salvate messe da parte e passphrase nuova.
 *
 * La conferma è doppia di proposito (casella di spunta + pulsante rosso): è
 * l'unica operazione della modale che fa perdere qualcosa, e la si raggiunge
 * proprio quando si è frustrati per una password che non si ricorda.
 */
function inviaReset(e) {
  e.preventDefault();
  erroreReset('');

  const next = $('#vault-reset-next')?.value ?? '';
  const confirm = $('#vault-reset-confirm')?.value ?? '';
  const ack = $('#vault-reset-ack')?.checked;

  if (next.length < MIN_LUNGHEZZA) {
    erroreReset(`La nuova password deve essere lunga almeno ${MIN_LUNGHEZZA} caratteri.`);
    return;
  }
  if (next !== confirm) {
    erroreReset('Le due password non coincidono.');
    return;
  }
  if (!ack) {
    erroreReset('Spunta la casella per confermare che le connessioni salvate verranno eliminate.');
    return;
  }

  const bottone = $('#vault-reset-form')?.querySelector('button[type="submit"]');
  if (bottone) bottone.disabled = true;

  emit('vault:reset', { passphrase: next, confirm: true })
    .then((res) => {
      const box = $('#vault-reset-success');
      if (box) {
        box.textContent = res.avviso || 'Vault ricreato con la nuova password.';
        box.classList.remove('hidden');
      }
      toast('Vault ricreato: connessioni azzerate e nuova password impostata');
      // Il vault è già aperto in memoria: da qui l'applicazione è utilizzabile,
      // semplicemente senza connessioni salvate.
      setTimeout(() => {
        hideVaultModal();
        loadSavedConnections();
      }, 4000);
    })
    .catch((err) => {
      erroreReset((err && err.message) || 'Azzeramento non riuscito.');
    })
    .finally(() => {
      if (bottone) bottone.disabled = false;
    });
}

export function initVault() {
  const form = $('#vault-form');
  const errorEl = $('#vault-error');

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const passphraseInput = $('#vault-passphrase');
      const passphrase = passphraseInput ? passphraseInput.value : '';
      if (errorEl) errorEl.classList.add('hidden');

      emit('vault:unlock', { passphrase })
        .then((res) => {
          if (res && res.ok) {
            hideVaultModal();
            loadSavedConnections();
          } else {
            if (errorEl) {
              errorEl.textContent = (res && res.error) || 'Passphrase errata.';
              errorEl.classList.remove('hidden');
            }
          }
        })
        .catch((err) => {
          if (errorEl) {
            errorEl.textContent = (err && err.message) || 'Errore durante lo sblocco.';
            errorEl.classList.remove('hidden');
          }
        });
    });
  }

  const forgot = $('#vault-forgot');
  if (forgot) forgot.addEventListener('click', () => mostraReset(true));

  const resetForm = $('#vault-reset-form');
  if (resetForm) resetForm.addEventListener('submit', inviaReset);

  const indietro = $('#vault-reset-back');
  if (indietro) indietro.addEventListener('click', () => mostraReset(false));

  checkVaultStatus();
}

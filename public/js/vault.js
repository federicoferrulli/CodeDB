'use strict';

import { $, emit } from './utils.js';
import { loadSavedConnections } from './connmanager.js';

export function checkVaultStatus() {
  emit('vault:status', {})
    .then((res) => {
      if (res && res.locked) {
        showVaultModal();
      } else {
        hideVaultModal();
        loadSavedConnections();
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
    const input = $('#vault-passphrase');
    if (input) input.focus();
  }
}

export function hideVaultModal() {
  const overlay = $('#vault-overlay');
  if (overlay) overlay.classList.add('hidden');
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

  checkVaultStatus();
}

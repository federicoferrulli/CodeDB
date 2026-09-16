'use strict';

import { $, openModal, closeModal, esc } from './utils.js';
import { riepilogoPiano } from './riepilogo-piano.js';

/**
 * La conferma di un piano: il DOM che manca a `riepilogo-piano.js`.
 *
 * Export, import e restore confermavano con `window.confirm` e una stringa
 * composta a mano nel punto di chiamata — cioè ogni flusso decideva per conto
 * proprio che cosa valesse la pena mostrare, e una voce dimenticata in uno dei
 * tre non si notava. Che cosa un piano dica sta ora in un posto solo
 * (`riepilogoPiano`, puro e provato senza browser); qui c'è soltanto come si
 * disegna.
 *
 * L'impronta si mostra perché è l'identità del piano: l'esecuzione rifiuta ciò
 * che non coincide con quanto è stato confermato, e se quel numero cambia fra
 * l'anteprima e il via è successo qualcosa che l'utente deve poter vedere.
 *
 * `window.confirm` non era solo brutto: blocca il thread, non si può leggere
 * con uno screen reader come parte della pagina, e tronca il testo lungo —
 * proprio gli avvisi, che sono la parte che conta.
 */
export function confermaPiano(piano, { titolo = null, azione = 'Procedi' } = {}) {
  const r = riepilogoPiano(piano);
  $('#piano-titolo').textContent = titolo || r.titolo;
  $('#piano-voci').innerHTML = r.voci
    .map((v) => `<dt>${esc(v.etichetta)}</dt><dd>${esc(v.valore)}</dd>`).join('');
  const avvisi = $('#piano-avvisi');
  avvisi.innerHTML = r.avvisi.map((a) => `<li>${esc(a)}</li>`).join('');
  avvisi.classList.toggle('hidden', !r.avvisi.length);
  $('#piano-impronta').textContent = `Impronta del piano: ${r.fingerprint}`;
  $('#piano-ok').textContent = azione;

  return new Promise((resolve) => {
    const ok = $('#piano-ok');
    const annulla = $('#piano-cancel');
    // Gli ascoltatori si tolgono SEMPRE, anche uscendo dal ramo «annulla»:
    // lasciarli attaccati farebbe risolvere anche la promessa della conferma
    // precedente al clic successivo, cioè eseguire un piano che nessuno ha
    // appena confermato.
    const chiudi = (esito) => {
      ok.removeEventListener('click', si);
      annulla.removeEventListener('click', no);
      closeModal('#piano-overlay');
      resolve(esito);
    };
    const si = () => chiudi(true);
    const no = () => chiudi(false);
    ok.addEventListener('click', si);
    annulla.addEventListener('click', no);
    openModal('#piano-overlay');
  });
}

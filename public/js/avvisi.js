/**
 * CodeDB — L'avviso passeggero in fondo alla pagina (toast).
 *
 * Modulo foglia: nessun import. Sta da solo, e non dentro il sacco delle
 * utilità, perché il trasporto (`trasporto.js`) ha bisogno di avvisare
 * l'utente quando una riconnessione riesce o fallisce — e importare per questo
 * l'intero `utils.js` significherebbe tirarsi dietro le modali, le icone, i
 * menu contestuali e i loro ascoltatori globali sul `document`, cioè un ciclo
 * di import e un modulo non caricabile fuori dal browser.
 *
 * `utils.js` lo ri-esporta, quindi chi importava `toast` da lì continua a
 * funzionare: è la stessa scelta già fatta per `valori.js`.
 */

export function toast(msg, isError = false) {
  if (!document.querySelector('#toast-container')) return;
  // La durata segue la lunghezza: gli errori ora sono frasi con causa e rimedio
  // (db/errors.js) e in 3 secondi fissi non si leggevano — sparivano prima della
  // parte che dice cosa fare. ~55 ms per carattere, fra 3 e 12 secondi.
  const durata = Math.min(Math.max(3000, String(msg).length * 55), 12000);
  document.dispatchEvent(new CustomEvent('codedb:toast', {
    detail: { message: String(msg), type: isError ? 'error' : 'info', duration: durata, replace: true },
  }));
}

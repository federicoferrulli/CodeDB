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

let timer = null;

export function toast(msg, isError = false) {
  const el = document.querySelector('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(timer);
  // La durata segue la lunghezza: gli errori ora sono frasi con causa e rimedio
  // (db/errors.js) e in 3 secondi fissi non si leggevano — sparivano prima della
  // parte che dice cosa fare. ~55 ms per carattere, fra 3 e 12 secondi.
  const durata = Math.min(Math.max(3000, String(msg).length * 55), 12000);
  timer = setTimeout(() => el.classList.add('hidden'), durata);
}

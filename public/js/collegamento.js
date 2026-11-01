import { notifica, chiudiNotifica } from './avvisi.js';

// Un avviso per interruzione: chiuderlo non ferma i tentativi di Socket.IO.
export function initCollegamento(socket, haSessione) {
  let dismissed = false;
  let generazione = 0;
  let tentativi = 0;
  let diagnosticaInCorso = false;
  let ultimoMessaggio = '';
  const TRASPORTO = /websocket error|xhr poll error|transport error|transport close|timeout/i;

  function mostra(message, hint = 'Puoi chiudere questo avviso e continuare a consultare le schede e i dati già caricati.') {
    if (dismissed || socket.connected) return;
    if (ultimoMessaggio === message) return;
    ultimoMessaggio = message;
    notifica(message, {
      tipo: 'collegamento', id: 'server-disconnesso', titolo: 'Collegamento a CodeDB interrotto', hint,
      actionLabel: 'Riconnetti', onAction: () => socket.connect(),
      onDismiss: () => { dismissed = true; generazione++; diagnosticaInCorso = false; },
    });
  }

  socket.on('connect', () => {
    generazione++; dismissed = false; tentativi = 0; diagnosticaInCorso = false; ultimoMessaggio = '';
    chiudiNotifica('server-disconnesso');
  });
  socket.on('disconnect', reason => {
    generazione++; tentativi = 0; diagnosticaInCorso = false;
    if (reason === 'io client disconnect') { chiudiNotifica('server-disconnesso'); return; }
    if (haSessione()) mostra('Il collegamento con il server CodeDB si è interrotto. La riconnessione continua automaticamente.');
  });
  socket.on('connect_error', async error => {
    const motivo = error?.message || 'motivo sconosciuto';
    // L'accesso richiesto appartiene al login, non all'avviso di rete.
    if (motivo === 'auth_required') { generazione++; diagnosticaInCorso = false; chiudiNotifica('server-disconnesso'); return; }
    if (dismissed || socket.connected) return;
    if (!TRASPORTO.test(motivo)) { mostra(`Il server CodeDB ha rifiutato il collegamento: ${motivo}`); return; }
    if (++tentativi < 3 || diagnosticaInCorso) return;
    diagnosticaInCorso = true;
    const richiesta = generazione;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    let rifiuto = null;
    try {
      const res = await fetch('handshake-check', { cache: 'no-store', signal: controller.signal });
      const dati = await res.json();
      if (dati?.ok === false && dati.reason) rifiuto = String(dati.reason);
    } catch { /* Server irraggiungibile: resta il messaggio di rete. */ }
    finally { clearTimeout(timeout); if (richiesta === generazione) diagnosticaInCorso = false; }
    if (richiesta !== generazione) return;
    mostra(rifiuto ? `Il server CodeDB ha rifiutato il collegamento: ${rifiuto}`
      : 'Il server CodeDB non risponde. La riconnessione continua automaticamente.');
  });
}

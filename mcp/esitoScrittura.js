'use strict';

// I conteggi di documenti e di operazioni sono unità diverse. Un inserimento
// multiplo può fallire dentro la prima operazione dopo aver scritto più righe.
function descriviEsitoParziale(esito) {
  if (!esito || typeof esito !== 'object') return null;
  if (esito.rolledBack) return `Nessuna mutazione e' rimasta applicata: la transazione e' stata annullata per intero (${esito.rolledBackBy === 'disconnessione' ? 'la connessione e stata chiusa e il server ha annullato la transazione' : 'rollback'}).`;
  if (Number.isFinite(esito.insertedCount)) {
    return esito.insertedCount > 0
      ? `ATTENZIONE: ${esito.insertedCount} documenti sono gia' stati inseriti e NON sono stati annullati. Non ripetere l'inserimento intero: verifica i documenti applicati prima di riprovare.`
      : 'Nessuna mutazione risulta applicata.';
  }
  const applicate = esito.completed;
  const interna = descriviEsitoParziale(esito.failedOperationResult);
  if (!Number.isFinite(applicate)) return interna || 'Esito delle mutazioni non confermato: verifica i dati prima di riprovare.';
  if (applicate <= 0) return interna || 'Nessuna mutazione risulta applicata.';
  return `ATTENZIONE: ${applicate} operazioni su ${esito.operationCount} sono gia' state applicate e NON sono state annullate`
    + (esito.transactional === false ? ' (su MongoDB questo blocco non e transazionale)' : '')
    + `. Non ripetere il batch intero: riprendilo dall'operazione in posizione ${(esito.failedIndex ?? applicate) + 1}.`
    + (interna ? ` Esito dell'operazione fallita: ${interna}` : '');
}

module.exports = { descriviEsitoParziale };

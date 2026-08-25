export function descriviEsitoImport(status) {
  const labels = {
    in_corso: 'Import in corso',
    completato: 'Import completato e verificato',
    ripristinato_dopo_errore: 'Errore: destinazione originale ripristinata',
    intervento_richiesto: 'Errore: intervento manuale richiesto',
  };
  const value = String(status || '');
  return {
    label: labels[value] || value,
    terminal: value !== 'in_corso',
    ok: value === 'completato',
    className: `dbimport-report esito-${value}`,
  };
}

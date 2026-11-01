'use strict';

// Il dump SQL imposta già la sessione in UTC. Anche il campo senza fuso viene
// confrontato secondo questa convenzione: un TIMESTAMP non contiene il fuso
// del produttore, e l'ora locale del processo CLI non deve reinterpretarlo.
// Il chiamante ha già arretrato boundary del margine incrementale previsto.
function istante(boundary) {
  if (!(boundary instanceof Date) && typeof boundary !== 'string') throw new Error('Confine temporale del backup SQL non valido.');
  const value = new Date(boundary);
  if (!Number.isFinite(value.getTime())) throw new Error('Confine temporale del backup SQL non valido.');
  return value;
}

function confinePostgres(type, boundary) {
  const normalized = String(type).trim().toLowerCase().replace(/\s+/g, ' ');
  const parameter = istante(boundary).toISOString();
  if (normalized === 'date') {
    // Una DATE scritta dopo il backup può essere uguale alla data del confine.
    // Rileggiamo l'intera giornata, anche quando il margine esplicito è zero.
    return { operator: '>=', expression: "($1::timestamptz AT TIME ZONE 'UTC')::date", parameter };
  }
  if (/^(?:timestamptz(?:\([0-6]\))?|timestamp(?:\([0-6]\))? with time zone)$/.test(normalized)) {
    return { operator: '>', expression: '$1::timestamptz', parameter };
  }
  if (/^timestamp(?:\([0-6]\))?(?: without time zone)?$/.test(normalized)) {
    return { operator: '>', expression: "($1::timestamptz AT TIME ZONE 'UTC')", parameter };
  }
  throw new Error(`Tipo temporale PostgreSQL non valido per il confine incrementale: ${type}.`);
}

function confineMySql(type, boundary) {
  const normalized = String(type).trim().toLowerCase();
  const parameter = istante(boundary).getTime() / 1000;
  if (normalized === 'date') return { operator: '>=', expression: 'DATE(FROM_UNIXTIME(?))', parameter };
  if (/^(?:datetime|timestamp)(?:\([0-6]\))?$/.test(normalized)) {
    return { operator: '>', expression: 'FROM_UNIXTIME(?)', parameter };
  }
  throw new Error(`Tipo temporale MySQL non valido per il confine incrementale: ${type}.`);
}

module.exports = { confinePostgres, confineMySql };

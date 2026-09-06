// Dopo una risposta persa si interroga la ricevuta; non si ripete la scrittura.
export async function importaBlocco(emit, payload, {
  attesa = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  tentativi = 20,
} = {}) {
  const richiesta = { ...payload, batchId: payload.batchId || crypto.randomUUID() };
  const consulta = { tabId: richiesta.tabId, db: richiesta.db, coll: richiesta.coll,
    batchId: richiesta.batchId, statusOnly: true };
  let result;
  let error;
  try { result = await emit('collection:import', richiesta, { timeoutMs: 15000 }); }
  catch (err) { error = err; }
  if (result && result.status === 'completato') return result;
  for (let i = 0; i < tentativi; i++) {
    if (result && ['incerto', 'sconosciuto'].includes(result.status)) break;
    await attesa(500);
    try { result = await emit('collection:import', consulta, { timeoutMs: 5000 }); }
    catch (err) { error = err; continue; }
    if (result.status === 'completato') return result;
  }
  return { batchId: richiesta.batchId, status: 'incerto',
    error: result && result.error || error && error.message || 'Ricevuta non ancora disponibile.' };
}

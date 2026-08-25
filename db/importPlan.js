'use strict';

const crypto = require('crypto');
const { normalizzaExportDatabase, tipoDb } = require('./artefatti');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function congela(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) congela(child);
  return Object.freeze(value);
}

function contenutoImpronta(plan) {
  const { fingerprint: _fingerprint, ...rest } = plan;
  return rest;
}

/** Costruisce e congela il contratto che anteprima ed esecuzione condividono. */
function creaPianoImport({ artifact, expectedDbType, connection, targetDb, drop = false }) {
  const normalized = normalizzaExportDatabase(artifact, { expectedDbType });
  const dbType = tipoDb(normalized.dbType);
  const target = String(targetDb || '').trim();
  if (!target) throw new Error('Database/schema di destinazione mancante.');
  const conn = String(connection || '').trim();
  if (!conn) throw new Error('Connessione di destinazione mancante.');

  const body = {
    version: 1,
    kind: 'import-database',
    connection: conn,
    dbType,
    sourceDb: normalized.db,
    targetDb: target,
    drop: !!drop,
    promotion: dbType === 'postgresql'
      ? { kind: 'swap-schema-atomico', atomic: true, keepsRecovery: true }
      : { kind: 'staging-con-recupero', atomic: false, keepsRecovery: true },
    collections: normalized.collections.map((collection) => ({
      name: collection.name,
      rows: collection.docs.length,
      identity: collection.identity || (dbType === 'mongodb'
        ? { kind: 'mongodb-id', columns: ['_id'] }
        : null),
      schemaObjects: (collection.indexes || []).length + (collection.postDdl || []).length,
    })),
    artifact: normalized,
  };
  const plan = { ...body, fingerprint: fingerprint(body) };
  return congela(plan);
}

function verificaImpronta(plan) {
  if (!plan || plan.fingerprint !== fingerprint(contenutoImpronta(plan))) {
    throw new Error('Il piano non coincide con la sua impronta: anteprima ed esecuzione sono divergenti.');
  }
}

function annullata(signal) {
  if (signal && signal.aborted) {
    const err = new Error('Import annullato cooperativamente.');
    err.code = 'IMPORT_ABORTED';
    throw err;
  }
}

/**
 * Orchestratore indipendente dal DBMS. L'adapter e' intenzionalmente piccolo:
 * rende testabile l'ordine delle barriere e lascia ai motori le garanzie reali.
 */
async function eseguiPianoImport(plan, { adapter, signal = null, onProgress = () => {} } = {}) {
  verificaImpronta(plan);
  if (!adapter) throw new Error('Adapter del piano mancante.');
  if (typeof adapter.setSignal === 'function') adapter.setSignal(signal);
  let recovery = null;
  let staging = null;
  let mutated = false;
  const phase = async (name, fn) => {
    annullata(signal);
    onProgress({ phase: name, status: 'in_corso', fingerprint: plan.fingerprint });
    const result = await fn();
    onProgress({ phase: name, status: 'completata', fingerprint: plan.fingerprint });
    return result;
  };

  try {
    // La validazione dell'intero piano, comprese capability e compatibilita'
    // della destinazione, precede qualunque metodo che possa mutare.
    await phase('validazione', () => adapter.validatePlan(plan));
    const exists = await phase('destinazione', () => adapter.destinationExists(plan));
    if (exists) {
      recovery = await phase('recupero', () => adapter.createRecovery(plan));
      if (!recovery || recovery.verified !== true) {
        throw new Error('La copia full di recupero non risulta verificata.');
      }
      mutated = true;
    }
    mutated = true;
    staging = await phase('staging', () => adapter.prepareStaging(plan, recovery, exists));
    await phase('applicazione', () => adapter.apply(plan, staging));
    const staged = await phase('verifica_staging', () => adapter.verify(plan, 'staging', staging));
    if (!staged || staged.ok !== true || staged.schemaObjects === false) {
      throw new Error('La verifica di dati, collezioni o oggetti di schema nello staging non e riuscita.');
    }
    await phase('promozione', () => adapter.promote(plan, staging, recovery));
    const final = await phase('verifica_finale', () => adapter.verify(plan, 'destinazione', staging));
    if (!final || final.ok !== true || final.schemaObjects === false) {
      throw new Error('La verifica finale di dati, collezioni o oggetti di schema non e riuscita.');
    }
    return congela({
      status: 'completato', fingerprint: plan.fingerprint, recovery, staging,
      verification: final, promotion: plan.promotion,
    });
  } catch (err) {
    if (!mutated) throw err;
    try {
      await adapter.restore(plan, recovery, staging, err);
      return congela({
        status: 'ripristinato_dopo_errore', fingerprint: plan.fingerprint,
        recovery, staging, error: err.message,
        originalError: { code: err.code || null, codeName: err.codeName || null, target: err.target || null },
      });
    } catch (restoreErr) {
      return congela({
        status: 'intervento_richiesto', fingerprint: plan.fingerprint,
        recovery, staging, error: err.message, recoveryError: restoreErr.message,
        originalError: { code: err.code || null, codeName: err.codeName || null, target: err.target || null },
      });
    }
  }
}

module.exports = { creaPianoImport, eseguiPianoImport, verificaImpronta };

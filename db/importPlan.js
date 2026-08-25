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

/** Piano immutabile per una catena di backup gia' descritta e validabile. */
function creaPianoRestore({ source, expectedDbType, connection, targetDb, drop = false, allowUnsafeSchema = false }) {
  if (!source || source.kind !== 'backup-chain' || !Array.isArray(source.layers) || !source.layers.length) {
    throw new Error('Sorgente backup del piano mancante o malformata.');
  }
  const dbType = tipoDb(source.dbType);
  if (expectedDbType && dbType !== tipoDb(expectedDbType)) {
    throw new Error(`Il backup e' ${dbType}, ma la connessione e' ${tipoDb(expectedDbType)}.`);
  }
  const target = String(targetDb || source.sourceDb || '').trim();
  const conn = String(connection || '').trim();
  if (!target || !conn) throw new Error('Connessione o destinazione del restore mancante.');
  const body = {
    version: 1, kind: 'restore-backup', connection: conn, dbType,
    sourceDb: source.sourceDb, targetDb: target, drop: !!drop, allowUnsafeSchema: !!allowUnsafeSchema,
    promotion: dbType === 'postgresql'
      ? { kind: 'swap-schema-atomico', atomic: true, keepsRecovery: true }
      : { kind: 'staging-con-recupero', atomic: false, keepsRecovery: true },
    collections: source.collections || [], source,
  };
  return congela({ ...body, fingerprint: fingerprint(body) });
}

function verificaImpronta(plan) {
  if (!plan || plan.fingerprint !== fingerprint(contenutoImpronta(plan))) {
    throw new Error('Il piano non coincide con la sua impronta: anteprima ed esecuzione sono divergenti.');
  }
}

/**
 * Che cosa NON torna, in una riga leggibile.
 *
 * La verifica sa gia' quali collection mancano, quali sono di troppo, quali
 * conteggi divergono e quali oggetti di schema differiscono: il motore lo
 * riduceva a «la verifica non e riuscita», cioe' a un esito che dice che
 * qualcosa e' andato storto senza dire cosa. Chi riceve quel messaggio non ha
 * modo di agire, ed e' esattamente l'informazione che serve a decidere se
 * ritentare, correggere l'origine o chiedere aiuto.
 */
function dettaglioVerifica(verification) {
  if (!verification) return '';
  const parti = [];
  const elenco = (valori, limite = 5) => {
    const lista = valori.slice(0, limite).join(', ');
    return valori.length > limite ? `${lista}, +${valori.length - limite}` : lista;
  };
  if (verification.missing && verification.missing.length) {
    parti.push(`collection/tabelle mancanti: ${elenco(verification.missing)}`);
  }
  if (verification.extras && verification.extras.length) {
    parti.push(`presenti e non attese: ${elenco(verification.extras)}`);
  }
  if (verification.mismatches && verification.mismatches.length) {
    parti.push(`conteggi divergenti: ${elenco(verification.mismatches)}`);
  }
  if (verification.objectMismatches && verification.objectMismatches.length) {
    parti.push(`oggetti di schema: ${elenco(verification.objectMismatches)}`);
  }
  for (const difference of verification.schemaDifferences || []) {
    const pezzi = [];
    if (difference.missing && difference.missing.length) pezzi.push(`${difference.missing.length} mancanti`);
    if (difference.extras && difference.extras.length) pezzi.push(`${difference.extras.length} inattesi`);
    parti.push(`${difference.field}: ${pezzi.join(', ')}`);
  }
  return parti.length ? ` Divergenze: ${elenco(parti, 6)}.` : '';
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
  let stagingStarted = false;
  let targetMayBeMutated = false;
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
    }
    stagingStarted = true;
    staging = await phase('staging', () => adapter.prepareStaging(plan, recovery, exists));
    await phase('applicazione', () => adapter.apply(plan, staging));
    const staged = await phase('verifica_staging', () => adapter.verify(plan, 'staging', staging));
    if (!staged || staged.ok !== true || staged.schemaObjects === false) {
      const err = new Error(
        'La verifica di dati, collezioni o oggetti di schema nello staging non e riuscita.'
        + dettaglioVerifica(staged)
      );
      err.verification = staged || null;
      throw err;
    }
    targetMayBeMutated = true;
    await phase('promozione', () => adapter.promote(plan, staging, recovery));
    const final = await phase('verifica_finale', () => adapter.verify(plan, 'destinazione', staging));
    if (!final || final.ok !== true || final.schemaObjects === false) {
      const err = new Error(
        'La verifica finale di dati, collezioni o oggetti di schema non e riuscita.'
        + dettaglioVerifica(final)
      );
      err.verification = final || null;
      throw err;
    }
    return congela({
      status: 'completato', fingerprint: plan.fingerprint, recovery, staging,
      verification: final, promotion: plan.promotion,
    });
  } catch (err) {
    if (!stagingStarted) throw err;
    // Fino alla promozione ogni scrittura riguarda esclusivamente lo staging:
    // il bersaglio originale e' ancora intatto e non deve essere ricostruito.
    if (!targetMayBeMutated || err.targetUnchanged === true) {
      return congela({
        status: 'ripristinato_dopo_errore', fingerprint: plan.fingerprint,
        recovery, staging, error: err.message, verification: err.verification || null,
        originalError: { code: err.code || null, codeName: err.codeName || null, target: err.target || null },
      });
    }
    try {
      await phase('rollback', () => adapter.restore(plan, recovery, staging, err));
      return congela({
        status: 'ripristinato_dopo_errore', fingerprint: plan.fingerprint,
        recovery, staging, error: err.message, verification: err.verification || null,
        originalError: { code: err.code || null, codeName: err.codeName || null, target: err.target || null },
      });
    } catch (restoreErr) {
      return congela({
        status: 'intervento_richiesto', fingerprint: plan.fingerprint,
        recovery, staging, error: err.message, recoveryError: restoreErr.message,
        verification: err.verification || null,
        originalError: { code: err.code || null, codeName: err.codeName || null, target: err.target || null },
      });
    }
  }
}

module.exports = { creaPianoImport, creaPianoRestore, eseguiPianoImport, verificaImpronta };

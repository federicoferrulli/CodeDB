'use strict';

/* ---------------------------------------------------------------------------
 * Strumenti MCP per backup, catalogo, verifica SHA-256, ripristino e import
 * di artefatti `.codedb.json`.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { runBackup } = require('../backup/lib/engine');
const { origineSessione, verificaOrigine, erroreVerificaOrigine, filtraCatalogo } = require('../backup/lib/origine');
const { resolveChain } = require('../backup/lib/restore');
const { parseStorage, uploadBackupDir } = require('../backup/lib/storage');
const { resolveStorageAlias, resolveSlackWebhook } = require('../backup/lib/policy');
const { createLogger } = require('../backup/lib/logger');
const { readCatalog, verifyBackupDir, formatBytes, parseCollectionSelection } = require('../backup/lib/util');
const { notifySlack } = require('../backup/lib/notify');
const { canWholeConnection } = require('../auth/permissions');
const { creaPianoImport, creaPianoRestore, eseguiPianoImport } = require('../db/importPlan');
const { createImportArtifactAdapter } = require('../db/importArtifactAdapter');
const { sanitizeImportResult } = require('../db/importOperations');
const { descriviBackup, createBackupRestoreAdapter } = require('../db/backupRestoreAdapter');
const { errMsg, jsonResult } = require('./guardie');

function backupVerificationPayload(report) {
  const details = Array.isArray(report && report.details) ? report.details : [];
  const category = (status) => details.filter((item) => item && item.status === status);
  const missing = category('MISSING');
  const mismatch = category('CORRUPTED');
  const unverifiable = category('UNVERIFIABLE');
  const extra = category('UNDECLARED');
  return {
    backup_id: report && report.backupId,
    ok_files: Number(report && report.okCount) || 0,
    failed_files: Number(report && report.failedCount) || 0,
    missing_files: missing.length,
    mismatched_files: mismatch.length,
    unverifiable_files: Number(report && report.unverifiableCount) || 0,
    extra_files: Number(report && report.extraCount) || 0,
    valid: !!(report && report.valid),
    categories: { missing, mismatch, unverifiable, extra },
    details,
  };
}

function resolveBackupSelection(root, rawGroup, rawBackupId) {
  const group = String(rawGroup || '').trim();
  const backupId = String(rawBackupId || '').trim();
  const componente = value => /^[\w.-]+$/.test(value) && !value.endsWith('.') && value.length <= 255
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
  if (!componente(group) || !componente(backupId)) {
    throw new Error('Parametri "group" o "backup_id" non validi: usa i valori restituiti da list_backups.');
  }
  const base = path.resolve(root);
  const backupDir = path.resolve(base, group, backupId);
  const relative = path.relative(base, backupDir);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Percorso del backup non consentito: la selezione deve restare nella cartella backup del tenant.');
  }
  return { group, backupId, backupDir };
}

function registraStrumentiArtefatti({
  tool, session, deps, env, audit, confirmFlow, backupRootOf,
  requireDbSession, sessionPrincipal, refreshWritesAllowed, eseguiImport = eseguiPianoImport,
}) {
  tool('backup_database', {
    title: 'Backup di un database',
    description:
      'Esegue il backup di un database della connessione aperta (MongoDB o MySQL) nella cartella backups/ del server, ' +
      'con lo stesso motore della CLI (npm run backup): file NDJSON Extended JSON compressi gzip, checksum SHA-256, ' +
      'manifest e catalogo. "type": full (tutto), incremental (modifiche dall\'ultimo backup), differential ' +
      '(modifiche dall\'ultimo full); incremental/differential richiedono un backup full precedente. ' +
      'Senza "since_field" confrontano il contenuto completo e salvano solo le righe cambiate; senza identità stabile salvano una snapshot completa. ' +
      '"since_field" applica invece un filtro temporale esplicito: le modifiche che non aggiornano il campo restano escluse. ' +
      'I manifest v6 registrano la copertura, le entità rimosse e le cancellazioni per identità. ' +
      'L\'operazione legge soltanto dal database; l\'attività è registrata in backups/backup.log.',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Database da salvare'),
      type: z.enum(['full', 'incremental', 'differential']).optional().describe('Tipo di backup (default: full)'),
      collections: z.string().optional().describe('Elenco separato da virgole per limitare il backup ad alcune collection/tabelle'),
      since_field: z.string().optional().describe('Filtro temporale esplicito (es. updatedAt); omettere per confrontare il contenuto indipendentemente dalle date'),
      storage: z.string().optional().describe('Alias di una destinazione cloud pre-approvata dal server (CODEDB_BACKUP_STORAGE). Non è un URI: gli URI arbitrari non sono accettati.'),
      no_compress: z.boolean().optional().describe('Disabilita la compressione gzip dei file dati'),
      compress_level: z.number().int().min(1).max(9).optional().describe('Livello di compressione gzip (1-9, default: 1 per velocità massima)'),
      slack_webhook: z.string().optional().describe('URL Webhook Slack personalizzato per la notifica'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => {
    const sess = requireDbSession(args.connection_id);
    if (!canWholeConnection(sessionPrincipal(session), sess.name, 'read')) {
      throw new Error(`Permesso negato: la API key usata non può eseguire backup della connessione "${sess.name}".`);
    }
    const db = String(args.db || '').trim();
    if (!db) throw new Error('Parametro "db" mancante.');
    const type = String(args.type || 'full').toLowerCase();
    const onlyCollections = parseCollectionSelection(args.collections);
    const storageUrl = resolveStorageAlias(args.storage, env);
    if (storageUrl && !canWholeConnection(sessionPrincipal(session), sess.name, 'manage')) {
      throw new Error(`Permesso negato: la API key usata non può inviare backup della connessione "${sess.name}" su storage remoto.`);
    }
    const storage = parseStorage(storageUrl);
    const webhook = resolveSlackWebhook(args.slack_webhook, env);
    const level = Math.min(Math.max(parseInt(args.compress_level, 10) || 1, 1), 9);
    const compress = !args.no_compress;

    const destRoot = backupRootOf(session);
    const log = createLogger(path.join(destRoot, 'backup.log'), { quiet: true });
    const auditBase = { sessionId: session.id, connection: sess.name, dbType: sess.dbType, operation: 'backup', db, type };
    try {
      const summary = await log.run(`backup ${type} conn=${sess.name} db=${db} (via MCP)`, async () => {
        const result = await runBackup({
          session: sess, connName: sess.name, db, type, onlyCollections,
          origine: origineSessione(deps, sessionPrincipal(session), sess.name, sess.backupOriginId),
          sinceField: args.since_field ? String(args.since_field).trim() : null,
          destRoot, compress, level, log,
        });
        if (storage) await uploadBackupDir(storage, result.backupDir, log);
        return result;
      });
      audit({ ...auditBase, event: 'executed', backupId: summary.id });
      await notifySlack(webhook, `✅ CodeDB backup *${type}* di \`${db}\` (${sess.name}, via MCP) riuscito: ${summary.totalDocs} documenti/righe, ${formatBytes(summary.totalBytes)}.`, log);
      return jsonResult({
        backup_id: summary.id,
        group: path.basename(path.dirname(summary.backupDir)),
        dir: summary.backupDir,
        collections: summary.collections,
        docs: summary.totalDocs,
        bytes: summary.totalBytes,
      });
    } catch (err) {
      audit({ ...auditBase, event: 'failed', error: errMsg(err) });
      await notifySlack(webhook, `❌ CodeDB backup *${type}* di \`${db}\` (${sess.name}, via MCP) FALLITO: ${errMsg(err)}`, log);
      throw err;
    }
  });

  tool('list_backups', {
    title: 'Elenca i backup',
    description:
      'Elenca i backup presenti nella cartella backups/ del server (creati dalla CLI o via MCP), raggruppati per ' +
      'connessione_database. Ogni voce ha id, tipo (full/incremental/differential), db, dbType, date e backup di base. ' +
      'Usa "group" e "backup_id" restituiti qui come parametri di restore_backup.',
    inputSchema: {
      group: z.string().optional().describe('Limita a un gruppo, es. "mongo-locale_shop"'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ group }) => {
    const groups = {};
    const root = backupRootOf(session);
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (group && entry.name !== String(group).trim()) continue;
        const { backups } = readCatalog(path.join(root, entry.name));
        const visibili = filtraCatalogo(backups, path.join(root, entry.name), sessionPrincipal(session), root, deps);
        if (visibili.length) groups[entry.name] = visibili;
      }
    }
    return jsonResult({ groups });
  });

  tool('verify_backup', {
    title: 'Verifica i checksum SHA-256 di un backup',
    description:
      'Verifica i checksum SHA-256 dei file di dati di un backup presente nella cartella backups/ del server per accertarsi che non sia corrotto o incompleto.',
    inputSchema: {
      group: z.string().describe('Gruppo del backup, es. "mongo-locale_shop" (vedi list_backups)'),
      backup_id: z.string().describe('Id del backup, es. "20260714-100000_full" (vedi list_backups)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => {
    const { group, backupId, backupDir } = resolveBackupSelection(
      backupRootOf(session), args.group, args.backup_id,
    );
    verificaOrigine(sessionPrincipal(session), backupDir, null, backupRootOf(session), deps);
    if (!fs.existsSync(path.join(backupDir, 'manifest.json'))) {
      throw new Error(`Backup "${group}/${backupId}" non trovato: verifica con list_backups.`);
    }
    return jsonResult(backupVerificationPayload(await verifyBackupDir(backupDir)));
  });

  tool('restore_backup', {
    title: 'Ripristina un backup (con conferma)',
    description:
      'Ripristina un database da un backup della cartella backups/ del server, in due passaggi come execute_write. ' +
      'Funziona solo su connessioni salvate con readOnly=false esplicito in connections.ini. ' +
      'Primo passo: chiama SENZA confirm_token per avere l\'anteprima (catena di layer, database di destinazione) e il token. ' +
      'Mostra l\'anteprima all\'utente umano e richiama col token solo dopo la sua approvazione esplicita: NON confermare mai di tua iniziativa. ' +
      'Se il backup è incrementale/differenziale la catena fino al full viene applicata in ordine (i layer successivi al primo come upsert). ' +
      '"collections" limita il ripristino ad alcune collection/tabelle; "drop" elimina le collection/tabelle di destinazione prima di ricrearle.',
    inputSchema: {
      connection_id: z.string(),
      group: z.string().describe('Gruppo del backup, es. "mongo-locale_shop" (vedi list_backups)'),
      backup_id: z.string().describe('Id del backup, es. "20260714-100000_full" (vedi list_backups)'),
      target_db: z.string().optional().describe('Database di destinazione (default: quello di origine del backup)'),
      collections: z.string().optional().describe('Elenco separato da virgole per il restore selettivo'),
      drop: z.boolean().optional().describe('Elimina le collection/tabelle di destinazione prima del ripristino'),
      confirm_token: z.string().optional().describe('Token restituito dal primo passo, da inviare solo dopo la conferma esplicita dell\'utente umano'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (args) => {
    const sess = requireDbSession(args.connection_id);
    if (!refreshWritesAllowed(session, sess, deps)) {
      throw new Error(`La connessione "${sess.name}" è in sola lettura: il restore scrive sul database e richiede readOnly=false in connections.ini (vedi set_connection_read_only).`);
    }
    if (!canWholeConnection(sessionPrincipal(session), sess.name, 'manage')) {
      throw new Error(`Permesso negato: la API key usata non può ripristinare backup sulla connessione "${sess.name}".`);
    }
    const { group, backupId, backupDir } = resolveBackupSelection(
      backupRootOf(session), args.group, args.backup_id,
    );
    const requestedCollections = parseCollectionSelection(args.collections);
    const filtraErroreOrigine = err => erroreVerificaOrigine(err, sessionPrincipal(session), backupDir, backupRootOf(session), deps);
    const verificaSorgente = () => verificaOrigine(sessionPrincipal(session), backupDir, requestedCollections, backupRootOf(session), deps);
    verificaSorgente();
    if (!fs.existsSync(path.join(backupDir, 'manifest.json'))) {
      throw new Error(`Backup "${group}/${backupId}" non trovato: verifica con list_backups.`);
    }
    confirmFlow.sweep();
    const auditBase = { sessionId: session.id, connection: sess.name, dbType: sess.dbType, operation: 'restore', group, backupId };

    const token = String(args.confirm_token || '').trim();
    if (token) {
      const pending = confirmFlow.consume(token, 'restore', (p) => p.connectionId === String(args.connection_id)
        && p.group === group && p.backupId === backupId
        && p.plan.targetDb === (String(args.target_db || '').trim() || p.sourceDb)
        && p.plan.drop === !!args.drop
        && JSON.stringify(p.onlyCollections) === JSON.stringify(requestedCollections), 'piano/backup/connessione');
      const log = createLogger(path.join(backupRootOf(session), 'backup.log'), { quiet: true });
      try {
        const adapter = createBackupRestoreAdapter({
          strategy: sess.strategy, dbType: sess.dbType, connName: sess.name,
          verificaSorgente, filtraErroreOrigine,
          recoveryRoot: path.join(backupRootOf(session), 'import-recovery'), log,
        });
        const result = await log.run(`restore conn=${sess.name} da=${group}/${backupId} (via MCP)`, () => (
          eseguiPianoImport(pending.plan, { adapter })
        ));
        const docs = (result.verification && result.verification.snapshot
          && result.verification.snapshot.counts || []).reduce((sum, item) => sum + item.cardinality, 0);
        const summary = { targetDb: pending.plan.targetDb, totalDocs: docs, layers: pending.plan.source.layers.length };
        const publicResult = sanitizeImportResult(result);
        audit({ ...auditBase, group: pending.group, backupId: pending.backupId,
          event: result.status, targetDb: summary.targetDb, docs: summary.totalDocs });
        await notifySlack(env.SLACK_WEBHOOK_URL,
          `${result.status === 'completato' ? '✅' : '❌'} CodeDB restore ${result.status} di \`${summary.targetDb}\` (${sess.name}, via MCP): ${summary.totalDocs} documenti/righe.`, log);
        return jsonResult({ executed: result.status === 'completato', target_db: summary.targetDb,
          layers: summary.layers, docs: summary.totalDocs, ...publicResult });
      } catch (err) {
        audit({ ...auditBase, event: 'failed', error: errMsg(err) });
        await notifySlack(env.SLACK_WEBHOOK_URL, `❌ CodeDB restore da \`${group}/${backupId}\` (${sess.name}, via MCP) FALLITO: ${errMsg(err)}`, log);
        throw err;
      }
    }

    const chain = resolveChain(backupDir);
    const first = chain[0].manifest;
    if (first.dbType !== sess.dbType) {
      throw new Error(`Il backup è di tipo "${first.dbType}" ma la connessione è "${sess.dbType}".`);
    }
    const onlyCollections = requestedCollections;
    const targetDb = String(args.target_db || '').trim() || first.db;
    const source = descriviBackup(backupDir, onlyCollections, { filtraErroreOrigine });
    const plan = creaPianoRestore({
      source, expectedDbType: sess.dbType, connection: sess.name,
      targetDb, drop: !!args.drop,
    });
    audit({ ...auditBase, event: 'requested', targetDb });
    return confirmFlow.issue('restore', {
      connectionId: String(args.connection_id), plan, group, backupId,
      sourceDb: first.db, onlyCollections,
    }, {
      toolName: 'restore_backup',
      preview: {
        catena: chain.map((l) => l.manifest.id),
        target_db: targetDb,
        collections: onlyCollections || 'tutte',
        drop: !!args.drop,
        fingerprint: plan.fingerprint,
      },
    });
  });

  tool('import_database_artifact', {
    title: 'Importa un export CodeDB (con conferma)',
    description:
      'Importa un file .codedb.json attraverso lo stesso motore di piano, staging, verifica e recupero usato dalla UI e dalla CLI. ' +
      'Primo passo senza confirm_token: restituisce piano, identita, strategia e token. Mostrali all’utente umano. ' +
      'Richiama con confirm_token soltanto dopo approvazione esplicita; non confermare autonomamente.',
    inputSchema: {
      connection_id: z.string(),
      artifact_json: z.string().describe('Contenuto integrale del file .codedb.json'),
      target_db: z.string(),
      drop: z.boolean().optional(),
      confirm_token: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (args) => {
    const sess = requireDbSession(args.connection_id);
    if (!refreshWritesAllowed(session, sess, deps)) {
      throw new Error(`La connessione "${sess.name}" è in sola lettura: l'import richiede readOnly=false.`);
    }
    if (!canWholeConnection(sessionPrincipal(session), sess.name, 'manage')) {
      throw new Error(`Permesso negato: la API key non può importare database sulla connessione "${sess.name}".`);
    }
    const plan = creaPianoImport({
      artifact: args.artifact_json, expectedDbType: sess.dbType,
      connection: sess.name, targetDb: args.target_db, drop: !!args.drop,
    });
    const token = String(args.confirm_token || '').trim();
    if (!token) {
      audit({ sessionId: session.id, connection: sess.name, operation: 'import', event: 'requested', targetDb: plan.targetDb });
      return confirmFlow.issue('import', {
        connectionId: String(args.connection_id), fingerprint: plan.fingerprint,
      }, {
        toolName: 'import_database_artifact',
        preview: {
          fingerprint: plan.fingerprint,
          connection: plan.connection,
          target_db: plan.targetDb,
          collections: plan.collections,
          views: plan.views,
          promotion: plan.promotion,
          drop: plan.drop,
        },
      });
    }
    confirmFlow.consume(
      token, 'import', (p) => p.connectionId === String(args.connection_id)
        && p.fingerprint === plan.fingerprint, 'piano/connessione',
    );
    const log = createLogger(path.join(backupRootOf(session), 'backup.log'), { quiet: true });
    const adapter = createImportArtifactAdapter({
      strategy: sess.strategy, dbType: sess.dbType, connName: sess.name,
      recoveryRoot: path.join(backupRootOf(session), 'import-recovery'), log,
    });
    const result = await eseguiImport(plan, { adapter });
    audit({
      sessionId: session.id, connection: sess.name, operation: 'import',
      event: result.status, targetDb: plan.targetDb, error: result.error,
    });
    return jsonResult({ executed: result.status === 'completato', ...sanitizeImportResult(result) });
  });
}

module.exports = {
  registraStrumentiArtefatti,
  resolveBackupSelection,
  backupVerificationPayload,
};

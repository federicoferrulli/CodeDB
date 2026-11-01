'use strict';

// CodeDB — eventi-backup. Stato e dipendenze appartengono alla singola istanza.
const { resolveStorageAlias, resolveSlackWebhook } = require('../backup/lib/policy');
const { parseStorage, uploadBackupDir } = require('../backup/lib/storage');
const { createLogger, formatDuration } = require('../backup/lib/logger');
const path = require('path');
const { runBackup } = require('../backup/lib/engine');
const { notifySlack } = require('../backup/lib/notify');
const { readCatalog, verifyBackupDir, formatBytes, parseCollectionSelection } = require('../backup/lib/util');
const fs = require('fs');
const { runRestoreViaPlan } = require('../db/backupRestoreAdapter');
const { createRestoreOperationRegistry, sanitizeRestoreResult, improntaRipristino } = require('../db/restoreOperations');

function createModule({ lock, identita, operazioni, audit, errori, config }) {
  // Anche le giunture leggere usano un registro per istanza, condiviso fra
  // socket; il server completo lo possiede e lo chiude in operazioni.
  const restoreOperations = operazioni.restoreOperations ||= createRestoreOperationRegistry();
  function registra(socketContext, lifecycle) {
    const backups = new Map();
    // --- Operazioni Backup & Restore -------------------------------------------

    lifecycle.safeOn('backup:run', async (payload, cb) => {
      const tabId = lock.normTabId(payload.tabId);
      const sess = socketContext.sessions.get(tabId);
      if (!sess) throw new Error('Nessuna connessione attiva per questo tab.');
      // Il motore di backup legge dal driver nativo (strategy.client/pool), fuori
      // dalla portata del Proxy autorizzante: qui si pretende quindi la lettura
      // sull'INTERA connessione, senza scope db/collezione.
      identita.assertWholeConnection(socketContext.principal, sess.connName, 'read', 'eseguire un backup');
      const db = String(payload.db || '').trim();
      if (!db) throw new Error('Nome database mancante.');
      const type = String(payload.type || 'full').toLowerCase();
      if (!['full', 'incremental', 'differential'].includes(type)) {
        throw new Error(`Tipo backup non valido: ${type}`);
      }
      const onlyCollections = parseCollectionSelection(payload.collections);
      const destRoot = operazioni.resolveBackupPath(socketContext.principal, payload.dest, 'destinazione');
      // La destinazione cloud non arriva mai dal client: solo alias pre-approvati.
      const storageUrl = resolveStorageAlias(payload.storage, config.env);
      // Portare una copia integrale del database fuori dal perimetro è un atto
      // amministrativo, non una lettura: la sola capability `read` non basta.
      if (storageUrl) {
        identita.assertWholeConnection(socketContext.principal, sess.connName, 'manage', 'inviare un backup su storage remoto');
      }
      const storage = parseStorage(storageUrl);
      const webhook = resolveSlackWebhook(payload.slackWebhook, config.env);
      const log = createLogger(path.join(destRoot, 'backup.log'), { quiet: true });
      // Stesso valore predefinito della CLI (CDB-54): quando il client non lo
      // indica vale 6, non 1. Prima i due canali comprimevano in modo diverso a
      // parità di richiesta, quindi due backup "uguali" avevano dimensioni molto
      // diverse a seconda di chi li avesse lanciati, senza che nulla lo dicesse.
      const level = Math.min(Math.max(parseInt(payload.compressLevel, 10) || 6, 1), 9);
      const compress = payload.noCompress !== true;

      const t0 = Date.now();
      // Il nome del GRUPPO (`<conn>_<db>` sul disco) viene dalla SESSIONE, mai dal
      // client: è il nome su cui poggiano davvero i permessi. Con il valore del
      // payload — mai confrontato con sess.connName — safeName impediva il path
      // traversal ma non impediva di scegliere il nome del gruppo di un altro
      // tenant e di aggiungervi backup e voci di catalogo. Quello del client
      // resta solo come etichetta nel log.
      const connName = sess.connName || payload.connName || payload.label || 'ui-session';
      const operationId = payload.operationId ?? require('crypto').randomUUID();
      if (typeof operationId !== 'string' || !/^[\w-]{1,80}$/.test(operationId)) throw new Error('Identificatore del backup non valido.');
      if (backups.has(operationId)) throw new Error('Questo backup è già in corso.');
      const controller = new AbortController();
      backups.set(operationId, { controller, sess, tabId });
      lifecycle.acquisisciLeaseOperazione?.(sess);
      const onProgress = event => socketContext.socket.emit('backup:progress', { ...event, tabId, operationId, tipo: 'backup' });
      let copiaLocale = null;
      try {
        const summary = await log.run(`backup ${type} conn=${connName} db=${db} (via UI)`, async () => {
          const result = await runBackup({
            session: { strategy: sess.strategy, dbType: sess.dbType || sess.strategy.type }, connName, db, type, onlyCollections,
            sinceField: payload.sinceField ? String(payload.sinceField).trim() : null,
            destRoot, compress, level, log, signal: controller.signal, onProgress,
          });
          copiaLocale = result;
          if (storage) {
            onProgress({ phase: 'upload', count: result.totalDocs });
            await uploadBackupDir(storage, result.backupDir, log, { signal: controller.signal });
          }
          return result;
        });
        await notifySlack(webhook, `✅ CodeDB backup *${type}* di \`${db}\` (${connName}, via UI) riuscito in ${formatDuration(Date.now() - t0)}: ${summary.totalDocs} documenti/righe, ${formatBytes(summary.totalBytes)}.`, log);
        audit.auditWrite(sess, 'backup:run', { db }, { op: 'Backup', backupType: type, backupId: summary.id }, 'ok', summary, null);
        cb({ ok: true, summary });
      } catch (err) {
        if (controller.signal.aborted) {
          audit.auditWrite(sess, 'backup:run', { db }, { op: 'Backup annullato', backupType: type }, 'error', copiaLocale, err);
          cb({ ok: true, cancelled: true, summary: copiaLocale });
          return;
        }
        await notifySlack(webhook, `❌ CodeDB backup *${type}* di \`${db}\` (${connName}, via UI) FALLITO dopo ${formatDuration(Date.now() - t0)}: ${errori.errMsg(err)}`, log);
        audit.auditWrite(sess, 'backup:run', { db }, { op: 'Backup', backupType: type }, 'error', null, err);
        throw err;
      } finally {
        backups.delete(operationId);
        await lifecycle.rilasciaLeaseOperazione?.(sess);
      }
    });

    lifecycle.safeOn('backup:cancel', (payload, cb) => {
      const backup = backups.get(payload.operationId);
      if (!backup || backup.tabId !== lock.normTabId(payload.tabId)) { cb({ ok: true, cancelled: false }); return; }
      const sess = backup.sess;
      identita.assertWholeConnection(socketContext.principal, sess.connName, 'read', 'annullare un backup');
      backup.controller.abort(new Error('Backup annullato.'));
      cb({ ok: true, cancelled: true });
    });

    lifecycle.safeOn('backup:list', ({ dest }, cb) => {
      identita.assertManage(socketContext.principal);
      // La radice è quella del tenant: `manage` è l'amministratore del PROPRIO
      // account, non dell'installazione, e senza partizione questo elenco
      // rivelerebbe i gruppi <connessione>_<database> di tutti gli altri.
      const destRoot = operazioni.resolveBackupPath(socketContext.principal, dest, 'elenco');
      const groups = {};
      if (fs.existsSync(destRoot)) {
        for (const entry of fs.readdirSync(destRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const { backups } = readCatalog(path.join(destRoot, entry.name));
          if (backups.length) groups[entry.name] = backups;
        }
      }
      cb({ ok: true, groups });
    });

    lifecycle.safeOn('backup:restore', async (payload, cb) => {
      const tabId = lock.normTabId(payload.tabId);
      const operationId = payload.operationId ?? require('crypto').randomUUID();
      if (typeof operationId !== 'string' || !/^[\w-]{1,80}$/.test(operationId)) {
        throw new Error('Identificatore del ripristino non valido.');
      }
      const sess = socketContext.sessions.get(tabId);
      if (!sess || sess.closed) throw new Error('Nessuna connessione attiva per questo tab.');
      // Il restore riscrive interi database: operazione da amministratore.
      identita.assertWholeConnection(socketContext.principal, sess.connName, 'manage', 'ripristinare un backup');

      // group/backupId sono nomi restituiti da backup:list, quindi vanno risolti
      // nella radice del tenant: altrimenti basta indicarne uno di un altro owner.
      let backupDir = payload.from ? operazioni.resolveBackupPath(socketContext.principal, payload.from, 'origine') : null;
      if (!backupDir && payload.group && payload.backupId) {
        const group = String(payload.group).trim();
        const backupId = String(payload.backupId).trim();
        if (!/^[\w.-]+$/.test(group) || !/^[\w.-]+$/.test(backupId)) {
          throw new Error('Parametri "group" o "backupId" non validi.');
        }
        backupDir = operazioni.resolveBackupPath(socketContext.principal,
          path.join(operazioni.backupRootOf(socketContext.principal), group, backupId), 'origine');
      }
      if (!backupDir || !fs.existsSync(path.join(backupDir, 'manifest.json'))) {
        throw new Error('Cartella backup non valida o manifest.json mancante.');
      }
      backupDir = fs.realpathSync(backupDir);

      const destRoot = operazioni.resolveBackupPath(socketContext.principal, payload.dest, 'destinazione');
      const webhook = resolveSlackWebhook(payload.slackWebhook, config.env);
      const onlyCollections = parseCollectionSelection(payload.collections)?.sort() || null;
      const targetDb = String(payload.targetDb || '').trim() || null;
      const drop = !!payload.drop;
      const recoveryRoot = path.join(operazioni.backupRootOf(socketContext.principal), 'import-recovery');

      const t0 = Date.now();
      // Solo etichetta per il log: il bersaglio del ripristino è `backupDir`, già
      // confinato da resolveBackupPath dentro la radice del tenant.
      const connName = sess.connName || sess.label || 'ui-session';
      const dbType = sess.dbType || sess.strategy.type;
      const backupId = String(payload.backupId || path.basename(backupDir));
      const ownerId = socketContext.principal.ownerId, actorId = socketContext.principal.id;
      const fingerprint = improntaRipristino({ connection: connName, dbType, backupDir, targetDb, drop,
        collections: onlyCollections, recoveryRoot });
      const ack = await restoreOperations.start({ operationId, ownerId, actorId, tabId, connection: connName, backupId,
        targetDb, fingerprint, execute: async progress => {
      lifecycle.acquisisciLeaseOperazione?.(sess);
      let log;
      let redact = value => String(value);
      try {
      // Credenziali e percorsi servono soltanto durante l'esecuzione. Si
      // redigono messaggi e ricevute prima di conservarli nel registro.
      const secrets = Object.entries(sess.effectiveCfg || {}).filter(([key, value]) => typeof value === 'string' && value
        && /password|passphrase|secret|token|uri/i.test(key)).map(([, value]) => value);
      const privatePaths = [backupDir, destRoot, recoveryRoot].filter(Boolean).sort((a, b) => b.length - a.length);
      redact = value => [...secrets, ...privatePaths].reduce((text, secret) => text.split(secret).join('[riservato]'), String(value))
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[riservato]@');
      log = createLogger(path.join(destRoot, 'backup.log'), { quiet: true });

      // Il ripristino di un database vero dura minuti, e l'ack arriva solo alla
      // fine: senza un segnale intermedio il pulsante gira e basta, e non c'è modo
      // di distinguere "sta lavorando" da "si è piantato". Le righe che
      // `runRestore` scrive già nel log — catena risolta, database di
      // destinazione, una per collection e per layer — SONO il progresso che
      // serve: le si intercetta invece di aprire un secondo canale, così
      // backup/lib resta intatto e la CLI si comporta esattamente come prima.
      const inviaProgresso = (riga, errore) => {
        const event = { tabId, backupId, operationId, riga: redact(riga), errore: !!errore };
        progress(event);
        try { socketContext.socket.emit('backup:progress', event); } catch (_) { /* la UI non governa il lavoro accettato */ }
      };
      const logUi = {
        ...log,
        info: (msg) => { log.info(msg); inviaProgresso(msg, false); },
        error: (msg) => { log.error(msg); inviaProgresso(msg, true); },
      };

        const summary = await log.run(`restore conn=${connName} da=${path.basename(backupDir)} (via UI)`, async () => {
          return await runRestoreViaPlan({
            session: { strategy: sess.strategy, dbType }, backupDir,
            targetDb,
            // Il DDL del backup viene eseguito sul database: dall'interfaccia non
            // si può scavalcare la validazione, la deroga resta solo nella CLI.
            onlyCollections, drop, log: logUi, connName, recoveryRoot,
            onProgress: (event) => { progress(event); inviaProgresso(`${event.phase} ${event.status}`, false); },
          });
        });
        const publicResult = sanitizeRestoreResult(summary, redact);
        if (summary.status === 'completato') {
          await notifySlack(webhook, `✅ CodeDB restore di \`${summary.targetDb}\` (${connName}, via UI) riuscito in ${formatDuration(Date.now() - t0)}: ${summary.totalDocs} documenti/righe.`, log);
          audit.auditWrite(sess, 'backup:restore', { db: summary.targetDb }, { op: 'Ripristino backup', backupId: String(payload.backupId || '').trim() || undefined }, 'ok', publicResult, null);
        } else {
          await notifySlack(webhook, `❌ CodeDB restore ${summary.status} di \`${summary.targetDb}\` (${connName}, via UI): ${summary.error || 'esito non completato'}`, log);
          audit.auditWrite(sess, 'backup:restore', { db: summary.targetDb }, { op: 'Ripristino backup', backupId: String(payload.backupId || '').trim() || undefined }, 'error', publicResult, summary.originalError);
        }
        return { ok: true, summary: publicResult };
      } catch (err) {
        if (log) await notifySlack(webhook, `❌ CodeDB restore (${connName}, via UI) FALLITO dopo ${formatDuration(Date.now() - t0)}: ${errori.errMsg(err)}`, log);
        // Un ripristino incompleto porta con sé il riepilogo parziale (quante righe
        // erano state applicate prima di fermarsi): va nell'audit, serve a capire
        // in che stato è rimasto il database di destinazione.
        audit.auditWrite(sess, 'backup:restore', { db: (err.summary && err.summary.targetDb) || payload.targetDb || null }, { op: 'Ripristino backup', backupId: String(payload.backupId || '').trim() || undefined }, 'error', err.summary || null, err);
        return { ok: false, error: redact(errori.errMsg(err)) };
      } finally {
        await lifecycle.rilasciaLeaseOperazione?.(sess);
      }
      } });
      cb(ack);
    });

    lifecycle.safeOn('backup:restore:state', (payload, cb) => {
      const principal = socketContext.principal;
      const operation = restoreOperations.get(payload.operationId, principal.ownerId, principal.id);
      identita.assertWholeConnection(principal, operation.connection, 'manage', 'vedere lo stato di un ripristino');
      cb({ ok: true, operation });
    });

    lifecycle.safeOn('backup:restore:list', (_payload, cb) => {
      const principal = socketContext.principal;
      const operations = restoreOperations.list(principal.ownerId, principal.id).filter(operation => {
        try { identita.assertWholeConnection(principal, operation.connection, 'manage', 'vedere i ripristini recuperabili'); return true; }
        catch (_) { return false; }
      });
      cb({ ok: true, operations });
    });

    lifecycle.safeOn('backup:verify', async (payload, cb) => {
      identita.assertManage(socketContext.principal);
      let backupDir = payload.from ? operazioni.resolveBackupPath(socketContext.principal, payload.from, 'origine') : null;
      if (!backupDir && payload.group && payload.backupId) {
        const group = String(payload.group).trim();
        const backupId = String(payload.backupId).trim();
        if (!/^[\w.-]+$/.test(group) || !/^[\w.-]+$/.test(backupId)) {
          throw new Error('Parametri "group" o "backupId" non validi.');
        }
        backupDir = path.join(operazioni.backupRootOf(socketContext.principal), group, backupId);
      }
      if (!backupDir || !fs.existsSync(path.join(backupDir, 'manifest.json'))) {
        throw new Error('Cartella backup non trovata o manifest.json mancante.');
      }
      const report = await verifyBackupDir(backupDir);
      cb({
        ok: true,
        backupId: report.backupId,
        okCount: report.okCount,
        failedCount: report.failedCount,
        unverifiableCount: report.unverifiableCount,
        extraCount: report.extraCount,
        valid: report.valid,
        details: report.details,
      });
    });
  }

  return registra;
}

module.exports = { createModule };

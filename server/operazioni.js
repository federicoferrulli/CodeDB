'use strict';

// CodeDB — operazioni. Stato e dipendenze appartengono alla singola istanza.
const path = require('path');
const { createImportOperationRegistry } = require('../db/importOperations');
const { createImportUploadRegistry } = require('../db/importUploads');
const { resolveBackupPath: confineBackupPath, backupRootFor } = require('../backup/lib/policy');
const { pianoRinomina, improntaDatabase, confrontaStatoCorrente } = require('../db/rinominaSicura');
const fs = require('fs');
const os = require('os');
const { createLogger } = require('../backup/lib/logger');
const { runBackup } = require('../backup/lib/engine');
const { runRestore } = require('../backup/lib/restore');

function createModule({ config, identita }) {
  const BACKUP_ROOT = config.env.CODEDB_BACKUPS_DIR || path.join(config.rootDir, 'backups');

  const importOperations = createImportOperationRegistry();

  const importUploads = createImportUploadRegistry({
    maxBytes: Number(config.env.CODEDB_MAX_IMPORT_BYTES) || 64 * 1024 * 1024,
    maxActive: Number(config.env.CODEDB_MAX_IMPORT_UPLOADS) || 4,
    maxPerOwner: Number(config.env.CODEDB_MAX_IMPORT_UPLOADS_PER_OWNER) || 2,
    maxTotalBytes: Number(config.env.CODEDB_MAX_IMPORT_TOTAL_BYTES) || Number(config.env.CODEDB_MAX_IMPORT_BYTES) || 64 * 1024 * 1024,
  });

  // Radice dei backup del tenant a cui appartiene il principal: con RBAC attivo
  // ogni owner ha la propria (`tenants/<ownerId>`), come per connections.ini.
  // Vedi backupRootFor in backup/lib/policy.js per il perché.
  const backupRootOf = (principal) =>
    backupRootFor(BACKUP_ROOT, principal && principal.ownerId, { rbac: config.rbacOn() });

  // Confina un percorso indicato dal client dentro la radice del SUO tenant.
  const resolveBackupPath = (principal, raw, what) => confineBackupPath(raw, backupRootOf(principal), what);

  /**
   * Rinomina un database su MongoDB e MySQL, che non hanno un comando nativo.
   *
   * Il percorso è dump → verifica → restore nel nuovo nome, cioè lo stesso
   * motore dei backup e non una copia scritta apposta. È una scelta deliberata:
   * la vecchia emulazione spostava le sole tabelle base (o copiava le collection)
   * e perdeva view, routine, trigger, eventi, validatori e opzioni, in silenzio.
   * Passando dal motore, la rinomina eredita checksum, verifica preventiva
   * dell'intera catena e ripristino degli oggetti di schema — e ogni
   * miglioramento futuro del backup vale anche qui.
   *
   * Cosa questa funzione NON può garantire, e per cui esiste `eliminaOrigine`:
   * dump e restore non sono atomici. Una scrittura che arriva nell'originale
   * mentre la copia è in corso non finisce nella destinazione. Per questo
   * l'originale non viene MAI eliminato per impostazione predefinita: chi
   * rinomina decide, dopo aver controllato.
   */
  async function rinominaViaDump(sess, dbOrigine, nuovoNome, { eliminaOrigine = false, principal } = {}) {
    if (!sess) throw new Error('Nessuna connessione attiva per questo tab.');
    const db = String(dbOrigine || '').trim();
    const nuovo = String(nuovoNome || '').trim();
    if (!db || !nuovo) throw new Error('Nome del database mancante.');
    if (db === nuovo) throw new Error('Il nuovo nome coincide con quello attuale.');

    const dbType = sess.dbType || sess.strategy.type;
    const piano = pianoRinomina(dbType, false);
    // La rinomina legge l'INTERO database dal driver nativo (fuori dal Proxy) e
    // ne crea un altro: è un'operazione amministrativa sulla connessione, non una
    // scrittura su una collection. Vedi la stessa scelta in backup:run.
    identita.assertWholeConnection(principal, sess.connName, 'manage', 'rinominare un database');

    const esistenti = await sess.strategy.listDatabases();
    if (esistenti.some((d) => String(d.name) === nuovo)) {
      throw new Error(
        `Esiste già un database "${nuovo}": scegli un altro nome, oppure eliminalo prima di rinominare.`
      );
    }

    // I file della rinomina non sono un backup dell'utente: vivono in una
    // cartella temporanea e spariscono comunque vada. Metterli fra i backup del
    // tenant sporcherebbe il catalogo con voci che nessuno ha chiesto.
    const destRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-rinomina-'));
    const log = createLogger(path.join(destRoot, 'rinomina.log'), { quiet: true });
    const connName = sess.connName || 'ui-session';
    try {
      const backup = await runBackup({
        session: { strategy: sess.strategy, dbType }, connName, db, type: 'full',
        onlyCollections: null, sinceField: null, destRoot, compress: true, level: 6, log,
      });

      // La destinazione va creata prima del restore: su MySQL il restore esegue
      // CREATE TABLE dentro uno schema che deve esistere.
      await sess.strategy.createDatabase(nuovo);

      const esito = await runRestore({
        session: { strategy: sess.strategy, dbType }, backupDir: backup.backupDir,
        targetDb: nuovo, drop: false, log,
      });

      // --- Barriera prima di qualunque eliminazione --------------------------
      //
      // Regola: l'originale si elimina SOLO dopo che la copia è stata dimostrata
      // completa. Non basta che il restore non abbia lanciato — un errore su una
      // singola riga (per esempio una geometria non reinseribile) può lasciare la
      // destinazione parziale — quindi si ricontrolla qui, in modo indipendente
      // dalla contabilità del restore, e ogni controllo che non torna è un
      // errore: `dropDatabase` sta DOPO, e un throw non ci arriva mai.
      if (esito.problems && esito.problems.length) {
        throw new Error(
          `Copia incompleta (${esito.problems.length} problemi): ${esito.problems.slice(0, 3).join('; ')}. `
          + `Il database "${db}" NON è stato toccato.`
        );
      }
      if (esito.totalDocs !== esito.expectedDocs) {
        throw new Error(
          `Copia incompleta: ${esito.totalDocs} di ${esito.expectedDocs} documenti/righe attesi. `
          + `Il database "${db}" NON è stato toccato; rimuovi "${nuovo}" e riprova.`
        );
      }
      // Controllo indipendente: le collection/tabelle presenti nell'originale
      // devono esistere anche nella copia. Il conteggio dei documenti non lo
      // dimostra — una tabella che non si è creata affatto dichiara zero righe
      // attese e zero applicate, e i totali tornano.
      const nomiDi = async (nome) => new Set(
        (await sess.strategy.listCollections(nome))
          .filter((c) => !String(c.name).startsWith('system.'))
          .map((c) => String(c.name))
      );
      const attese = await nomiDi(db);
      const ottenute = await nomiDi(nuovo);
      const mancanti = [...attese].filter((n) => !ottenute.has(n));
      if (mancanti.length) {
        throw new Error(
          `Copia incompleta: mancano ${mancanti.length} collection/tabelle nella destinazione `
          + `(${mancanti.slice(0, 5).join(', ')}). Il database "${db}" NON è stato toccato.`
        );
      }

      const verificaCorrente = confrontaStatoCorrente(
        await improntaDatabase(sess.strategy, db),
        await improntaDatabase(sess.strategy, nuovo)
      );
      // MongoDB e MySQL non offrono un lock di scrittura limitato al database
      // che chiuda la finestra dopo il confronto: l'origine resta sempre sana.
      const completata = verificaCorrente.ok && !eliminaOrigine;
      return {
        modo: 'dump-restore',
        piano,
        origine: db,
        destinazione: nuovo,
        documenti: esito.totalDocs,
        origineEliminata: false,
        completata,
        verificaCorrente,
        intervento: !verificaCorrente.ok
          ? `La sorgente è cambiata durante la copia. "${db}" e "${nuovo}" sono stati conservati: ripeti in una finestra senza scritture.`
          : (eliminaOrigine
            ? `Il motore ${dbType} non offre una rinomina atomica o un lock sicuro limitato al database. La copia è verificata, ma "${db}" è stato conservato e va rimosso in una finestra di manutenzione.`
            : null),
      };
    } finally {
      // I file temporanei se ne vanno sempre: riuscita o fallita, non sono un
      // backup che qualcuno andrà a cercare.
      try { fs.rmSync(destRoot, { recursive: true, force: true }); } catch { /* già sparita */ }
    }
  }

  return {
    importOperations,
    importUploads,
    backupRootOf,
    resolveBackupPath,
    rinominaViaDump
  };
}

module.exports = { createModule };

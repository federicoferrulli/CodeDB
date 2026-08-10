#!/usr/bin/env node
'use strict';

/* ---------------------------------------------------------------------------
 * codedb-backup — CLI di backup e ripristino per i database di CodeDB.
 *
 * Riusa le connessioni salvate in connections.ini (in SOLA lettura: questo
 * processo non riscrive mai il file) e le strategie MongoDB/MySQL di db/,
 * tunnel SSH compreso. `node backup/cli.js help` per la guida completa.
 * ------------------------------------------------------------------------- */

const path = require('path');
const fs = require('fs');
const { loadConnections, hasEncryptedSecrets, promptPassphrase } = require('./lib/connstore');
const { establishConnection, teardownConnection } = require('./lib/connect');
const { createLogger, formatDuration } = require('./lib/logger');
const { runBackup } = require('./lib/engine');
const { runRestore } = require('./lib/restore');
const { parseStorage, uploadBackupDir } = require('./lib/storage');
const { notifySlack } = require('./lib/notify');
const { readCatalog, readManifest, sha256File, formatBytes, fileDelBackup } = require('./lib/util');

// CODEDB_BACKUPS_DIR: stesso override rispettato dal gateway MCP (mcp/McpGateway.js),
// così CLI e MCP condividono la cartella di default anche nell'app Electron pacchettizzata.
const DEFAULT_DEST = process.env.CODEDB_BACKUPS_DIR || path.join(__dirname, '..', 'backups');

const HELP = `
codedb-backup — backup e ripristino dei database CodeDB (MongoDB e MySQL)

USO
  node backup/cli.js <comando> [opzioni]        (oppure: npm run backup -- <comando> [opzioni])

COMANDI
  backup     Esegue il backup di un database su cartella locale (ed eventuale cloud).
  restore    Ripristina un database da una cartella di backup (catena incrementale risolta da sola).
  list       Elenca i backup presenti nella cartella di destinazione.
  verify     Verifica i checksum SHA-256 dei file di un backup.
  help       Mostra questa guida.

OPZIONI COMUNI
  --conn <nome>            Connessione salvata in connections.ini (la CLI non legge mai credenziali da riga di comando).
  --owner <id>             Con RBAC attivo, tenant proprietario della connessione (o env CODEDB_OWNER_ID).
                           Senza, si legge il file condiviso: è il caso mono-utente.
  --dest <cartella>        Cartella radice dei backup (default: ./backups).
  --slack-webhook <url>    Webhook Slack per la notifica di fine operazione (o env SLACK_WEBHOOK_URL).
  --quiet                  Scrive solo sul file di log, non in console.

BACKUP
  --db <nome>              Database da salvare (obbligatorio).
  --type <tipo>            full | incremental | differential (default: full).
  --collections <a,b,...>  Limita il backup alle collection/tabelle indicate.
  --since-field <campo>    Campo data che individua le modifiche per incremental/differential
                           (senza: MongoDB usa il timestamp degli ObjectId — solo nuovi inserimenti;
                           MySQL cerca updated_at/created_at e simili, altrimenti dump completo della tabella).
  --no-compress            Disabilita la compressione gzip dei file dati.
  --compress-level <1-9>   Livello gzip (default: 6).
  --storage <dest>         Copia il backup anche su cloud: s3://bucket/prefisso,
                           gs://bucket/prefisso, azure://container/prefisso
                           (credenziali dai canali standard del provider; SDK da installare a parte).

RESTORE
  --from <cartella>        Cartella del backup da ripristinare (obbligatorio). Se è un backup
                           incrementale/differenziale, la catena fino al full viene applicata in ordine.
  --target-db <nome>       Database di destinazione (default: quello di origine del backup).
  --collections <a,b,...>  Restore selettivo delle sole collection/tabelle indicate.
  --drop                   Elimina la collection/tabella di destinazione prima del ripristino.
  --allow-unsafe-schema    Esegue il DDL del backup anche se non è una semplice definizione
                           della tabella attesa (usare solo su backup di provenienza certa).

ESEMPI
  node backup/cli.js backup  --conn mongo-locale --db shop --type full
  node backup/cli.js backup  --conn mongo-locale --db shop --type incremental --since-field updatedAt
  node backup/cli.js backup  --conn mysql-locale --db negozio --storage s3://miei-backup/codedb
  node backup/cli.js restore --conn mongo-locale --from backups/mongo-locale_shop/20260714-100000_full --target-db shop_copia
  node backup/cli.js restore --conn mysql-locale --from backups/mysql-locale_negozio/20260714-110000_incremental --drop
  node backup/cli.js list    --dest backups
  node backup/cli.js verify  --from backups/mongo-locale_shop/20260714-100000_full

NOTE
  - I log delle operazioni sono in <dest>/backup.log (inizio/fine, stato, durata, errori).
  - I backup incrementali/differenziali non catturano le cancellazioni.
  - Se connections.ini ha segreti cifrati serve la passphrase: env GUI_MONGO_PASSPHRASE o prompt.
`;

/* --- Parsing argomenti ----------------------------------------------------- */

const FLAGS = new Set(['--no-compress', '--drop', '--quiet', '--allow-unsafe-schema', '--help', '-h']);

/**
 * Opzioni con valore riconosciute. Sono esattamente quelle elencate nell'aiuto
 * qui sopra.
 *
 * Senza questo elenco ogni `--qualcosa valore` finiva in `args.qualcosa` e, se
 * nessun comando lo leggeva, veniva ignorato SENZA UNA PAROLA. Le opzioni di
 * `restore` che decidono la destinazione o l'ampiezza dell'operazione —
 * `--target-db`, `--collections`, `--since-field` — sono proprio quelle scritte
 * con un trattino interno o al plurale, cioè quelle in cui il refuso è più
 * facile: `--targetdb prova` non ripristinava su "prova", ripristinava in
 * silenzio sul database di ORIGINE.
 */
const OPZIONI = new Set([
  'conn', 'owner', 'dest', 'slack-webhook',
  'db', 'type', 'collections', 'since-field', 'compress-level', 'storage',
  'from', 'target-db',
]);

/** Distanza di edit, per suggerire l'opzione che l'utente intendeva scrivere. */
function distanza(a, b) {
  const m = a.length; const n = b.length;
  let prec = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prec[j] + 1, cur[j - 1] + 1, prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prec = cur;
  }
  return prec[n];
}

function suggerisci(chiave) {
  let migliore = null; let dist = Infinity;
  for (const o of [...OPZIONI, ...[...FLAGS].map((f) => f.replace(/^--?/, ''))]) {
    const d = distanza(chiave.toLowerCase(), o.toLowerCase());
    if (d < dist) { dist = d; migliore = o; }
  }
  // Oltre un terzo dei caratteri di differenza non è più un refuso.
  return dist <= Math.max(2, Math.ceil(chiave.length / 3)) ? migliore : null;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') && a !== '-h') {
      args._.push(a);
    } else if (FLAGS.has(a)) {
      args[a.replace(/^--?/, '')] = true;
    } else {
      const key = a.replace(/^--/, '');
      if (!OPZIONI.has(key)) {
        const forse = suggerisci(key);
        throw new Error(
          `Opzione sconosciuta: ${a}.${forse ? ` Forse intendevi --${forse}?` : ''}`
          + ' Vedi: node backup/cli.js help'
        );
      }
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) throw new Error(`Valore mancante per l'opzione ${a}.`);
      args[key] = val;
      i += 1;
    }
  }
  return args;
}

function requireOpt(args, name, hint) {
  const v = args[name];
  if (!v) throw new Error(`Opzione obbligatoria mancante: --${name}${hint ? ` (${hint})` : ''}. Vedi: node backup/cli.js help`);
  return v;
}

/* --- Connessione ----------------------------------------------------------- */

// Risolve la connessione salvata, chiedendo la passphrase solo se nel file
// ci sono segreti cifrati e GUI_MONGO_PASSPHRASE non è impostata.
async function resolveSavedConnection(name, ownerId) {
  let passphrase = process.env.GUI_MONGO_PASSPHRASE || null;
  if (!passphrase && hasEncryptedSecrets(ownerId)) {
    passphrase = await promptPassphrase('Passphrase dei segreti di connections.ini: ');
  }
  // `--owner` (o CODEDB_OWNER_ID) sceglie il file del tenant: con RBAC attivo le
  // connessioni non stanno più nel file condiviso (CDB-50).
  const sections = loadConnections(passphrase, ownerId);
  const cfg = sections[name];
  if (!cfg) {
    const known = Object.keys(sections);
    throw new Error(`Connessione salvata "${name}" non trovata.${known.length ? ` Disponibili: ${known.join(', ')}` : ''}`);
  }
  return cfg;
}

/* --- Comandi ---------------------------------------------------------------- */

async function cmdBackup(args) {
  const connName = requireOpt(args, 'conn', 'nome della connessione salvata');
  const db = requireOpt(args, 'db', 'database da salvare');
  const type = String(args.type || 'full').toLowerCase();
  if (!['full', 'incremental', 'differential'].includes(type)) {
    throw new Error(`Tipo di backup non valido: "${type}" (full | incremental | differential).`);
  }
  const destRoot = path.resolve(args.dest || DEFAULT_DEST);
  const storage = parseStorage(args.storage); // valida subito, prima di toccare il DB
  const webhook = args['slack-webhook'] || process.env.SLACK_WEBHOOK_URL;
  const log = createLogger(path.join(destRoot, 'backup.log'), { quiet: !!args.quiet });
  const level = Math.min(Math.max(parseInt(args['compress-level'], 10) || 6, 1), 9);
  const onlyCollections = args.collections ? args.collections.split(',').map((s) => s.trim()).filter(Boolean) : null;

  const cfg = await resolveSavedConnection(connName, args.owner);
  const t0 = Date.now();
  const label = `backup ${type} conn=${connName} db=${db}`;
  try {
    const summary = await log.run(label, async () => {
      const session = await establishConnection(cfg);
      try {
        const result = await runBackup({
          session, connName, db, type, onlyCollections,
          sinceField: args['since-field'] || null,
          destRoot, compress: !args['no-compress'], level, log,
        });
        if (storage) await uploadBackupDir(storage, result.backupDir, log);
        return result;
      } finally {
        await teardownConnection(session);
      }
    });
    log.info(`Backup completato: ${summary.id} — ${summary.collections} collection/tabelle, ${summary.totalDocs} documenti/righe, ${formatBytes(summary.totalBytes)} → ${summary.backupDir}`);
    await notifySlack(webhook, `✅ CodeDB backup *${type}* di \`${db}\` (${connName}) riuscito in ${formatDuration(Date.now() - t0)}: ${summary.totalDocs} documenti/righe, ${formatBytes(summary.totalBytes)}.`, log);
  } catch (err) {
    await notifySlack(webhook, `❌ CodeDB backup *${type}* di \`${db}\` (${connName}) FALLITO dopo ${formatDuration(Date.now() - t0)}: ${(err && err.message) || err}`, log);
    throw err;
  }
}

async function cmdRestore(args) {
  const connName = requireOpt(args, 'conn', 'connessione di destinazione');
  const backupDir = path.resolve(requireOpt(args, 'from', 'cartella del backup'));
  const destRoot = path.resolve(args.dest || DEFAULT_DEST);
  const webhook = args['slack-webhook'] || process.env.SLACK_WEBHOOK_URL;
  const log = createLogger(path.join(destRoot, 'backup.log'), { quiet: !!args.quiet });
  const onlyCollections = args.collections ? args.collections.split(',').map((s) => s.trim()).filter(Boolean) : null;

  const cfg = await resolveSavedConnection(connName, args.owner);
  const t0 = Date.now();
  const label = `restore conn=${connName} da=${path.basename(backupDir)}`;
  try {
    const summary = await log.run(label, async () => {
      const session = await establishConnection(cfg);
      try {
        return await runRestore({
          session, backupDir,
          targetDb: args['target-db'] || null,
          onlyCollections, drop: !!args.drop, log,
          allowUnsafeSchema: !!args['allow-unsafe-schema'],
        });
      } finally {
        await teardownConnection(session);
      }
    });
    log.info(`Restore completato su "${summary.targetDb}": ${summary.totalDocs} documenti/righe da ${summary.layers} layer.`);
    await notifySlack(webhook, `✅ CodeDB restore di \`${summary.targetDb}\` (${connName}) riuscito in ${formatDuration(Date.now() - t0)}: ${summary.totalDocs} documenti/righe.`, log);
  } catch (err) {
    // Ripristino incompleto: dire anche quanto è stato applicato prima di
    // fermarsi, perché il database di destinazione è in uno stato intermedio.
    if (err && err.summary) {
      log.error(`Ripristino su "${err.summary.targetDb}" INTERROTTO: ${err.summary.totalDocs} di ${err.summary.expectedDocs} documenti/righe applicati.`);
      for (const p of err.summary.problems || []) log.error(`  · ${p}`);
    }
    await notifySlack(webhook, `❌ CodeDB restore (${connName}) FALLITO dopo ${formatDuration(Date.now() - t0)}: ${(err && err.message) || err}`, log);
    throw err;
  }
}

function cmdList(args) {
  const destRoot = path.resolve(args.dest || DEFAULT_DEST);
  if (!fs.existsSync(destRoot)) {
    console.log(`Nessun backup: la cartella ${destRoot} non esiste.`);
    return;
  }
  let found = 0;
  for (const group of fs.readdirSync(destRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const { backups } = readCatalog(path.join(destRoot, group.name));
    if (!backups.length) continue;
    console.log(`\n${group.name}`);
    for (const b of backups) {
      console.log(`  ${b.id}  tipo=${b.type.padEnd(12)} db=${b.db} (${b.dbType})  ${b.startedAt} → ${b.endedAt}${b.baseId ? `  base=${b.baseId}` : ''}`);
      found += 1;
    }
  }
  if (!found) console.log(`Nessun backup trovato in ${destRoot}.`);
}

/**
 * File di dati/schema/indici presenti nella cartella del backup, in forma
 * relativa e con le barre normalizzate, per il confronto col manifest.
 * `manifest.json`, `catalog.json` e il log non sono file DICHIARATI: non
 * devono comparire fra gli "extra".
 */
function elencaFileBackup(backupDir) {
  const esclusi = new Set(['manifest.json', 'catalog.json', 'backup.log']);
  const out = [];
  const cammina = (dir, prefisso) => {
    let voci;
    try {
      voci = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // cartella sparita nel frattempo: lo dirà il ramo "MANCANTE"
    }
    for (const v of voci) {
      const rel = prefisso ? `${prefisso}/${v.name}` : v.name;
      if (v.isDirectory()) cammina(path.join(dir, v.name), rel);
      else if (!esclusi.has(rel)) out.push(rel);
    }
  };
  cammina(backupDir, '');
  return out;
}

async function cmdVerify(args) {
  const backupDir = path.resolve(requireOpt(args, 'from', 'cartella del backup'));
  const manifest = readManifest(backupDir);
  let ok = 0;
  let failed = 0;
  // Un file senza checksum non è "integro": è NON VERIFICABILE, ed è un'altra
  // cosa. Saltandolo in silenzio il rapporto diceva «N file integri, 0
  // problemi» anche su un backup di cui non era stato controllato nulla.
  const nonVerificabili = [];
  const dichiarati = new Set();

  for (const f of manifest.files) {
    dichiarati.add(String(f.path).replace(/\\/g, '/'));
    if (!f.sha256) {
      nonVerificabili.push(f.path);
      continue;
    }
    const full = fileDelBackup(backupDir, f.path);
    if (!fs.existsSync(full)) {
      console.error(`MANCANTE  ${f.path}`);
      failed += 1;
      continue;
    }
    const actual = await sha256File(full);
    if (actual === f.sha256) {
      console.log(`OK        ${f.path}`);
      ok += 1;
    } else {
      console.error(`CORROTTO  ${f.path} (atteso ${f.sha256.slice(0, 12)}…, trovato ${actual.slice(0, 12)}…)`);
      failed += 1;
    }
  }

  // Il confronto va fatto anche NELL'ALTRO VERSO: iterando solo `manifest.files`
  // un file di dati presente sul disco ma tolto dal manifest non veniva
  // notato, e un manifest a cui siano state sottratte delle voci passava la
  // verifica senza una parola.
  const suDisco = elencaFileBackup(backupDir);
  const extra = suDisco.filter((p) => !dichiarati.has(p));
  for (const p of extra) console.error(`NON DICHIARATO  ${p} (presente sul disco ma assente dal manifest)`);

  for (const p of nonVerificabili) console.warn(`SENZA CHECKSUM  ${p}`);

  console.log(
    `\nVerifica di ${manifest.id}: ${ok} file verificati, ${failed} problemi, `
    + `${nonVerificabili.length} non verificabili, ${extra.length} non dichiarati.`
  );
  if (failed || extra.length) {
    throw new Error('Verifica fallita: il backup è incompleto, corrotto o non corrisponde al manifest.');
  }
  if (nonVerificabili.length) {
    throw new Error(
      `Verifica incompleta: ${nonVerificabili.length} file del manifest non hanno un checksum e non sono `
      + 'stati controllati. Un backup recente non dovrebbe averne: rifallo per ottenerne uno verificabile.'
    );
  }
}

/* --- Main -------------------------------------------------------------------- */

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  const cmd = args._[0] || 'help';
  if (args.help || args.h || cmd === 'help') {
    console.log(HELP);
    return;
  }
  try {
    if (cmd === 'backup') await cmdBackup(args);
    else if (cmd === 'restore') await cmdRestore(args);
    else if (cmd === 'list') cmdList(args);
    else if (cmd === 'verify') await cmdVerify(args);
    else {
      console.error(`Comando sconosciuto: "${cmd}". Comandi: backup, restore, list, verify, help.`);
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(`Errore: ${(err && err.message) || err}`);
    process.exitCode = 1;
  }
}

main();

'use strict';

/* ---------------------------------------------------------------------------
 * Politiche sulle destinazioni di backup richieste da un CLIENT (socket della
 * Web UI o gateway MCP).
 *
 * Il motore di backup accetta per progetto una destinazione locale qualsiasi,
 * una destinazione cloud e un webhook di notifica: è corretto per la CLI, dove
 * quei parametri li sceglie chi ha già accesso alla macchina. Non lo è quando
 * arrivano da un client, dove diventano tre vettori distinti:
 *
 *  · `dest`/`from` → scrittura (e lettura) di file in qualunque cartella
 *    scrivibile dal processo Node: cartella di avvio automatico, `public/`
 *    servita come statica, `~/.ssh`;
 *  · `storage`     → copia integrale di un database su un bucket scelto dal
 *    client, con le credenziali cloud dell'installazione: esfiltrazione in un
 *    colpo solo;
 *  · `slackWebhook` → SSRF verso un URL arbitrario, che riceve nome della
 *    connessione, database e conteggi.
 *
 * Questo modulo è il punto unico in cui i tre parametri vengono normalizzati.
 * La CLI (`backup/cli.js`) NON lo usa e resta libera: `--dest` verso un volume
 * esterno o un NAS è la destinazione naturale di un backup.
 * ------------------------------------------------------------------------- */

const path = require('path');

/**
 * Risolve un percorso di backup confinandolo dentro `root`.
 * Un percorso vuoto vale `root`. Rifiuta tutto ciò che ne esce (`..`, percorsi
 * assoluti, altro disco su Windows) con un messaggio che dice cosa fare.
 */
function resolveBackupPath(raw, root, what = 'destinazione') {
  const base = path.resolve(root);
  if (raw == null || String(raw).trim() === '') return base;
  const target = path.resolve(base, String(raw));
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Percorso di ${what} non consentito: da qui si può usare solo la cartella dei backup del server. ` +
      'Per una destinazione diversa usa la CLI (npm run backup) oppure imposta CODEDB_BACKUPS_DIR.'
    );
  }
  return target;
}

/**
 * Alias di storage cloud pre-approvati lato server, da CODEDB_BACKUP_STORAGE
 * nella forma `nome=s3://bucket/prefisso,altro=gs://bucket/prefisso`.
 * Senza la variabile lo storage cloud dai client è disattivato: resta
 * disponibile via CLI, dove la destinazione la sceglie l'amministratore.
 */
function storageAliases() {
  const raw = String(process.env.CODEDB_BACKUP_STORAGE || '').trim();
  const out = new Map();
  if (!raw) return out;
  for (const entry of raw.split(',')) {
    const i = entry.indexOf('=');
    if (i <= 0) continue;
    const alias = entry.slice(0, i).trim();
    const url = entry.slice(i + 1).trim();
    if (alias && url) out.set(alias, url);
  }
  return out;
}

/** Traduce l'alias richiesto dal client nell'URI cloud, o rifiuta. */
function resolveStorageAlias(raw) {
  const wanted = String(raw || '').trim();
  if (!wanted) return null;
  const aliases = storageAliases();
  if (!aliases.size) {
    throw new Error(
      'Storage cloud non configurato per i client: definisci gli alias consentiti in CODEDB_BACKUP_STORAGE ' +
      '(es. CODEDB_BACKUP_STORAGE="archivio=s3://mio-bucket/backup"), oppure usa la CLI.'
    );
  }
  if (!aliases.has(wanted)) {
    throw new Error(`Destinazione cloud "${wanted}" non consentita. Alias disponibili: ${[...aliases.keys()].join(', ')}.`);
  }
  return aliases.get(wanted);
}

/**
 * Webhook di notifica: in assenza di indicazione si usa quello configurato sul
 * server; se il client ne indica uno, deve essere un webhook Slack autentico.
 */
function resolveSlackWebhook(raw) {
  const wanted = String(raw || '').trim();
  if (!wanted) return process.env.SLACK_WEBHOOK_URL || null;
  if (!/^https:\/\/hooks\.slack\.com\//.test(wanted)) {
    throw new Error('Webhook di notifica non consentito: sono ammessi solo gli URL https://hooks.slack.com/ o quello configurato sul server.');
  }
  return wanted;
}

module.exports = { resolveBackupPath, resolveStorageAlias, resolveSlackWebhook, storageAliases };

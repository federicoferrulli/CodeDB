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
const fs = require('fs');

/**
 * Percorso reale di `p`, seguendo i collegamenti simbolici. Se `p` non esiste
 * ancora — il caso normale per una destinazione di backup — si risale al primo
 * antenato che esiste, se ne prende il percorso reale e vi si riattacca la
 * parte mancante: è l'unico modo di dire dove il file FINIREBBE davvero.
 */
function percorsoReale(p) {
  let corrente = path.resolve(p);
  const coda = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(corrente), ...coda);
    } catch {
      const padre = path.dirname(corrente);
      if (padre === corrente) return path.resolve(p); // radice irraggiungibile
      coda.unshift(path.basename(corrente));
      corrente = padre;
    }
  }
}

/**
 * Risolve un percorso di backup confinandolo dentro `root`.
 * Un percorso vuoto vale `root`. Rifiuta tutto ciò che ne esce (`..`, percorsi
 * assoluti, altro disco su Windows) con un messaggio che dice cosa fare.
 *
 * Il confronto si fa DUE volte: sulla stringa normalizzata e sul percorso
 * REALE. path.resolve/path.relative lavorano sul testo e non seguono i
 * collegamenti simbolici, quindi un link dentro BACKUP_ROOT che punta fuori
 * superava il controllo e la scrittura finiva altrove.
 */
function resolveBackupPath(raw, root, what = 'destinazione') {
  const base = path.resolve(root);
  const nonConsentito = () => new Error(
    `Percorso di ${what} non consentito: da qui si può usare solo la cartella dei backup del server. ` +
    'Per una destinazione diversa usa la CLI (npm run backup) oppure imposta CODEDB_BACKUPS_DIR.'
  );
  if (raw == null || String(raw).trim() === '') return base;
  const target = path.resolve(base, String(raw));
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw nonConsentito();

  const baseReale = percorsoReale(base);
  const targetReale = percorsoReale(target);
  const relReale = path.relative(baseReale, targetReale);
  if (relReale.startsWith('..') || path.isAbsolute(relReale)) throw nonConsentito();

  return target;
}

/**
 * Radice dei backup di un tenant.
 *
 * `BACKUP_ROOT` è una sola cartella per installazione, mentre il resto del
 * modello multi-tenant è partizionato per owner (`connectionsFileFor` per le
 * connessioni, i filtri `ownerId`/`userId` per l'audit). Senza questa
 * partizione `backup:list` enumera i gruppi `<connessione>_<database>` di TUTTI
 * i tenant e `backup:restore` accetta quei nomi così come sono: l'owner del
 * tenant A si riversa il dump del tenant B dentro un proprio database e lo
 * legge con una normale SELECT. La capability `manage` non basta a impedirlo —
 * ce l'ha ogni owner sul PROPRIO tenant, non sull'installazione.
 *
 * `local` e l'assenza di RBAC valgono la radice storica: l'installazione
 * mono-utente (e l'app desktop) non deve vedere i propri backup spostarsi, e il
 * principal root — l'unico amministratore dell'installazione — continua a
 * leggere tutto ciò che c'era prima. I tenant vanno sotto `tenants/<ownerId>`
 * invece che direttamente sotto la radice, così un gruppo di backup non può
 * mai chiamarsi come l'id di un altro tenant.
 */
function backupRootFor(root, ownerId, { rbac = true } = {}) {
  const base = path.resolve(root);
  const id = String(ownerId == null ? '' : ownerId).trim();
  if (!rbac || !id || id === 'local') return base;
  return path.join(base, 'tenants', id.replace(/[^A-Za-z0-9_.-]/g, '_'));
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

module.exports = { resolveBackupPath, backupRootFor, resolveStorageAlias, resolveSlackWebhook, storageAliases };

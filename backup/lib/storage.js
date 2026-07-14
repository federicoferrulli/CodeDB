'use strict';

/* ---------------------------------------------------------------------------
 * Storage remoto opzionale per i file di backup: dopo il salvataggio locale
 * l'intera cartella del backup può essere caricata su S3, GCS o Azure Blob.
 *
 * Gli SDK cloud NON sono dipendenze del progetto: vengono caricati on-demand
 * e, se assenti, l'errore spiega quale pacchetto installare. Le credenziali
 * seguono i canali standard di ogni provider (variabili d'ambiente / file di
 * configurazione), mai argomenti della CLI.
 *   --storage s3://bucket/prefisso       (AWS_ACCESS_KEY_ID, AWS_REGION, ...)
 *   --storage gs://bucket/prefisso      (GOOGLE_APPLICATION_CREDENTIALS)
 *   --storage azure://container/prefisso (AZURE_STORAGE_CONNECTION_STRING)
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

function parseStorage(spec) {
  if (!spec || spec === 'local') return null;
  const m = String(spec).match(/^(s3|gs|azure):\/\/([^/]+)\/?(.*)$/);
  if (!m) {
    throw new Error(`Destinazione storage non valida: "${spec}". Formati: s3://bucket/prefisso, gs://bucket/prefisso, azure://container/prefisso.`);
  }
  return { type: m[1], bucket: m[2], prefix: m[3].replace(/\/+$/, '') };
}

function requireOptional(pkg) {
  try {
    return require(pkg);
  } catch {
    throw new Error(`Modulo "${pkg}" non installato: esegui "npm install ${pkg}" per usare questo storage cloud.`);
  }
}

// Elenco ricorsivo dei file di una cartella, con percorso relativo POSIX
// (le chiavi degli object store usano sempre "/").
function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

async function uploadS3(store, files, log) {
  const { S3Client, PutObjectCommand } = requireOptional('@aws-sdk/client-s3');
  const client = new S3Client({});
  for (const f of files) {
    const Key = store.prefix ? `${store.prefix}/${f.rel}` : f.rel;
    await client.send(new PutObjectCommand({ Bucket: store.bucket, Key, Body: fs.createReadStream(f.full) }));
    log.info(`Caricato su S3: s3://${store.bucket}/${Key}`);
  }
}

async function uploadGcs(store, files, log) {
  const { Storage } = requireOptional('@google-cloud/storage');
  const bucket = new Storage().bucket(store.bucket);
  for (const f of files) {
    const destination = store.prefix ? `${store.prefix}/${f.rel}` : f.rel;
    await bucket.upload(f.full, { destination });
    log.info(`Caricato su GCS: gs://${store.bucket}/${destination}`);
  }
}

async function uploadAzure(store, files, log) {
  const { BlobServiceClient } = requireOptional('@azure/storage-blob');
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error('Variabile AZURE_STORAGE_CONNECTION_STRING mancante per lo storage Azure.');
  const container = BlobServiceClient.fromConnectionString(cs).getContainerClient(store.bucket);
  for (const f of files) {
    const name = store.prefix ? `${store.prefix}/${f.rel}` : f.rel;
    await container.getBlockBlobClient(name).uploadFile(f.full);
    log.info(`Caricato su Azure: ${store.bucket}/${name}`);
  }
}

// Carica l'intera cartella del backup sullo storage remoto, mantenendo la
// struttura relativa sotto un prefisso che include l'id del backup.
async function uploadBackupDir(store, backupDir, log) {
  if (!store) return;
  const files = listFiles(backupDir);
  const withId = { ...store, prefix: [store.prefix, path.basename(backupDir)].filter(Boolean).join('/') };
  log.info(`Upload di ${files.length} file su ${store.type}://${store.bucket}/${withId.prefix} ...`);
  if (store.type === 's3') await uploadS3(withId, files, log);
  else if (store.type === 'gs') await uploadGcs(withId, files, log);
  else await uploadAzure(withId, files, log);
}

module.exports = { parseStorage, uploadBackupDir, listFiles };

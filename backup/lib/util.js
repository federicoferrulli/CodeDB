'use strict';

/* ---------------------------------------------------------------------------
 * Utility condivise di backup/restore: scrittura NDJSON in streaming con
 * gzip + checksum SHA-256, lettura riga per riga, catalogo dei backup.
 * Tutto in streaming: nessun file viene mai caricato per intero in memoria.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const readline = require('readline');
const { Transform } = require('stream');
const { once } = require('events');
const { pipeline } = require('stream/promises');

// Sink su file: le righe scritte passano (opzionalmente) da gzip, poi da un
// contatore che calcola SHA-256 e dimensione sui byte effettivi del file.
//
// La catena usa `pipeline` e NON `.pipe()`: `.pipe()` non propaga gli errori
// lungo la catena, quindi un errore a monte (gzip, o il Transform del checksum)
// lasciava il writeStream a valle senza né 'error' né 'finish' e la `finished()`
// in close() non si risolveva MAI. Il backup si bloccava senza messaggio: via
// CLI il processo restava appeso, via UI l'evento socket non rispondeva più e il
// client girava all'infinito. Il caso più comune è anche il peggiore — errore di
// scrittura su disco pieno, cioè proprio quando il backup deve fallire in modo
// pulito. `pipeline` propaga l'errore e distrugge tutti gli stream della catena.
function createFileSink(filePath, { compress = true, level = 1 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const out = fs.createWriteStream(filePath, { highWaterMark: 64 * 1024 });
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const counter = new Transform({
    highWaterMark: 64 * 1024,
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });

  const gzip = compress ? zlib.createGzip({ level, chunkSize: 64 * 1024 }) : null;
  const entry = gzip || counter;
  const stages = gzip ? [gzip, counter, out] : [counter, out];

  // La pipeline si risolve quando l'ultimo stream è concluso e rigetta al primo
  // errore in qualunque punto della catena. La si tiene qui e la si attende in
  // close(): senza un `catch` sospeso, un errore prima di close() diventerebbe
  // una unhandled rejection.
  let failure = null;
  const done = pipeline(...stages).catch((err) => { failure = err; throw err; });
  done.catch(() => { /* l'errore vero viene rilanciato da close()/writeLine() */ });

  return {
    writeLine(line) {
      // Se la catena è già saltata, fermarsi subito invece di accodare dati che
      // nessuno scriverà mai.
      if (failure) throw failure;
      if (!entry.write(line + '\n')) {
        // L'attesa del 'drain' va messa in gara con la fine della catena: se la
        // pipeline salta mentre siamo in attesa, il 'drain' non arriverà mai e
        // il chiamante resterebbe appeso — lo stesso blocco che si sta correggendo.
        return Promise.race([
          once(entry, 'drain'),
          done.then(() => { throw failure || new Error('Sink di backup chiuso durante la scrittura.'); }),
        ]);
      }
    },
    async close() {
      entry.end();
      await done; // rigetta con l'errore originale, ovunque si sia verificato
      return { bytes, sha256: hash.digest('hex') };
    },
  };
}

// Itera le righe non vuote di un file NDJSON, decomprimendo se .gz.
async function* readLines(filePath) {
  let input = fs.createReadStream(filePath);
  if (filePath.endsWith('.gz')) {
    const gunzip = zlib.createGunzip();
    input.pipe(gunzip);
    input = gunzip;
  }
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) yield line;
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Nome file/cartella sicuro a partire da nomi di connessione/db arbitrari.
function safeName(name) {
  return String(name).replace(/[^\w.-]+/g, '_');
}

/**
 * Id del backup: timestamp ordinabile + tipo (es. `20260714-103000Z_full`).
 *
 * In UTC e con i millisecondi (CDB-53). L'ora locale rendeva gli id NON
 * ordinabili due volte l'anno — al ritorno dall'ora legale un backup delle 2:30
 * ne precede uno delle 2:30 fatto un'ora dopo — e la catena degli incrementali
 * si risolve proprio per ordine. I millisecondi evitano invece la collisione fra
 * due backup avviati nello stesso secondo, che condividerebbero la cartella.
 * Il suffisso `Z` dichiara il fuso a chi legge il nome.
 */
function makeBackupId(type) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
    + `${p(d.getUTCMilliseconds(), 3)}Z`;
  return `${stamp}_${type}`;
}

/* --- Catalogo: <dest>/<conn>_<db>/catalog.json -------------------------- */

/**
 * Catalogo del gruppo. Un file ASSENTE è normale (primo backup) e vale come
 * catalogo vuoto; un file CORROTTO no (CDB-56): trattarlo come vuoto faceva
 * sparire dall'elenco backup che esistono ancora sul disco, e il backup
 * successivo lo riscriveva perdendo per sempre lo storico. Si distinguono i due
 * casi: il file illeggibile viene messo da parte con un nome che lo salva, e
 * l'anomalia viene detta invece di essere ingoiata.
 */
function readCatalog(groupDir) {
  const file = path.join(groupDir, 'catalog.json');
  let testo;
  try {
    testo = fs.readFileSync(file, 'utf8');
  } catch {
    return { backups: [] }; // non esiste ancora: nessun backup in questo gruppo
  }
  try {
    const cat = JSON.parse(testo);
    if (!cat || !Array.isArray(cat.backups)) throw new Error('struttura inattesa');
    return cat;
  } catch (err) {
    const salvato = `${file}.corrotto-${Date.now()}`;
    try { fs.renameSync(file, salvato); } catch { /* sola lettura: si prosegue comunque */ }
    console.warn(
      `[backup] catalog.json di ${groupDir} illeggibile (${(err && err.message) || err}). `
      + `Copia conservata in ${path.basename(salvato)}; l'elenco riparte vuoto, `
      + 'ma i backup sul disco restano intatti e ripristinabili.'
    );
    return { backups: [] };
  }
}

// Lock a file (creazione esclusiva, atomica su tutti gli OS supportati) per
// serializzare le scritture concorrenti al catalogo: un backup via CLI e uno
// via MCP sullo stesso gruppo altrimenti possono leggere lo stesso catalogo
// prima l'uno della scrittura dell'altro e perdersi una voce (read-modify-write).
// Un lock si considera abbandonato solo in base alla sua ETÀ (CDB-47): prima
// bastava che il RICHIEDENTE avesse atteso oltre il timeout per cancellarlo,
// quindi un backup lungo ma vivo si vedeva strappare il lock da chi arrivava
// dopo, e due processi riscrivevano il catalogo insieme — cioè esattamente la
// perdita di voci che il lock esiste per evitare.
const LOCK_ETA_MAX_MS = 2 * 60 * 1000;

function lockAbbandonato(lockFile) {
  try {
    return Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_ETA_MAX_MS;
  } catch {
    return false; // sparito nel frattempo: il prossimo tentativo lo prende
  }
}

/**
 * Acquisizione ASINCRONA del lock del catalogo (CDB-47).
 *
 * L'attesa era `Atomics.wait`, che blocca il thread: dentro il server ciò
 * significa fermare l'event loop — tutte le sessioni, i change stream e le query
 * di tutti gli utenti — per aspettare un file. Qui si attende con una Promise,
 * quindi il processo continua a servire il resto.
 */
async function acquireCatalogLock(groupDir, timeoutMs = 5000) {
  fs.mkdirSync(groupDir, { recursive: true });
  const lockFile = path.join(groupDir, '.catalog.lock');
  const scadenza = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockFile, 'wx'));
      return lockFile;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (lockAbbandonato(lockFile)) {
        try { fs.unlinkSync(lockFile); } catch { /* già rimosso da un altro */ }
        continue;
      }
      if (Date.now() > scadenza) {
        throw new Error(
          `Catalogo dei backup occupato in ${groupDir}: un'altra operazione lo sta aggiornando. `
          + 'Attendi che finisca e riprova.'
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

function releaseCatalogLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch { /* già rilasciato */ }
}

// Asincrona perché lo è l'acquisizione del lock (CDB-47).
async function appendToCatalog(groupDir, entry) {
  const lockFile = await acquireCatalogLock(groupDir);
  try {
    const catalog = readCatalog(groupDir);
    catalog.backups.push(entry);
    fs.writeFileSync(path.join(groupDir, 'catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');
  } finally {
    releaseCatalogLock(lockFile);
  }
}

function readManifest(backupDir) {
  const file = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`Manifest non trovato: ${file} (la cartella non è un backup valido).`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i += 1; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

module.exports = {
  createFileSink,
  readLines,
  sha256File,
  safeName,
  makeBackupId,
  readCatalog,
  appendToCatalog,
  readManifest,
  formatBytes,
};

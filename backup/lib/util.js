'use strict';

/* ---------------------------------------------------------------------------
 * Utility condivise di backup/restore: scrittura NDJSON in streaming con
 * gzip + checksum SHA-256, lettura riga per riga, catalogo dei backup.
 * Tutto in streaming: nessun file viene mai caricato per intero in memoria.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const fsp = require('fs/promises');
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
  let finalizzato = false;
  let digest = null;
  const done = pipeline(...stages).catch((err) => { failure = err; throw err; });
  done.catch(() => { /* l'errore vero viene rilanciato da close()/writeLine() */ });

  // Attesa di backpressure con listener rimovibili. Agganciare done.then() a
  // ogni drain trattiene una reaction per ogni blocco fino alla chiusura del
  // file: su dump grandi diventa una crescita lineare di memoria.
  const attendiDrain = () => new Promise((resolve, reject) => {
    const monitorati = [...new Set(stages)];
    let conclusa = false;
    const pulisci = () => {
      entry.removeListener('drain', onDrain);
      entry.removeListener('close', onClose);
      for (const stream of monitorati) stream.removeListener('error', onError);
    };
    const termina = (fn, value) => {
      if (conclusa) return;
      conclusa = true;
      pulisci();
      fn(value);
    };
    const onDrain = () => termina(resolve);
    const onError = (err) => termina(reject, err);
    const onClose = () => termina(
      reject,
      failure || new Error('Sink di backup chiuso durante la scrittura.')
    );

    entry.once('drain', onDrain);
    entry.once('close', onClose);
    for (const stream of monitorati) stream.once('error', onError);
    if (failure) onError(failure);
  });

  return {
    writeLine(line) {
      if (finalizzato) throw failure || new Error('Sink di backup già chiuso.');
      // Se la catena è già saltata, fermarsi subito invece di accodare dati che
      // nessuno scriverà mai.
      if (failure) throw failure;
      if (!entry.write(line + '\n')) {
        // L'attesa del 'drain' va messa in gara con la fine della catena: se la
      // pipeline salta mentre siamo in attesa, il 'drain' non arriverà mai e
      // il chiamante resterebbe appeso — lo stesso blocco che si sta correggendo.
        return attendiDrain();
      }
    },
    async close() {
      if (digest) return digest;
      if (finalizzato) {
        await done;
        return digest;
      }
      finalizzato = true;
      entry.end();
      await done;
      digest = { bytes, sha256: hash.digest('hex') };
      return digest;
    },
    async abort(reason) {
      if (!finalizzato) {
        finalizzato = true;
        const err = reason instanceof Error ? reason : new Error(String(reason || 'Scrittura del backup annullata.'));
        if (!failure) failure = err;
        entry.destroy(err);
      }
      try { await done; } catch { /* l'errore originale viene rilanciato dal chiamante */ }
      // Il file a metà va RIMOSSO, non lasciato lì.
      //
      // Distruggere lo stream ferma la scrittura ma il file resta sul disco, e
      // un backup annullato lasciava quindi un `.ndjson` troncato accanto a
      // quelli buoni: `verifyBackupDir` lo trova come file non dichiarato dal
      // manifest e dichiara l'intero backup non valido — cioè un backup sano
      // segnalato come corrotto per via di uno scarto.
      //
      // Il difetto era pure intermittente, il che lo rendeva peggiore: se la
      // `destroy` arriva prima che l'apertura asincrona del file sia completata
      // il file non nasce affatto, e l'annullamento sembra pulito.
      try {
        await fsp.rm(filePath, { force: true });
      } catch { /* file mai creato o già rimosso: nulla da fare */ }
    },
  };
}

// Itera le righe non vuote di un file NDJSON, decomprimendo se .gz.
async function* readLines(filePath) {
  const source = fs.createReadStream(filePath);
  let input = source;
  if (filePath.endsWith('.gz')) {
    const gunzip = zlib.createGunzip();
    source.pipe(gunzip);
    input = gunzip;
  }
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  // Una Promise.race per riga contro la stessa Promise d'errore accumula una
  // reaction pendente per ogni record finché il file termina: milioni di righe
  // significano milioni di closure trattenute. L'errore viene invece salvato e
  // la chiusura di readline risveglia il suo unico iteratore.
  let streamFailure = null;
  const onError = (err) => {
    if (!streamFailure) streamFailure = err;
    rl.close();
    if (!source.destroyed) source.destroy();
    if (input !== source && !input.destroyed) input.destroy();
  };
  source.on('error', onError);
  if (input !== source) input.on('error', onError);

  try {
    for await (const line of rl) {
      if (line.trim()) yield line;
    }
    if (streamFailure) throw streamFailure;
  } finally {
    source.removeListener('error', onError);
    if (input !== source) input.removeListener('error', onError);
    rl.close();
    if (!source.destroyed) source.destroy();
    if (input !== source && !input.destroyed) input.destroy();
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

// Nome file/cartella sicuro e praticamente iniettivo a partire da nomi
// arbitrari. Il suffisso evita che nomi diversi normalizzati nello stesso stem
// (per esempio "clienti VIP" e "clienti_VIP") condividano file o cataloghi.
// I nomi gia' conformi e minuscoli restano invariati per non spezzare le
// installazioni esistenti; quelli che su Windows sono riservati vengono sempre
// riscritti.
function safeName(name) {
  const raw = String(name);
  const nomeWindowsRiservato = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(raw);
  const giaSicuro = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(raw)
    && raw.length <= 80
    && !nomeWindowsRiservato;
  if (giaSicuro) return raw;

  let stem = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+|\.+$/g, '');
  if (!stem) stem = 'voce';
  stem = stem.slice(0, 80);
  // 96 bit mantengono il componente compatto anche sui percorsi Windows, ma
  // rendono impraticabile una collisione anche con nomi scelti apposta.
  const digestNome = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 24);
  return `${stem}-h${digestNome}`;
}

// Forma lessicale unica dei percorsi del manifest. Serve sia al confinamento
// sia al rilevamento dei duplicati mascherati con ./ oppure segmento/../.
function canonicalBackupPath(value) {
  const raw = String(value == null ? '' : value).replace(/\\/g, '/');
  const normalized = path.posix.normalize(raw);
  return normalized === '.' ? '' : normalized;
}

// Linux distingue Foo da foo; Windows no. Il confronto deve seguire il file
// system effettivo invece di fondere sempre i nomi e rifiutare backup validi.
function backupPathKey(value) {
  const canonical = canonicalBackupPath(value);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
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
  const dir = path.resolve(backupDir);
  let dirStat;
  try {
    dirStat = fs.lstatSync(dir);
  } catch {
    throw new Error(`Cartella del backup non trovata: ${dir}.`);
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`La cartella del backup non può essere un file, link simbolico o junction: ${dir}.`);
  }

  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`Manifest non trovato: ${file} (la cartella non è un backup valido).`);
  const manifestStat = fs.lstatSync(file);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`Il manifest non è un file regolare interno al backup: ${file}.`);
  }
  const realDir = fs.realpathSync(dir);
  const realFile = fs.realpathSync(file);
  const realRel = path.relative(realDir, realFile);
  if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new Error(`Il manifest esce dalla cartella reale del backup: ${file}.`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Percorso di un file DICHIARATO nel manifest, confinato dentro la cartella del
 * backup.
 *
 * Il manifest è un file di DATI, non codice: i checksum proteggono il contenuto
 * dei file elencati, non il campo `path` del manifest stesso. Oggi lo scrive il
 * motore e il valore è affidabile, ma un backup arriva anche da fuori (una
 * copia ricevuta, un ripristino da un archivio) e comporre `path.join(dir,
 * f.path)` senza controlli lascia leggere qualunque file della macchina.
 */
function fileDelBackup(backupDir, relativo, cosa = 'file') {
  const base = path.resolve(backupDir);
  const canonical = canonicalBackupPath(relativo);
  const full = path.resolve(base, canonical);
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Il manifest dichiara un ${cosa} fuori dalla cartella del backup ("${relativo}"): il backup è alterato o corrotto.`
    );
  }
  if (fs.existsSync(full)) {
    const real = fs.realpathSync(full);
    const realBase = fs.realpathSync(base);
    const realRel = path.relative(realBase, real);
    if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(
        `Il manifest dichiara un ${cosa} che tramite link simbolico esce dalla cartella del backup (${relativo}): il backup è alterato o corrotto.`
      );
    }
  }
  return full;
}

function elencaFileBackup(backupDir) {
  const esclusi = new Set(['manifest.json', 'catalog.json', 'backup.log']);
  const out = [];
  const cammina = (dir, prefisso) => {
    let voci;
    try {
      voci = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const voce of voci) {
      const rel = prefisso ? `${prefisso}/${voce.name}` : voce.name;
      if (voce.isDirectory()) cammina(path.join(dir, voce.name), rel);
      else if (!esclusi.has(rel)) out.push(rel);
    }
  };
  cammina(backupDir, '');
  return out;
}

// Verificatore unico per CLI, UI e MCP. Non lancia per un singolo file
// alterato: raccoglie tutti i problemi in un rapporto strutturato. L'unico
// errore fatale resta un manifest assente o illeggibile, perché senza di esso
// non esiste un insieme autorevole di file da confrontare.
async function verifyBackupDir(backupDir) {
  const dir = path.resolve(backupDir);
  const manifest = readManifest(dir);
  if (!Array.isArray(manifest.files)) {
    throw new Error('Il manifest del backup non contiene un elenco di file valido.');
  }

  let okCount = 0;
  let failedCount = 0;
  let unverifiableCount = 0;
  const details = [];
  const dichiarati = new Map();

  for (const f of manifest.files) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      details.push({ file: '(voce manifest non valida)', status: 'INVALID_ENTRY' });
      failedCount += 1;
      continue;
    }
    const rel = canonicalBackupPath(f.path);
    const key = backupPathKey(rel);
    if (dichiarati.has(key)) {
      details.push({ file: rel, status: 'DUPLICATE', other: dichiarati.get(key) });
      failedCount += 1;
      continue;
    }
    dichiarati.set(key, rel);

    let full;
    try {
      full = fileDelBackup(dir, rel);
    } catch (err) {
      details.push({ file: rel, status: 'INVALID_PATH', error: err.message });
      failedCount += 1;
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      details.push({ file: rel, status: 'MISSING' });
      failedCount += 1;
      continue;
    }
    if (!stat.isFile()) {
      details.push({ file: rel, status: 'INVALID_TYPE' });
      failedCount += 1;
      continue;
    }
    if (f.bytes != null) {
      const expectedBytes = Number(f.bytes);
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
        details.push({ file: rel, status: 'INVALID_SIZE', expectedBytes: f.bytes });
        failedCount += 1;
        continue;
      }
      if (stat.size !== expectedBytes) {
        details.push({ file: rel, status: 'CORRUPTED', expectedBytes, actualBytes: stat.size });
        failedCount += 1;
        continue;
      }
    }
    if (!f.sha256) {
      details.push({ file: rel, status: 'UNVERIFIABLE' });
      unverifiableCount += 1;
      continue;
    }
    if (typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(f.sha256)) {
      details.push({ file: rel, status: 'INVALID_CHECKSUM' });
      failedCount += 1;
      continue;
    }
    try {
      const actual = await sha256File(full);
      if (actual === f.sha256.toLowerCase()) {
        details.push({ file: rel, status: 'OK' });
        okCount += 1;
      } else {
        details.push({ file: rel, status: 'CORRUPTED', expected: f.sha256, actual });
        failedCount += 1;
      }
    } catch (err) {
      details.push({ file: rel, status: 'READ_ERROR', error: err.message });
      failedCount += 1;
    }
  }

  const extra = elencaFileBackup(dir)
    .filter((rel) => !dichiarati.has(backupPathKey(rel)));
  for (const rel of extra) details.push({ file: rel, status: 'UNDECLARED' });

  return {
    manifest,
    backupId: manifest.id,
    okCount,
    failedCount,
    unverifiableCount,
    extraCount: extra.length,
    valid: failedCount === 0 && unverifiableCount === 0 && extra.length === 0,
    details,
  };
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
  canonicalBackupPath,
  backupPathKey,
  safeName,
  makeBackupId,
  readCatalog,
  appendToCatalog,
  readManifest,
  fileDelBackup,
  verifyBackupDir,
  formatBytes,
};

'use strict';

/**
 * L'esecuzione dei tool nativi (pg_dump/pg_restore, mongodump/mongorestore,
 * mysqlsh): §4 «Motori: criteri di scelta» del piano.
 *
 * Le regole non negoziabili, in un posto solo:
 *
 *  · mai la shell: `spawn` con array di argomenti, così un nome di database con
 *    spazi o `$(…)` dentro non diventa un comando;
 *  · mai password negli argomenti né nei log: i segreti viaggiano in file di
 *    credenziali temporanei (0600) o sullo stdin del tool, e ogni testo che
 *    finisce in un log passa da `redigi`;
 *  · combinazioni vietate rifiutate QUI, non dal tool a metà lavoro: `--oplog`
 *    con selezione su mongodump, `--jobs` senza directory su pg_dump, `--jobs`
 *    con `--single-transaction` su pg_restore;
 *  · il processo appartiene al lavoro: timeout e abort uccidono l'intero
 *    albero, su Windows senza finestre visibili (`windowsHide`).
 *
 * Qui non si cerca alcun binario né si apre alcuna connessione: `spawnFn` e
 * `cercaFn` si iniettano, quindi tutto si prova senza installare nulla. Che il
 * tool esista davvero e che la versione vada bene si decide con `disponibilita`
 * e `versioneTool`, e la mancanza produce istruzioni, non un fallback
 * silenzioso su un altro percorso.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Tetto su quanto output di un tool si tiene in memoria.
 *
 * `stdout += …` senza limite trasforma un tool loquace (o un `--verbose`
 * dimenticato) in un OOM del server. Qui l'output serve solo a diagnosticare:
 * si conserva la CODA, che è dove i tool scrivono l'errore, e il troncamento si
 * DICHIARA invece di far credere che il tool abbia detto solo quello.
 */
const MAX_OUTPUT = Number(process.env.CODEDB_TOOL_MAX_OUTPUT_BYTES) || 1024 * 1024;

function guasto(codice, messaggio, dettagli = {}) {
  const err = new Error(messaggio);
  err.codice = codice;
  Object.assign(err, dettagli);
  return err;
}

/** Ogni occorrenza di un segreto diventa `***`: nei log non restano password. */
function redigi(testo, segreti = []) {
  let pulito = String(testo == null ? '' : testo);
  for (const segreto of segreti) {
    const s = String(segreto || '');
    if (s.length >= 4) pulito = pulito.split(s).join('***');
  }
  return pulito;
}

/**
 * File di credenziali temporaneo (PGPASSFILE, defaults-file MySQL): 0600 fin
 * dalla creazione, così nessun altro utente lo legge nella finestra fra
 * scrittura e chmod. Su Windows i bit POSIX sono solo consultivi: lì la
 * protezione vera è l'ACL della directory del service account, non questo flag.
 */
function fileCredenziali({ dir = null, prefisso = 'codedb-cred-', contenuto = '' } = {}) {
  const cartella = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-cred-'));
  const file = path.join(cartella, `${prefisso}${process.pid}`);
  fs.writeFileSync(file, String(contenuto), { mode: 0o600, flag: 'wx' });
  return { cartella, file };
}

function rimuoviCredenziali({ cartella = null, file = null } = {}) {
  try { if (file) fs.rmSync(file, { force: true }); } catch { /* già sparito */ }
  try { if (cartella) fs.rmSync(cartella, { recursive: true, force: true }); } catch { /* già sparita */ }
  return { ok: true };
}

/**
 * Un URI MongoDB porta la password DENTRO di sé, quindi `--uri=…` la espone
 * nella riga di comando: `ps`, Process Explorer e ogni supervisore la leggono.
 * I Database Tools accettano però un file di configurazione (`--config`) con
 * le stesse chiavi — è la via che il modulo usa per PostgreSQL e MySQL, e qui
 * mancava. Il file lo scrive `fileCredenziali` (0600).
 *
 * YAML minimale scritto a mano di proposito: una sola chiave, di cui
 * controlliamo il valore. Il blocco letterale `>-` evita ogni quoting, e un URI
 * non può contenere spazi o a capo — se li contenesse non sarebbe un URI.
 */
function contenutoConfigMongo({ uri }) {
  const s = String(uri || '').trim();
  if (!s) throw guasto('INVALIDO', 'URI MongoDB mancante.');
  if (/[\s"']/.test(s)) throw guasto('INVALIDO', 'URI MongoDB non valido: contiene spazi o apici.');
  return `uri: ${s}
`;
}

/** Un URI che porta con sé delle credenziali non può finire fra gli argomenti. */
function uriConSegreto(uri) {
  const s = String(uri || '');
  const m = /^mongodb(\+srv)?:\/\/([^@/]*)@/i.exec(s);
  return !!m && m[2].includes(':');
}

/** Riga PGPASSFILE: host:porta:db:utente:password (i `:` e `\` si scappano). */
function rigaPgpass({ host = 'localhost', porta = 5432, db = '*', utente, password } = {}) {
  if (!utente || password == null) throw guasto('INVALIDO', 'Credenziali PostgreSQL incomplete.');
  const scappa = (s) => String(s).replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  return `${scappa(host)}:${scappa(porta)}:${scappa(db)}:${scappa(utente)}:${scappa(password)}\n`;
}

/**
 * Esegue un tool e ne aspetta l'uscita, con il rapporto del tool.
 *
 * @param {object} opts
 * @param {string} opts.programma percorso o nome del binario (mai una riga di shell)
 * @param {string[]} opts.args argomenti, uno per uno
 * @param {object} [opts.env] variabili AGGIUNTE all'ambiente (non lo sostituiscono)
 * @param {string|Buffer} [opts.input] scritto sullo stdin (password al prompt)
 * @param {number} [opts.timeoutMs] superato il quale l'intero albero viene ucciso
 * @param {AbortSignal} [opts.segnale] annullamento cooperativo del lavoro
 * @param {string[]} [opts.segreti] valori da redigere in ogni errore
 * @param {Function} [opts.spawnFn] seam per i test
 * @param {Function} [opts.uccidiFn] seam per i test `(pid) => void`
 */
function eseguiTool({
  programma, args = [], env = {}, input = null, timeoutMs = 0, segnale = null,
  segreti = [], spawnFn = spawn, uccidiFn = null,
} = {}) {
  const binario = String(programma || '').trim();
  if (!binario) throw guasto('INVALIDO', 'Programma da eseguire mancante.');
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw guasto('INVALIDO', 'Gli argomenti devono essere stringhe, una per una: mai una riga di shell.');
  }
  return new Promise((resolve, reject) => {
    const inizio = Date.now();
    let figlio;
    try {
      figlio = spawnFn(binario, [...args], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      reject(guasto('AVVIO_FALLITO', `Impossibile avviare ${binario}: ${err.message}`, { causa: err }));
      return;
    }
    let completato = false;
    let stdout = '';
    let stderr = '';
    let troncato = false;
    const accoda = (accumulato, pezzo) => {
      const testo = accumulato + String(pezzo);
      if (testo.length <= MAX_OUTPUT) return testo;
      troncato = true;
      return testo.slice(testo.length - MAX_OUTPUT);
    };
    const termina = (ucciso, motivo) => {
      if (completato) return;
      completato = true;
      if (timer) clearTimeout(timer);
      if (segnale) segnale.removeEventListener('abort', abortisci);
      try {
        if (ucciso) uccidiAlbero(figlio, { uccidiFn });
      } catch (_) { /* già uscito da solo */ }
      if (motivo === 'timeout') {
        reject(guasto('TIMEOUT', `${binario} oltre il tempo massimo (${timeoutMs} ms).`, { programma: binario }));
      } else if (motivo === 'abort') {
        reject(guasto('ANNULLATO', `${binario} annullato con il lavoro.`, { programma: binario }));
      }
    };
    const abortisci = () => termina(true, 'abort');
    let timer = null;
    if (segnale) {
      if (segnale.aborted) { abortisci(); return; }
      segnale.addEventListener('abort', abortisci, { once: true });
    }
    if (Number(timeoutMs) > 0) {
      timer = setTimeout(() => termina(true, 'timeout'), Number(timeoutMs));
      if (timer.unref) timer.unref();
    }
    figlio.stdout.on('data', (c) => { stdout = accoda(stdout, c); });
    figlio.stderr.on('data', (c) => { stderr = accoda(stderr, c); });
    figlio.on('error', (err) => {
      if (completato) return;
      completato = true;
      if (timer) clearTimeout(timer);
      reject(guasto('AVVIO_FALLITO', redigi(`Impossibile avviare ${binario}: ${err.message}`, segreti), { programma: binario }));
    });
    figlio.on('close', (codice, segnaleUscita) => {
      if (completato) return;
      completato = true;
      if (timer) clearTimeout(timer);
      if (segnale) segnale.removeEventListener('abort', abortisci);
      resolve({
        codice: codice == null ? null : codice,
        segnale: segnaleUscita || null,
        stdout, stderr, troncato,
        durataMs: Date.now() - inizio,
      });
    });
    if (input != null) {
      try { figlio.stdin.write(input); } catch (_) { /* stdin già chiuso */ }
    }
    try { figlio.stdin.end(); } catch (_) { /* già chiuso */ }
  });
}

/** Uccide il processo e i figli: `taskkill /T` su Windows, gruppo su POSIX. */
function uccidiAlbero(figlio, { uccidiFn = null } = {}) {
  if (!figlio || figlio.exitCode != null) return { ok: true, nota: 'già uscito' };
  if (uccidiFn) { uccidiFn(figlio.pid); return { ok: true }; }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(figlio.pid), '/T', '/F'], { shell: false, windowsHide: true });
    killer.on('error', () => { try { figlio.kill('SIGKILL'); } catch (_) { /* morto nel frattempo */ } });
    return { ok: true };
  }
  try { process.kill(-figlio.pid, 'SIGKILL'); return { ok: true }; }
  catch { try { figlio.kill('SIGKILL'); } catch (_) { /* morto nel frattempo */ } return { ok: true }; }
}

/**
 * La versione del tool, dal suo stesso output. Il formato si dichiara per
 * tool (`espressione`), perché ogni tool la scrive a modo suo; se non si
 * riconosce, il tool è inutilizzabile quanto uno assente — meglio dirlo che
 * proseguire alla cieca.
 */
async function versioneTool({ programma, flagVersione = '--version', espressione, spawnFn = spawn, segreti = [] } = {}) {
  if (!espressione) throw guasto('INVALIDO', 'Espressione di versione mancante.');
  const esito = await eseguiTool({ programma, args: [flagVersione], spawnFn, segreti });
  if (esito.codice !== 0) {
    throw guasto('VERSIONE_ILLEGIBILE', `Il tool ${programma} non dice la sua versione (uscita ${esito.codice}).`);
  }
  const m = espressione.exec(`${esito.stdout}\n${esito.stderr}`);
  if (!m || !m[1]) {
    throw guasto('VERSIONE_ILLEGIBILE', redigi(`Versione non riconosciuta da ${programma}: ${esito.stdout.trim().slice(0, 120)}`, segreti));
  }
  return m[1];
}

/* --- Costruttori di argomenti: qui vivono i vincoli del piano ------------------ */

function argomentiPgDump({ db, schema = null, dir, formato = 'directory', jobs = 1, compress = true } = {}) {
  if (!db) throw guasto('INVALIDO', 'Database PostgreSQL mancante.');
  if (!dir) throw guasto('INVALIDO', 'Directory di destinazione mancante.');
  if (formato === 'directory' && Number(jobs) < 1) throw guasto('INVALIDO', 'Parallelismo pg_dump non valido.');
  // Il dump parallelo nativo esiste solo in directory: senza, i worker non si
  // aprono e ogni pagina leggerebbe la sua snapshot — mai un istante solo.
  if (formato !== 'directory' && Number(jobs) > 1) {
    throw guasto('COMBINAZIONE_VIETATA', 'pg_dump parallelo richiede il formato directory.');
  }
  const args = [`--dbname=${db}`, `--format=${formato === 'directory' ? 'directory' : 'custom'}`, `--file=${dir}`];
  if (schema) args.push(`--schema=${schema}`);
  if (formato === 'directory' && Number(jobs) > 1) args.push(`--jobs=${Number(jobs)}`);
  if (compress && formato !== 'directory') args.push('--compress=6');
  return args;
}

function argomentiPgRestore({ dir = null, file = null, db, schema = null, jobs = 1, singolaTransazione = false } = {}) {
  if (!db) throw guasto('INVALIDO', 'Database PostgreSQL di destinazione mancante.');
  if (!dir && !file) throw guasto('INVALIDO', 'Sorgente del restore mancante (directory o file).');
  // `--jobs` non si combina con `--single-transaction`: parallelismo e
  // atomicità si ottengono con staging e promozione, non con entrambe le
  // opzioni (documentazione di pg_restore, §8 del piano).
  if (Number(jobs) > 1 && singolaTransazione) {
    throw guasto('COMBINAZIONE_VIETATA', 'pg_restore: --jobs non si combina con --single-transaction.');
  }
  const args = [`--dbname=${db}`, '--no-owner'];
  if (dir) args.push(`--format=directory`, dir);
  else args.push(file);
  if (schema) args.push(`--schema=${schema}`);
  if (Number(jobs) > 1) args.push(`--jobs=${Number(jobs)}`);
  if (singolaTransazione) args.push('--single-transaction');
  return args;
}

/**
 * Come si indica il server a un tool Mongo: dal file di configurazione se
 * l'URI porta credenziali, altrimenti direttamente. Fail-closed: un URI con
 * password e nessun file è un ERRORE, non un ripiego su `--uri` — è
 * esattamente la regola che il modulo dichiara e che si perdeva qui.
 */
function riferimentoMongo({ uri, fileConfig }) {
  if (fileConfig) return [`--config=${fileConfig}`];
  if (!uri) return [];
  if (uriConSegreto(uri)) {
    throw guasto('SEGRETO_ESPOSTO',
      'URI MongoDB con credenziali: va passato in un file di configurazione (fileConfig), non fra gli argomenti, dove `ps` lo mostrerebbe a ogni utente della macchina.');
  }
  return [`--uri=${uri}`];
}

function argomentiMongodump({ uri = null, db = null, collection = null, query = null, oplog = false, dir, fileConfig = null } = {}) {
  if (!dir) throw guasto('INVALIDO', 'Directory di destinazione mancante.');
  // `--oplog` non supporta selezione di DB/collection/query: combinarli
  // produrrebbe un dump che si dichiara completo e non lo è (§5 del piano).
  if (oplog && (db || collection || query)) {
    throw guasto('COMBINAZIONE_VIETATA', 'mongodump: --oplog non si combina con selezione di database, collection o query.');
  }
  const args = [`--out=${dir}`];
  args.push(...riferimentoMongo({ uri, fileConfig }));
  if (db) args.push(`--db=${db}`);
  if (collection) args.push(`--collection=${collection}`);
  if (query) args.push(`--query=${query}`);
  if (oplog) args.push('--oplog');
  return args;
}

function argomentiMongorestore({ uri = null, dir, nsInclude = null, nsEsclude = null, fileConfig = null } = {}) {
  if (!dir) throw guasto('INVALIDO', 'Directory sorgente mancante.');
  const args = [dir];
  args.push(...riferimentoMongo({ uri, fileConfig }));
  for (const ns of nsInclude || []) args.push(`--nsInclude=${ns}`);
  for (const ns of nsEsclude || []) args.push(`--nsExclude=${ns}`);
  return args;
}

/**
 * Cerca un binario: prima la variabile dedicata (`CODEDB_PG_DUMP`), poi il
 * PATH. Se manca, l'errore dice come installarlo invece di suggerire un
 * percorso alternativo con garanzie diverse.
 */
function disponibilita({ nomi = [], variabile = null, env = process.env, cercaFn = null } = {}) {
  const dedicato = variabile && String(env[variabile] || '').trim();
  if (dedicato) return { trovato: true, percorso: dedicato, via: variabile };
  const percorsi = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const prova = cercaFn || ((nome) => {
    for (const dir of percorsi) {
      // Solo eseguibili che `spawn` sa lanciare con `shell: false`. Un `.cmd`
      // o un `.bat` richiedono l'interprete di comandi, e da Node 18.20/20.12
      // (CVE-2024-27980) spawn li RIFIUTA senza shell: accettarli qui voleva
      // dire trovare il tool e poi fallire con «Impossibile avviare», cioè un
      // messaggio che dice il contrario della causa. Usare la shell per
      // lanciarli non è un'alternativa: rimetterebbe un nome di database in
      // mano all'interprete.
      for (const candidato of process.platform === 'win32' ? [`${nome}.exe`, `${nome}.com`, nome] : [nome]) {
        const file = path.join(dir, candidato);
        try {
          fs.accessSync(file, fs.constants.X_OK);
          return file;
        } catch { /* continua */ }
      }
    }
    return null;
  });
  for (const nome of nomi) {
    const trovato = prova(nome);
    if (trovato) return { trovato: true, percorso: trovato, via: 'PATH' };
  }
  throw guasto('TOOL_ASSENTE',
    `Tool nativo assente (${nomi.join(' / ')}): installalo dal pacchetto ufficiale del DBMS oppure punta ${variabile || 'la variabile dedicata'} al binario`
    + (process.platform === 'win32'
      ? ' (l’eseguibile vero, non il lanciatore .cmd: va avviato senza shell).'
      : '.')
    + ' Nessun percorso alternativo verrà usato in silenzio.');
}

/**
 * Quale motore di export puo' davvero essere usato su un DBMS, ADESSO.
 *
 * Il piano di export DICHIARA il proprio backend, e dichiararlo «nativo»
 * quando il binario non c'e' sarebbe la promessa che il piano esiste per non
 * fare: l'esecuzione fallirebbe dopo la conferma, non prima. Qui si guarda, e
 * si torna sempre un backend usabile piu' il MOTIVO per cui non e' l'altro —
 * l'assenza di un tool e' un'informazione per chi esporta, non un dettaglio.
 *
 * Il ripiego su `incorporato` e' sempre valido: e' il motore che CodeDB ha
 * dentro, quello che fa i backup oggi.
 */
const TOOL_PER_MOTORE = Object.freeze({
  mysql: { nomi: ['mysqldump'], variabile: 'CODEDB_MYSQLDUMP' },
  postgresql: { nomi: ['pg_dump'], variabile: 'CODEDB_PG_DUMP' },
  mongodb: { nomi: ['mongodump'], variabile: 'CODEDB_MONGODUMP' },
});

function backendDisponibile(dbType, { env = process.env, cercaFn = null } = {}) {
  const spec = TOOL_PER_MOTORE[String(dbType || '').toLowerCase()];
  if (!spec) return { backend: 'incorporato', nativo: null, motivo: `Nessun tool nativo previsto per "${dbType}".` };
  try {
    const trovato = disponibilita({ ...spec, env, cercaFn });
    return { backend: 'nativo', nativo: { tool: spec.nomi[0], percorso: trovato.percorso, via: trovato.via }, motivo: null };
  } catch (err) {
    return { backend: 'incorporato', nativo: null, motivo: err.message };
  }
}

module.exports = {
  eseguiTool, uccidiAlbero, versioneTool, redigi, backendDisponibile, TOOL_PER_MOTORE,
  fileCredenziali, rimuoviCredenziali, rigaPgpass, contenutoConfigMongo, uriConSegreto,
  argomentiPgDump, argomentiPgRestore, argomentiMongodump, argomentiMongorestore,
  disponibilita,
};

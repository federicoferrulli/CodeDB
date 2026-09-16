'use strict';

// I tool nativi si provano senza installare nulla: lo spawn si inietta e finge
// il processo. Ciò che si prova è il contratto del piano §4: mai la shell, mai
// password in argomenti o log, combinazioni vietate rifiutate prima del lavoro,
// uccisione dell'intero albero, versioni verificate.

const assert = require('assert');
const fs = require('fs');
const { EventEmitter } = require('events');
const {
  eseguiTool, versioneTool, redigi,
  fileCredenziali, rimuoviCredenziali, rigaPgpass,
  argomentiPgDump, argomentiPgRestore, argomentiMongodump, argomentiMongorestore,
  disponibilita, contenutoConfigMongo, uriConSegreto,
} = require('../backup/lib/nativi');

function processoFinto({ codice = 0, stdout = '', stderr = '', maiChiudere = false } = {}) {
  const figlio = new EventEmitter();
  figlio.stdout = new EventEmitter();
  figlio.stderr = new EventEmitter();
  figlio.stdin = { scritto: [], write(c) { this.scritto.push(String(c)); }, end() {} };
  figlio.pid = 4242;
  figlio.exitCode = null;
  figlio.chiamate = null;
  process.nextTick(() => {
    if (stdout) figlio.stdout.emit('data', stdout);
    if (stderr) figlio.stderr.emit('data', stderr);
    if (!maiChiudere) {
      figlio.exitCode = codice;
      figlio.emit('close', codice, null);
    }
  });
  return figlio;
}

function spawnFinto(figlio, viste = {}) {
  return (programma, args, opts) => {
    viste.programma = programma;
    viste.args = args;
    viste.opts = opts;
    return figlio;
  };
}

(async () => {
  /* --- Esecuzione ------------------------------------------------------------- */

  {
    const figlio = processoFinto({ stdout: 'fatto\n', stderr: 'nota\n' });
    const viste = {};
    const esito = await eseguiTool({
      programma: 'pg_dump', args: ['--dbname=nomedb strano$(x)', '--file=dir'],
      env: { PGPASSFILE: '/tmp/x' }, spawnFn: spawnFinto(figlio, viste),
    });
    assert.strictEqual(esito.codice, 0);
    assert.strictEqual(esito.stdout, 'fatto\n');
    assert.strictEqual(esito.stderr, 'nota\n');
    assert.ok(Number.isFinite(esito.durataMs));
    // Mai la shell, mai una riga unica: l'array arriva intatto, anche con
    // spazi e `$(…)` dentro — che la shell avrebbe eseguito.
    assert.deepStrictEqual(viste.args, ['--dbname=nomedb strano$(x)', '--file=dir']);
    assert.strictEqual(viste.opts.shell, false);
    assert.strictEqual(viste.opts.windowsHide, true, 'niente finestre su Windows');
    assert.strictEqual(viste.opts.env.PGPASSFILE, '/tmp/x', 'ambiente aggiunto, non sostituito');
    assert.ok(Object.keys(viste.opts.env).length > 1, 'l ambiente del processo resta disponibile al tool');
    console.log('  OK   spawn con array, senza shell, ambiente aggiunto');
  }

  {
    const figlio = processoFinto({ codice: 3, stderr: 'pg_dump: errore grave' });
    const esito = await eseguiTool({ programma: 'pg_dump', args: [], spawnFn: () => figlio });
    assert.strictEqual(esito.codice, 3, 'il codice di uscita si verifica al chiamante, non si nasconde');
    assert.match(esito.stderr, /grave/);
    await assert.rejects(
      eseguiTool({ programma: 'inesistente-xyz', args: [], spawnFn: () => { throw new Error('spawn ENOENT'); } }),
      (err) => err.codice === 'AVVIO_FALLITO',
      'avvio impossibile dichiarato',
    );
    const morente = new EventEmitter();
    morente.stdout = new EventEmitter();
    morente.stderr = new EventEmitter();
    morente.stdin = { write() {}, end() {} };
    process.nextTick(() => morente.emit('error', new Error('spawn EACCES')));
    await assert.rejects(
      eseguiTool({ programma: 'x', args: [], spawnFn: () => morente }),
      (err) => err.codice === 'AVVIO_FALLITO',
    );
    console.log('  OK   uscita nonzero riportata, avvio fallito dichiarato');
  }

  {
    const uccisi = [];
    const figlio = processoFinto({ maiChiudere: true });
    const controller = new AbortController();
    const promessa = eseguiTool({
      programma: 'mongodump', args: [], segnale: controller.signal, spawnFn: () => figlio,
      uccidiFn: (pid) => uccisi.push(pid),
    });
    controller.abort();
    await assert.rejects(promessa, /annullato/i);
    assert.deepStrictEqual(uccisi, [4242], 'abort uccide l albero, non lo orfana');
    const uccisi2 = [];
    const figlio2 = processoFinto({ maiChiudere: true });
    // Il timer del modulo è unref'd (non trattiene lo shutdown per un tool
    // appeso): nel test, dove non resta altro handle, il loop uscirebbe prima
    // dei 15 ms. Il watchdog ref'd tiene vivo il loop e proverebbe il guasto.
    const watchdog = new Promise((_, rej) => setTimeout(() => rej(new Error('watchdog: timer non scattato')), 2000));
    await assert.rejects(
      Promise.race([eseguiTool({ programma: 'pg_dump', args: [], timeoutMs: 15, spawnFn: () => figlio2, uccidiFn: (pid) => uccisi2.push(pid) }), watchdog]),
      /tempo massimo/i,
    );
    assert.deepStrictEqual(uccisi2, [4242], 'timeout uccide l albero');
    console.log('  OK   abort e timeout uccidono l intero albero');
  }

  {
    const figlio = processoFinto({});
    await eseguiTool({ programma: 'mongodump', args: [], input: 'segreta-pw\n', spawnFn: () => figlio });
    assert.deepStrictEqual(figlio.stdin.scritto, ['segreta-pw\n'], 'la password al prompt va sullo stdin');
    console.log('  OK   password solo su stdin, mai negli argomenti');
  }

  /* --- Redazione e credenziali -------------------------------------------------- */

  {
    assert.strictEqual(redigi('pw=segreta-123 ok', ['segreta-123']), 'pw=*** ok');
    assert.strictEqual(redigi('niente', ['abc']), 'niente', 'segreti corti ignorati');
    assert.strictEqual(redigi(null, ['x'.repeat(10)]), '');
    const { cartella, file } = fileCredenziali({ contenuto: 'pw\n' });
    // Su Windows i bit POSIX sono emulati: 0600 resta la richiesta corretta ma
    // la verifica esatta vale solo su POSIX (lì la directory utente fa fede).
    if (process.platform !== 'win32') {
      const modo = fs.statSync(file).mode & 0o777;
      assert.strictEqual(modo, 0o600, 'credenziali leggibili solo dal proprietario');
    } else {
      assert.ok(fs.existsSync(file), 'file di credenziali creato');
    }
    assert.throws(() => fileCredenziali({ dir: cartella, prefisso: 'stesso-', contenuto: 'x' }) && fileCredenziali({ dir: cartella, prefisso: 'stesso-', contenuto: 'x' }), /EEXIST/,
      'mai sovrascrivere un file di credenziali');
    rimuoviCredenziali({ cartella, file });
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(rigaPgpass({ host: 'h', porta: 5432, db: 'd', utente: 'u', password: 'p:a\\b' }), 'h:5432:d:u:p\\:a\\\\b\n');
    assert.throws(() => rigaPgpass({ utente: 'u' }), /incomplete/i);
    console.log('  OK   redazione, file 0600 esclusivi e PGPASSFILE scappata');
  }

  /* --- Versioni --------------------------------------------------------------------- */

  {
    const pg = await versioneTool({
      programma: 'pg_dump', espressione: /pg_dump \(PostgreSQL\) (\d+\.\d+)/,
      spawnFn: () => processoFinto({ stdout: 'pg_dump (PostgreSQL) 18.1\n' }),
    });
    assert.strictEqual(pg, '18.1');
    const mongo = await versioneTool({
      programma: 'mongodump', espressione: /version v([\d.]+)/,
      spawnFn: () => processoFinto({ stdout: 'mongodump version v100.12.0\n' }),
    });
    assert.strictEqual(mongo, '100.12.0');
    await assert.rejects(versioneTool({
      programma: 'pg_dump', espressione: /pg_dump \(PostgreSQL\) (\d+\.\d+)/,
      spawnFn: () => processoFinto({ codice: 1, stderr: 'errore' }),
    }), /non dice la sua versione/);
    await assert.rejects(versioneTool({
      programma: 'pg_dump', espressione: /pg_dump \(PostgreSQL\) (\d+\.\d+)/,
      spawnFn: () => processoFinto({ stdout: 'output strano' }),
    }), /non riconosciuta/);
    console.log('  OK   versioni parsate, illeggibili rifiutate');
  }

  /* --- Vincoli del piano --------------------------------------------------------------- */

  {
    assert.deepStrictEqual(
      argomentiPgDump({ db: 'negozio', dir: '/tmp/x', jobs: 4 }),
      ['--dbname=negozio', '--format=directory', '--file=/tmp/x', '--jobs=4'],
    );
    assert.throws(() => argomentiPgDump({ db: 'n', dir: '/t', formato: 'custom', jobs: 4 }),
      /directory/, 'parallelo solo in directory: niente snapshot indipendenti per worker');
    assert.throws(() => argomentiPgRestore({ dir: '/t', db: 'n', jobs: 4, singolaTransazione: true }),
      /single-transaction/, 'jobs e atomicità non si sommano');
    assert.deepStrictEqual(argomentiPgRestore({ dir: '/t', db: 'n' })[0], '--dbname=n');
    assert.throws(() => argomentiMongodump({ dir: '/t', db: 'negozio', oplog: true }),
      /oplog/i, '--oplog non supporta selezione: mai un dump che si crede completo');
    assert.deepStrictEqual(argomentiMongodump({ dir: '/t', oplog: true }), ['--out=/t', '--oplog']);
    assert.deepStrictEqual(
      argomentiMongorestore({ dir: '/t', nsInclude: ['negozio.*'] }),
      ['/t', '--nsInclude=negozio.*'],
    );
    assert.throws(() => argomentiPgDump({ dir: '/t' }), /mancante/i);
    console.log('  OK   combinazioni vietate rifiutate prima del lavoro');
  }

  /* --- Credenziali Mongo fuori dagli argomenti ------------------------------------------- */

  {
    // Un URI MongoDB porta la password DENTRO di sé: `--uri=…` la mette nella
    // riga di comando, dove `ps` la mostra a ogni utente della macchina. È la
    // regola che il modulo dichiara non negoziabile, e valeva per PostgreSQL e
    // MySQL ma non qui.
    assert.strictEqual(uriConSegreto('mongodb://utente:segreta@host/'), true);
    assert.strictEqual(uriConSegreto('mongodb+srv://utente:segreta@host/'), true);
    assert.strictEqual(uriConSegreto('mongodb://utente@host/'), false, 'senza password non è un segreto');
    assert.strictEqual(uriConSegreto('mongodb://host:27017/'), false);

    for (const costruisci of [argomentiMongodump, argomentiMongorestore]) {
      assert.throws(() => costruisci({ dir: '/t', uri: 'mongodb://utente:segreta@host/' }),
        /file di configurazione/i, 'fail-closed: mai un ripiego silenzioso su --uri');
      const args = costruisci({ dir: '/t', fileConfig: '/run/cred.yaml' });
      assert(args.includes('--config=/run/cred.yaml'), 'le credenziali passano dal file');
      assert(!args.some((a) => a.startsWith('--uri=')), 'nessun --uri quando c è il file');
    }
    // Un URI senza credenziali non ha niente da nascondere e resta diretto.
    assert(argomentiMongodump({ dir: '/t', uri: 'mongodb://host/' }).includes('--uri=mongodb://host/'));

    assert.strictEqual(contenutoConfigMongo({ uri: 'mongodb://u:p@h/' }), 'uri: mongodb://u:p@h/\n');
    assert.throws(() => contenutoConfigMongo({ uri: 'mongodb://h/ e poi altro' }), /spazi/i);
    assert.throws(() => contenutoConfigMongo({}), /mancante/i);
    console.log('  OK   credenziali Mongo nel file, mai negli argomenti');
  }

  /* --- Output limitato ------------------------------------------------------------------- */

  {
    // `stdout += …` senza tetto trasforma un tool loquace in un OOM del server.
    // Si conserva la coda — dove i tool scrivono l'errore — e si DICHIARA il
    // troncamento invece di far credere che il tool abbia detto solo quello.
    process.env.CODEDB_TOOL_MAX_OUTPUT_BYTES = '64';
    delete require.cache[require.resolve('../backup/lib/nativi')];
    const { eseguiTool: eseguiConTetto } = require('../backup/lib/nativi');
    const esito = await eseguiConTetto({
      programma: 'finto',
      spawnFn: () => {
        const p = new EventEmitter();
        p.stdout = new EventEmitter();
        p.stderr = new EventEmitter();
        p.stdin = { write() {}, end() {} };
        setImmediate(() => {
          p.stdout.emit('data', 'x'.repeat(500));
          p.stdout.emit('data', 'CODA-FINALE');
          p.emit('close', 0, null);
        });
        return p;
      },
    });
    assert.strictEqual(esito.stdout.length, 64, 'output tenuto sotto il tetto');
    assert(esito.stdout.endsWith('CODA-FINALE'), 'si conserva la coda, dove sta l errore');
    assert.strictEqual(esito.troncato, true, 'il troncamento è dichiarato');
    delete process.env.CODEDB_TOOL_MAX_OUTPUT_BYTES;
    delete require.cache[require.resolve('../backup/lib/nativi')];
    console.log('  OK   output dei tool con tetto dichiarato');
  }

  /* --- Disponibilità ---------------------------------------------------------------------- */

  {
    const d = disponibilita({ nomi: ['pg_dump'], variabile: 'CODEDB_PG_DUMP', env: { CODEDB_PG_DUMP: '/opt/pg/bin/pg_dump' } });
    assert.deepStrictEqual([d.trovato, d.percorso, d.via], [true, '/opt/pg/bin/pg_dump', 'CODEDB_PG_DUMP']);
    const p = disponibilita({ nomi: ['pg_dump'], env: { PATH: '' }, cercaFn: (nome) => (nome === 'pg_dump' ? '/usr/bin/pg_dump' : null) });
    assert.strictEqual(p.percorso, '/usr/bin/pg_dump');
    assert.throws(() => disponibilita({ nomi: ['pg_dump'], variabile: 'CODEDB_PG_DUMP', env: { PATH: '' }, cercaFn: () => null }),
      /assente.*installalo/i, 'assenza con istruzioni, non fallback silenzioso');
    // `spawn` con `shell: false` RIFIUTA `.cmd`/`.bat` (CVE-2024-27980):
    // proporli qui voleva dire trovare il tool e poi fallire con «Impossibile
    // avviare», cioè un messaggio che dice il contrario della causa.
    const provati = [];
    try {
      disponibilita({ nomi: ['mongodump'], env: { PATH: '' }, cercaFn: null });
    } catch { /* PATH vuoto: nessun candidato */ }
    disponibilita({
      nomi: ['mongodump'], env: { PATH: '' },
      cercaFn: (nome) => { provati.push(nome); return '/usr/bin/mongodump'; },
    });
    assert.deepStrictEqual(provati, ['mongodump'], 'il nome arriva intero al cercatore');
    const sorgente = fs.readFileSync(require.resolve('../backup/lib/nativi'), 'utf8');
    assert(!/\$\{nome\}\.cmd/.test(sorgente), 'nessun candidato .cmd: spawn non sa lanciarlo senza shell');
    assert(!/\$\{nome\}\.bat/.test(sorgente));
    console.log('  OK   variabile dedicata, PATH, assenza con istruzioni');
  }

  console.log('  OK   Tool nativi: spawn sicuro, versioni e vincoli passed');
})().catch((err) => {
  console.error('  FAIL Tool nativi:', err.stack || err);
  process.exitCode = 1;
});

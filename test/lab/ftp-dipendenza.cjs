'use strict';

// Dipendenza get-uri → basic-ftp: compatibilità su server solo loopback e limite CPU.
// node test/lab/ftp-dipendenza.cjs [--compatibility] [--sensitivity]
// Il parser ostile gira in un worker terminabile; nessun pacchetto viene modificato.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { createRequire, Module } = require('node:module');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const root = path.resolve(__dirname, '../..');
const requireGetUri = createRequire(require.resolve('get-uri'));
const ftpEntry = requireGetUri.resolve('basic-ftp');
const ftpDir = path.dirname(ftpEntry);
const cpuBudgetMs = 1000;
const body = Buffer.from('CodeDB: caffè, geometrie e dati\n\u0000\u00ff', 'utf8');
const stamp = '20261022123456';
const isoStamp = '2026-10-22T12:34:56.000Z';
const filename = '/cartella/prova caffè.dat';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = ['package.json', 'package-lock.json'];
const normalList = '-rw-r--r-- 1 owner group 42 Jan 1 2020 file.txt\r\n';

function cpuWorker() {
  if (workerData.mutant) {
    const file = path.join(ftpDir, 'parseListUnix.js');
    const source = fs.readFileSync(file, 'utf8');
    assert.equal((source.match(/\{0,7\}/g) || []).length, 2,
      '[FTP-MUTANTE-PARSER] attesi i due limiti della correzione upstream');
    const replacement = source.replace(/\{0,7\}/g, '*');
    const loaded = new Module(file, module);
    loaded.filename = file;
    loaded.paths = Module._nodeModulePaths(path.dirname(file));
    loaded._compile(replacement, file);
    require.cache[file] = loaded;
  }
  const { parseList } = require(path.join(ftpDir, 'parseList.js'));
  // Il prefisso valido seguito da 64 KiB senza dimensione/data esercita il caso
  // GHSA-c475-qrg2-pj4r. Il padre termina il worker dopo un secondo di parsing.
  const malformed = '-rw-r--r-- 1 ' + 'a '.repeat(32768) + '!\r\n';
  parentPort.postMessage({ tipo: 'pronto', byte: Buffer.byteLength(malformed) });
  parentPort.once('message', () => {
    const start = performance.now();
    const result = parseList(malformed + normalList);
    parentPort.postMessage({ tipo: 'risultato', ms: performance.now() - start,
      files: result.map(file => ({ name: file.name, size: file.size })) });
  });
}

async function verificaCpu(mutant = false) {
  const worker = new Worker(__filename, { workerData: { mutant } });
  let timer, byte;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('[FTP-WORKER] avvio non riuscito')), 10000);
      worker.on('error', reject);
      worker.on('exit', code => { if (code) reject(new Error(`[FTP-WORKER] uscita ${code}`)); });
      worker.on('message', message => {
        if (message.tipo === 'pronto') {
          clearTimeout(timer); byte = message.byte;
          timer = setTimeout(() => reject(new Error(`[FTP-CPU] parsing di ${byte} byte oltre ${cpuBudgetMs} ms`)), cpuBudgetMs);
          worker.postMessage('esegui');
        } else if (message.tipo === 'risultato') {
          try {
            assert.deepEqual(message.files, [{ name: 'file.txt', size: 42 }], '[FTP-CPU] il record valido finale deve restare integro');
            assert.ok(message.ms < cpuBudgetMs, '[FTP-CPU] limite CPU superato');
            resolve({ ...message, byte, limiteMs: cpuBudgetMs });
          } catch (error) { reject(error); }
        }
      });
    });
  } finally { clearTimeout(timer); await worker.terminate(); }
}

async function avviaFtp(options = {}) {
  const sockets = new Set(), dataServers = new Set(), commands = [], errors = [];
  const content = options.content || body;
  const hold = (socket, control = false) => { sockets.add(socket); socket.on('error', error => {
    // get-uri chiude subito il controllo su ENOTMODIFIED/ENOTFOUND: Windows può
    // osservare RST invece di FIN. I byte dei trasferimenti hanno oracoli separati.
    if (!(control && error.code === 'ECONNRESET')) errors.push(error.message);
  }); socket.on('close', () => sockets.delete(socket)); return socket; };
  const server = net.createServer(control => {
    hold(control, true); control.setEncoding('utf8');
    let input = '', queued = Promise.resolve(), passive;
    const reply = text => { if (!control.destroyed) control.write(text + '\r\n'); };
    const passiveMode = async mode => {
      const data = net.createServer(); dataServers.add(data);
      const connected = new Promise(resolve => data.once('connection', socket => { hold(socket); resolve(socket); }));
      data.on('error', error => errors.push(error.message));
      data.listen(0, '127.0.0.1'); await once(data, 'listening');
      passive = { data, connected };
      const port = data.address().port;
      if (mode === 'EPSV') { const sep = options.delimiter || '|'; reply(`229 Entering Extended Passive Mode (${sep}${sep}${sep}${port}${sep})`); }
      else reply(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`);
    };
    const transfer = async payload => {
      assert.ok(passive, '[FTP-FIXTURE] trasferimento senza canale passivo');
      const current = passive; passive = undefined;
      reply('150 Apertura canale dati');
      const socket = await current.connected;
      socket.end(payload, () => { reply('226 Trasferimento completato'); current.data.close(); dataServers.delete(current.data); });
    };
    const command = async line => {
      commands.push(line);
      const verb = line.split(' ', 1)[0], arg = line.slice(verb.length + 1);
      if (verb === 'USER') reply('331 Password richiesta');
      else if (verb === 'PASS') reply('230 Autenticazione completata');
      else if (verb === 'FEAT') reply(`211-Funzionalita\r\n UTF8\r\n${options.mlsd ? ' MLST type;size;modify;\r\n' : ''}211 Fine`);
      else if (['OPTS', 'TYPE', 'STRU'].includes(verb)) reply('200 OK');
      else if (verb === 'MDTM') reply(options.missing ? '550 File inesistente' : options.list ? '502 MDTM non supportato' : `213 ${stamp}`);
      else if (verb === 'EPSV') {
        if (options.epsv === false) reply('502 EPSV non supportato');
        else if (options.epsv === 'malformed') reply('229 Risposta priva di porta');
        else await passiveMode('EPSV');
      } else if (verb === 'PASV') await passiveMode('PASV');
      else if (verb === 'MLSD') await transfer(`type=file;size=${content.length};modify=${stamp}; ${path.posix.basename(filename)}\r\n`);
      else if (verb === 'LIST') await transfer(options.listing || normalList);
      else if (verb === 'RETR') {
        assert.equal(arg, options.filename || filename, '[FTP-PERCORSO] percorso Unicode e spazi decodificati');
        await transfer(content);
      } else if (verb === 'QUIT') { reply('221 Fine'); control.end(); }
      else if (verb === 'PWD') reply('257 "/"');
      else reply('502 Comando non previsto');
    };
    control.on('data', chunk => {
      input += chunk;
      let index;
      while ((index = input.indexOf('\r\n')) !== -1) {
        const line = input.slice(0, index); input = input.slice(index + 2);
        queued = queued.then(() => command(line)).catch(error => { errors.push(error.message); reply('451 Errore fixture'); });
      }
    });
    reply('220 Fixture CodeDB locale');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    port: server.address().port, commands, errors,
    uri: `ftp://utente%20test:password%20test@127.0.0.1:${server.address().port}${encodeURI(options.filename || filename)}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      for (const data of dataServers) data.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function leggi(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }
async function usaFtp(options, test) {
  const fixture = await avviaFtp(options);
  try { const result = await test(fixture); assert.deepEqual(fixture.errors, [], '[FTP-FIXTURE] nessun errore del server'); return { ...result, commands: fixture.commands }; }
  finally { await fixture.close(); }
}

function casi() {
  const { getUri } = require('get-uri');
  const { Client } = requireGetUri('basic-ftp');
  const { PacProxyAgent } = require('pac-proxy-agent');
  const download = options => usaFtp(options, async fixture => {
    const stream = await getUri(fixture.uri);
    assert.deepEqual(await leggi(stream), body, '[FTP-CONTENUTO] byte esatti del download');
    assert.equal(stream.lastModified.toISOString(), isoStamp, '[FTP-DATA] data MDTM/MLSD');
    assert.ok(fixture.commands.includes('USER utente test') && fixture.commands.includes('PASS password test'), '[FTP-AUTH] credenziali URI decodificate');
    assert.ok(fixture.commands.includes('EPSV'), '[FTP-EPSV] prima scelta EPSV');
    assert.equal(fixture.commands.includes('PASV'), options.epsv === false, '[FTP-PASV] ripiego solo quando EPSV non supportato');
    if (options.list) assert.ok(fixture.commands.some(line => line.startsWith('MLSD ')), '[FTP-MLSD] fallback nativo con data');
  });
  return [
    { id: 'get-uri-epsv', run: () => download({}) },
    { id: 'get-uri-pasv', run: () => download({ epsv: false }) },
    { id: 'get-uri-epsv-ibmi', run: () => download({ delimiter: '!' }) },
    { id: 'get-uri-mlsd', run: () => download({ list: true, mlsd: true }) },
    { id: 'get-uri-cache', run: () => usaFtp({}, async fixture => {
      const stream = await getUri(fixture.uri); assert.deepEqual(await leggi(stream), body);
      await assert.rejects(getUri(fixture.uri, { cache: stream }), error => error.code === 'ENOTMODIFIED', '[FTP-CACHE] nessun secondo download invariato');
      assert.equal(fixture.commands.filter(line => line.startsWith('RETR ')).length, 1);
      assert.equal(fixture.commands.filter(line => line.startsWith('MDTM ')).length, 2);
    }) },
    { id: 'get-uri-assente', run: () => usaFtp({ missing: true }, async fixture => {
      await assert.rejects(getUri(fixture.uri), error => error.code === 'ENOTFOUND', '[FTP-ASSENTE] errore 550 propagato');
      assert.equal(fixture.commands.some(line => /^(RETR|LIST|MLSD|EPSV|PASV)\b/.test(line)), false);
    }) },
    { id: 'get-uri-unix-raggiungibile', run: () => usaFtp({ list: true }, async fixture => {
      // Il parser Unix non fornisce modifiedAt: get-uri termina ENOTFOUND, ma
      // prima legge e interpreta LIST. È il percorso della vulnerabilità.
      await assert.rejects(getUri(fixture.uri), error => error.code === 'ENOTFOUND');
      assert.ok(fixture.commands.some(line => line.startsWith('LIST ')), '[FTP-UNIX] LIST realmente attraversato');
    }) },
    { id: 'client-list-unix', run: () => usaFtp({}, async fixture => {
      const client = new Client(3000);
      try {
        await client.access({ host: '127.0.0.1', port: fixture.port });
        const list = await client.list('/cartella');
        assert.deepEqual(list.map(file => ({ name: file.name, size: file.size, user: file.user, group: file.group, file: file.isFile })),
          [{ name: 'file.txt', size: 42, user: 'owner', group: 'group', file: true }], '[FTP-LIST] catalogo Unix esatto');
      } finally { client.close(); }
    }) },
    { id: 'client-epsv-malformato', run: () => usaFtp({ epsv: 'malformed' }, async fixture => {
      const client = new Client(3000), chunks = [];
      const sink = new Transform({ transform(chunk, encoding, done) { chunks.push(chunk); done(); } });
      try {
        await client.access({ host: '127.0.0.1', port: fixture.port });
        await client.downloadTo(sink, filename);
        assert.deepEqual(Buffer.concat(chunks), body);
        assert.ok(fixture.commands.includes('EPSV') && fixture.commands.includes('PASV'), '[FTP-EPSV-INVALIDO] ripiego PASV dopo risposta invalida');
      } finally { client.close(); }
    }) },
    { id: 'pac-ftp-http-cache', run: async () => {
      const pac = 'function FindProxyForURL(url, host) { return host === "127.0.0.1" && url.indexOf("/consentito") >= 0 ? "DIRECT" : "PROXY 127.0.0.1:1"; }';
      return usaFtp({ content: Buffer.from(pac), filename: '/proxy.pac' }, async fixture => {
        const server = http.createServer((req, res) => { assert.equal(req.url, '/consentito'); res.end(body); });
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const agent = new PacProxyAgent(fixture.uri);
        const httpRead = () => new Promise((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${server.address().port}/consentito`, { agent }, async res => { try { resolve(await leggi(res)); } catch (error) { reject(error); } });
          req.once('error', reject); req.setTimeout(5000, () => req.destroy(new Error('[FTP-PAC] timeout richiesta locale')));
        });
        try {
          assert.deepEqual(await httpRead(), body, '[FTP-PAC] richiesta HTTP tramite PAC FTP');
          const resolver = await agent.getResolver();
          assert.equal(await resolver('http://127.0.0.1/negato'), 'PROXY 127.0.0.1:1', '[FTP-PAC] la policy PAC viene eseguita');
          assert.deepEqual(await httpRead(), body);
          assert.equal(fixture.commands.filter(line => line.startsWith('RETR ')).length, 1, '[FTP-PAC-CACHE] riuso PAC senza riscaricarlo');
          assert.ok(fixture.commands.filter(line => line.startsWith('MDTM ')).length >= 2);
        } finally { agent.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      });
    } },
    { id: 'parser-cpu', run: () => verificaCpu() },
  ];
}

async function muta(id, run) {
  const { Client } = requireGetUri('basic-ftp');
  const { PacProxyAgent } = require('pac-proxy-agent');
  let object, key, replacement;
  if (id === 'contenuto') {
    object = Client.prototype; key = 'downloadTo'; const original = object[key];
    replacement = function(destination, ...args) {
      let modified = false;
      const corrupt = new Transform({ transform(chunk, encoding, done) { const value = Buffer.from(chunk); if (!modified && value.length) { value[0] ^= 1; modified = true; } done(null, value); } });
      corrupt.pipe(destination); return original.call(this, corrupt, ...args);
    };
  } else if (id === 'epsv') {
    object = Client.prototype; key = 'access'; const original = object[key];
    replacement = async function(...args) { const result = await original.apply(this, args); this.prepareTransfer = require(path.join(ftpDir, 'transfer.js')).enterPassiveModeIPv4; return result; };
  } else if (id === 'pac') {
    object = PacProxyAgent.prototype; key = 'loadPacFile'; const original = object[key];
    replacement = async function(...args) { await original.apply(this, args); return 'function FindProxyForURL() { return "DIRECT"; }'; };
  } else return verificaCpu(true);
  const original = object[key]; object[key] = replacement;
  try { return await run(); } finally { object[key] = original; }
}

async function main() {
  const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/dipendenza-ftp/baseline');
  const manifest = require(path.resolve(ftpDir, '../package.json'));
  const report = { suite: 'ftp-dipendenza', iniziato: new Date().toISOString(), node: process.version,
    basicFtp: manifest.version, basicFtpPath: path.relative(root, ftpEntry), getUri: require('get-uri/package.json').version,
    pacProxyAgent: require('pac-proxy-agent/package.json').version, rete: 'solo 127.0.0.1, porte effimere',
    hashesPrima: Object.fromEntries(files.map(file => [file, hash(path.join(root, file))])), risultati: [], sensibilita: [] };
  for (const test of casi()) {
    if (test.id === 'parser-cpu' && process.argv.includes('--compatibility')) continue;
    const entry = { id: test.id, ok: false }, start = performance.now();
    try { entry.dettagli = await test.run(); entry.ok = true; }
    catch (error) { entry.errore = error.stack; }
    entry.ms = performance.now() - start; report.risultati.push(entry);
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.id}${entry.errore ? ': ' + entry.errore.split('\n')[0] : ''}`);
  }
  if (process.argv.includes('--sensitivity')) for (const [mutant, testId, marker] of [
    ['contenuto', 'get-uri-epsv', 'FTP-CONTENUTO'], ['epsv', 'get-uri-epsv', 'FTP-EPSV'],
    ['pac', 'pac-ftp-http-cache', 'FTP-PAC'], ['parser', 'parser-cpu', 'FTP-CPU'],
  ]) {
    if (testId === 'parser-cpu' && process.argv.includes('--compatibility')) continue;
    const entry = { mutante: mutant, test: testId, ok: false };
    if (!report.risultati.find(result => result.id === testId)?.ok) entry.saltato = 'Prerequisito di controllo non verde';
    else {
      try { await muta(mutant, casi().find(test => test.id === testId).run); entry.errore = 'Mutante sopravvissuto'; }
      catch (error) { entry.errore = error.stack; entry.ok = error.message.includes(marker); }
    }
    report.sensibilita.push(entry); console.log(`${entry.ok ? 'PASS' : entry.saltato ? 'SKIP' : 'FAIL'} mutante ${mutant}`);
  }
  report.hashesDopo = Object.fromEntries(files.map(file => [file, hash(path.join(root, file))]));
  report.dipendenzeIntatte = JSON.stringify(report.hashesPrima) === JSON.stringify(report.hashesDopo);
  report.ok = report.dipendenzeIntatte && report.risultati.every(result => result.ok) && report.sensibilita.every(result => result.ok);
  report.finito = new Date().toISOString(); fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'ftp-dipendenza.json'), JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (!isMainThread) cpuWorker();
else main().catch(error => { console.error(error); process.exitCode = 1; });

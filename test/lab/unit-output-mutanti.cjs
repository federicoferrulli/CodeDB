'use strict';

// Prova l'inoltro con il classificatore reale, processi figli e log originali.
// --sensitivity dimostra anche che togliere i prefissi, ignorare i FAIL del
// controllo o accettare una falsa rilevazione rende rossa questa suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const flags = process.argv.filter(arg => arg.startsWith('--mutant-'));
function carica(file, cerca, sostituisci) {
  const filename = require.resolve(file), source = fs.readFileSync(filename, 'utf8');
  assert.equal(source.split(cerca).length - 1, 1, 'La mutazione deve intercettare una sola istruzione');
  const copy = new Module(filename, module); copy.filename = filename; copy.paths = module.paths;
  copy._compile(source.replace(cerca, sostituisci), filename); return copy.exports;
}
const output = flags.includes('--mutant-prefix')
  ? carica('./output-mutanti.cjs', 'return `MUTANTE ${nome}: `;', "return '';") : require('./output-mutanti.cjs');
const runner = flags.includes('--mutant-control')
  ? carica('./runner.cjs', 'code !== 0 || errori.length', 'code !== 0') : require('./runner.cjs');

async function fixtureParent(mode, dir) {
  const raw = fs.createWriteStream(path.join(dir, 'figlio-originale.log'));
  const child = spawn(process.execPath, [__filename, '--fixture-child', mode], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const mutante = mode === 'controllo-falso-verde' ? null : 'guasto-fixture';
  output.inoltraOutputFiglio(child, { log: raw, mutante });
  const [code] = await once(child, 'close');
  await new Promise(resolve => raw.end(resolve));
  if (mode === 'controllo-falso-verde') return;
  const text = fs.readFileSync(path.join(dir, 'figlio-originale.log'), 'utf8');
  const detected = flags.includes('--mutant-parent') || (code === 1 && text === 'FAIL guasto previsto\n');
  if (!detected) { console.error('FAIL rilevazione mutante: causa assente o diversa'); process.exitCode = 1; }
  else console.log('OK mutante rilevato per la causa esatta');
  if (mode === 'controllo-e-mutante') console.error('FAIL controllo precedente corrotto');
}

async function main() {
  const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/infra-output-mutanti');
  fs.mkdirSync(dir, { recursive: true });
  const report = { suite: 'output-mutanti', verifiche: [], sensibilita: [] };
  async function check(id, action) {
    try { await action(); report.verifiche.push({ id, ok: true }); console.log('OK ' + id); }
    catch (error) { report.verifiche.push({ id, ok: false, errore: error.stack }); console.error('FAIL ' + id + ': ' + error.message); }
  }
  await check('OUTPUT-PREFISSO', () => {
    assert.equal(output.formattaOutputMutante('foto-full', 'FAIL prima\nFAIL seconda\n'), 'MUTANTE foto-full: FAIL prima\nMUTANTE foto-full: FAIL seconda\n');
    assert.equal(output.formattaOutputMutante(null, 'FAIL controllo\n'), 'FAIL controllo\n');
    assert.equal(output.formattaOutputMutante('nome', ''), '');
    for (const name of ['', 'a\nFAIL', true]) assert.throws(() => output.formattaOutputMutante(name, 'testo'), TypeError);
  });
  await check('OUTPUT-CHUNK-UTF8-RAW', async () => {
    const stdout = new PassThrough(), stderr = new PassThrough(), raw = [], displayed = [];
    const sink = { write: chunk => displayed.push(Buffer.from(chunk)) };
    output.inoltraOutputFiglio({ stdout, stderr }, { mutante: 'stream', log: { write: chunk => raw.push(Buffer.from(chunk)) }, stdout: sink, stderr: sink });
    const text = Buffer.from('FAIL caffè 😀\r\nFAIL senza newline'), cut = text.indexOf(Buffer.from('è')) + 1;
    const chunks = [text.subarray(0, cut), Buffer.from('FAIL stderr\n'), text.subarray(cut)];
    const ended = Promise.all([once(stdout, 'end'), once(stderr, 'end')]);
    stdout.write(chunks[0]); stderr.write(chunks[1]); stdout.end(chunks[2]); stderr.end(); await ended;
    assert.deepEqual(Buffer.concat(raw), Buffer.concat(chunks), 'Il log originale deve preservare ogni byte ricevuto');
    const final = Buffer.concat(displayed).toString('utf8');
    assert(final.includes('MUTANTE stream: FAIL caffè 😀\r\n'));
    assert(final.includes('MUTANTE stream: FAIL stderr\n'));
    assert(final.endsWith('MUTANTE stream: FAIL senza newline\n'));
    assert.equal(runner.classifica(0, false, final).esito, 'superato');
  });
  await check('OUTPUT-CONTROLLO-RAW', async () => {
    const stdout = new PassThrough(), raw = [], displayed = [];
    output.inoltraOutputFiglio({ stdout }, { log: { write: chunk => raw.push(Buffer.from(chunk)) }, stdout: { write: chunk => displayed.push(Buffer.from(chunk)) } });
    const text = Buffer.from('FAIL controllo è\n'), ended = once(stdout, 'end');
    stdout.write(text.subarray(0, 8)); stdout.end(text.subarray(8)); await ended;
    assert.deepEqual(Buffer.concat(displayed), text); assert.deepEqual(Buffer.concat(raw), text);
    assert.equal(runner.classifica(0, false, text.toString()).esito, 'fallito', '[OUTPUT-CONTROLLO] FAIL con exit 0 deve restare rosso');
  });
  for (const [mode, expected] of [
    ['controllo-falso-verde', 'fallito'], ['atteso', 'superato'], ['causa-diversa', 'fallito'],
    ['sopravvissuto', 'fallito'], ['causa-extra', 'fallito'], ['controllo-e-mutante', 'fallito'],
  ]) await check('OUTPUT-PARENT-' + mode, async () => {
    const caseDir = path.join(dir, mode); fs.mkdirSync(caseDir, { recursive: true });
    const result = await runner.runSuite({ file: __filename, args: ['--fixture-parent', mode, caseDir, ...flags],
      cwd: root, log: path.join(caseDir, 'padre.log'), timeoutMs: 10000 });
    assert.equal(result.esito, expected, '[OUTPUT-PARENT] ' + mode);
    const raw = fs.readFileSync(path.join(caseDir, 'figlio-originale.log'), 'utf8');
    assert(!raw.includes('MUTANTE '), 'Il log figlio deve restare privo di prefissi');
    if (['causa-diversa', 'sopravvissuto', 'causa-extra'].includes(mode)) assert.equal(result.code, 1, 'Il padre deve fallire se la rilevazione non è provata');
    if (mode === 'atteso') assert.equal(result.code, 0);
  });
  for (const [suite, method, args, subdir] of [
    ['backup-tempi', 'child', [{ id: 'scenario', mutant: 'locale' }], 'scenario'],
    ['backup-indici', 'child', ['mutante-omissione', true], 'mutante-omissione'],
    ['backup-oggetti', 'child', ['mongodb', 'foto-full'], 'mongodb-mutante-foto-full'],
    ['backup-merge-identita', 'child', ['mongodb', 'conteggio'], 'mongodb-mutante-conteggio'],
    ['backup-validator', 'child', ['validator'], 'mutante-validator'],
    ['backup-mysql-schema', 'child', ['fk-cache'], 'mutante-fk-cache'],
    ['backup-pg-generate', 'child', ['backup'], 'mutante-backup'],
    ['backup-disconnessione', 'launch', ['senza-lease'], 'senza-lease'],
  ]) await check('OUTPUT-WRAPPER-' + suite, async () => {
    const filename = path.join(__dirname, suite + '.cjs'), source = fs.readFileSync(filename, 'utf8');
    const parsed = require('@babel/parser').parse(source, { sourceType: 'script' });
    const node = parsed.program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === method);
    assert(node, 'Il test deve caricare il wrapper effettivo');
    let body = source.slice(node.start, node.end);
    if (flags.includes('--mutant-stale')) {
      const changed = body.replace('fs.rmSync(file, { force: true });', '');
      assert.notEqual(changed, body, 'La mutazione deve rimuovere la cancellazione del solo rapporto precedente'); body = changed;
    }
    const base = path.join(dir, suite), childDir = path.join(base, subdir); fs.mkdirSync(childDir, { recursive: true });
    const reportFile = path.join(childDir, suite + '.json'), sentinel = path.join(childDir, 'non-toccare.json');
    fs.writeFileSync(reportFile, JSON.stringify({ stale: true, ok: true, mutazioni: 1, verifiche: [] }));
    fs.writeFileSync(sentinel, 'sentinella');
    const displayed = [], sink = { write: chunk => displayed.push(Buffer.from(chunk)) };
    function spawnFixture() {
      assert(!fs.existsSync(reportFile), '[OUTPUT-STALE] il JSON precedente deve sparire prima dello spawn');
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      setImmediate(() => {
        child.stdout.end('FAIL figlio terminato prima del rapporto\n'); child.stderr.end();
        setImmediate(() => child.emit('close', 1));
      });
      return child;
    }
    const context = { module: { exports: {} }, fs, path, spawn: spawnFixture, __filename: filename, __dirname: path.dirname(filename),
      process: { execPath: process.execPath, env: process.env, stdout: sink, stderr: sink },
      reportDir: base, dir: base, setTimeout, clearTimeout,
      inoltraOutputFiglio: (child, options) => output.inoltraOutputFiglio(child, { ...options, stdout: sink, stderr: sink }) };
    vm.runInNewContext(body + `\nmodule.exports = ${method};`, context, { filename });
    const result = await context.module.exports(...args);
    assert.notEqual(result.stale, true, 'Il wrapper non deve restituire dati di una run precedente');
    assert(result.erroreFatale || result.report === null, 'Un rapporto assente deve essere diagnosticato');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinella', 'I file adiacenti non devono essere rimossi');
    const raw = fs.readFileSync(path.join(childDir, suite === 'backup-disconnessione' ? 'esecuzione.log' : 'console.log'), 'utf8');
    assert.equal(raw, 'FAIL figlio terminato prima del rapporto\n');
    assert.equal(runner.classifica(0, false, Buffer.concat(displayed).toString()).esito, 'superato', 'Il wrapper identifica soltanto l’output mutante');
  });
  await check('OUTPUT-QUERY-RAW', async () => {
    const filename = path.join(__dirname, 'query.cjs'), source = fs.readFileSync(filename, 'utf8');
    const node = require('@babel/parser').parse(source, { sourceType: 'script' }).program.body
      .find(item => item.type === 'FunctionDeclaration' && item.id.name === 'sensibilita');
    let body = source.slice(node.start, node.end);
    if (flags.includes('--mutant-query-raw')) {
      const changed = body.replace('Buffer.concat(rawOutput)', 'Buffer.from(output)');
      assert.notEqual(changed, body, 'La mutazione deve colpire il log originale'); body = changed;
    }
    const base = path.join(dir, 'query-raw'); fs.mkdirSync(base, { recursive: true });
    const cases = [['perdita-riga', 'differenziale-mongodb-righe'], ['update-saltato', 'crud-composito-mysql'],
      ['join-deduplicato', 'join-mysql-mongodb'], ['array-cifre', 'array-postgresql-testo-esatto-insert']];
    for (const [name] of cases) fs.writeFileSync(path.join(base, `query-${name}.json`), '{"stale":true}');
    const original = Buffer.from('FAIL caffè 😀\n'), cut = original.indexOf(Buffer.from('è')) + 1;
    function spawnFixture(_command, _args, options) {
      const name = options.env.LAB_QUERY_MUTANT, file = path.join(base, `query-${name}.json`);
      assert(!fs.existsSync(file), 'Il rapporto query precedente deve essere rimosso prima dello spawn');
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      setImmediate(() => {
        child.stdout.write(original.subarray(0, cut)); child.stdout.end(original.subarray(cut)); child.stderr.end();
        fs.writeFileSync(file, JSON.stringify({ esiti: [{ id: options.env.LAB_QUERY_CASE, ok: false }], cleanupErrors: [] }));
        setImmediate(() => child.emit('close', 1));
      });
      return child;
    }
    const context = { module: { exports: {} }, assert, fs, path, Buffer, spawn: spawnFixture,
      __filename: filename, __dirname: __dirname, process, console: { log() {} },
      esiti: cases.map(([, id]) => ({ id, ok: true })), reportDir: base, started: 'fixture', setTimeout, clearTimeout };
    vm.runInNewContext(body + '\nmodule.exports = sensibilita;', context, { filename }); await context.module.exports();
    for (const [name] of cases) assert.deepEqual(fs.readFileSync(path.join(base, `query-${name}.log`)), original,
      '[OUTPUT-QUERY-RAW] anche il log query deve preservare byte UTF-8 fra chunk distinti');
  });
  if (process.argv.includes('--sensitivity') && report.verifiche.every(item => item.ok)) {
    for (const [flag, marker] of [['--mutant-prefix', 'OUTPUT-PREFISSO'], ['--mutant-control', 'OUTPUT-CONTROLLO-RAW'],
      ['--mutant-parent', 'OUTPUT-PARENT-causa-diversa'], ['--mutant-stale', 'OUTPUT-WRAPPER-backup-tempi'], ['--mutant-query-raw', 'OUTPUT-QUERY-RAW']]) {
      const caseDir = path.join(dir, flag.slice(2)); fs.mkdirSync(caseDir, { recursive: true });
      const child = spawnSync(process.execPath, [__filename, flag], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, LAB_REPORT_DIR: caseDir } });
      fs.writeFileSync(path.join(caseDir, 'console.log'), (child.stdout || '') + (child.stderr || ''));
      const result = JSON.parse(fs.readFileSync(path.join(caseDir, 'output-mutanti.json'), 'utf8'));
      const detected = child.status === 1 && result.verifiche.some(item => item.id === marker && !item.ok);
      report.sensibilita.push({ flag, marker, rilevata: detected, code: child.status });
      console.log(`${detected ? 'OK' : 'FAIL'} sensibilità ${flag}`);
    }
  }
  report.ok = report.verifiche.every(item => item.ok) && report.sensibilita.every(item => item.rilevata);
  fs.writeFileSync(path.join(dir, 'output-mutanti.json'), JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv.includes('--fixture-child')) {
  const mode = process.argv[process.argv.indexOf('--fixture-child') + 1];
  if (mode === 'sopravvissuto') console.log('OK nessuna mutazione rilevata');
  else { console.error(mode === 'causa-diversa' ? 'FAIL database assente' : mode === 'causa-extra' ? 'FAIL guasto previsto\nFAIL database assente' : 'FAIL guasto previsto'); if (mode !== 'controllo-falso-verde') process.exitCode = 1; }
} else {
  const index = process.argv.indexOf('--fixture-parent');
  (index >= 0 ? fixtureParent(process.argv[index + 1], process.argv[index + 2]) : main())
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}

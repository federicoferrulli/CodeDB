'use strict';

// Profilo facoltativo di test nativi: tre nodi MongoDB, PostgreSQL 18 e MySQL.
// Usa solo il compose dei fixture, MAI tools/sql-native.js o le credenziali utente.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/native.cjs
// --no-up riusa i soli container verificati; --no-ui / --no-failover escludono
// esplicitamente i relativi casi, dichiarandoli nel report.
// --mongosh-only ripete runtime e UI mongosh; --ui-only ripete le due suite UI.
// --only=nome-suite,nome-suite seleziona le suite nominate ed esclude il failover.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '../..');
const reportDir = path.resolve(process.env.LAB_NATIVE_REPORT_DIR || path.join(root, '.scratch/lab-reports/native'));
const started = new Date().toISOString();
const results = [];
const omitted = [];
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',').filter(Boolean);
let browserExecutable;
const compose = ['compose', '-f', 'test/fixtures/sql-native-databases.yml'];
const names = ['codedb-sql-test-postgres-1', 'codedb-sql-test-mysql-1', ...[27039, 27040, 27041].map(p => `codedb-sql-node-${p}`)];
function salva() {
  fs.writeFileSync(path.join(reportDir, 'native.json'), JSON.stringify({ started, updated: new Date().toISOString(), results, omitted }, null, 2));
}
function proprieta() {
  for (const name of names) {
    const result = spawnSync('docker', ['inspect', name], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) continue;
    const info = JSON.parse(result.stdout)[0];
    assert.equal(info.Config.Labels['com.docker.compose.project'], 'codedb-sql-test', `Container estraneo: ${name}`);
    assert(['1', 'sql-replica'].includes(info.Config.Labels['codedb.test']), `Label test assente: ${name}`);
  }
}
async function esegui(name, command, args, options = {}) {
  const t = performance.now();
  const log = path.join(reportDir, `${name}.log`);
  const stream = fs.createWriteStream(log);
  // Alcune suite storiche scrivono rapporti versionati: conservarne esattamente
  // lo stato precedente, incluse eventuali modifiche già presenti dell'utente.
  const generated = ({ 'e2e-sql-native': ['query-languages/native-risultati.json'], 'e2e-sql-native-ui': ['query-languages/native-mobile.png'],
    'e2e-mongosh-ui': ['mongosh-2026-10-15/live-ui.png'] }[name] || [])
    .map(relative => { const file = path.join(root, 'test-reports', relative); fs.mkdirSync(path.dirname(file), { recursive: true });
      return { base: path.basename(relative), file, before: fs.existsSync(file) ? fs.readFileSync(file) : null }; });
  let captured = '', timeout = false;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env,
      CODEDB_E2E_DESTRUCTIVE: '1', CODEDB_E2E_FAILOVER_NODES: '1',
      PGPORT: '55439', PG_PORT: '55439', PGPASSWORD: '', PG_PASSWORD: '',
      MYSQL_PORT: '33339', MYSQL_PASSWORD: '', MYSQL_ROOT_PASSWORD: '', MONGO_PORT: '27039',
      E2E_PORT: '3291',
      ...(browserExecutable ? { LAB_BROWSER_EXECUTABLE: browserExecutable } : {}),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require="${path.join(root, 'test/fixtures/sql-native-dns.cjs').replaceAll('\\', '/')}"${browserExecutable ? ` --require="${path.join(__dirname, 'native-browser.cjs').replaceAll('\\', '/')}"` : ''}`,
    } });
    const timer = setTimeout(() => {
      timeout = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }, options.timeout || 180000);
    const ricevi = chunk => { stream.write(chunk); captured = (captured + chunk).slice(-100000); };
    child.stdout.on('data', ricevi); child.stderr.on('data', ricevi);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => {
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  }).finally(async () => {
    await new Promise(resolve => stream.end(resolve));
    for (const entry of generated) {
      if (fs.existsSync(entry.file)) fs.copyFileSync(entry.file, path.join(reportDir, entry.base));
      if (entry.before !== null) fs.writeFileSync(entry.file, entry.before);
      else if (fs.existsSync(entry.file)) fs.unlinkSync(entry.file);
    }
  });
  const classification = require('./runner.cjs').classifica(exitCode, timeout, fs.readFileSync(log, 'utf8'));
  const result = { name, ok: classification.esito === 'superato', exitCode, timeout, ...classification,
    ms: Math.round(performance.now() - t), log, okLines: (captured.match(/^\s*OK\b/gm) || []).length, failLines: classification.errori.length };
  if (!result.ok) result.tail = captured.slice(-6000);
  results.push(result); salva();
  console.log(`${result.ok ? 'OK' : 'FAIL'} ${name} (${result.ms} ms, exit ${exitCode})`);
  return result;
}
async function main() {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1', 'Serve CODEDB_E2E_DESTRUCTIVE=1 per il laboratorio isolato');
  fs.mkdirSync(reportDir, { recursive: true });
  proprieta();
  if (!process.argv.includes('--no-up')) {
    const up = await esegui('stack-up', 'docker', [...compose, 'up', '-d', '--wait'], { timeout: 600000 });
    assert(up.ok, 'Stack di test non pronto; consultare stack-up.log');
  }
  const init = await esegui('replica-init', process.execPath, ['test/fixtures/sql-native-init.cjs']);
  assert(init.ok, 'Replica set non pronto; consultare replica-init.log');
  const files = ['e2e-sql-native.js', 'e2e-sql-native-sessioni.js', 'e2e-query-nativo-completo.js', 'e2e-query-audit.js', 'e2e-mongosh-runtime.js',
    'e2e-query-dialetti-nativi.js', 'e2e-sql-mongo-tipi.js'];
  const uiFiles = ['e2e-sql-native-ui', 'e2e-mongosh-ui'];
  if (only) assert(only.length && only.every(name => [...files.map(f => f.replace('.js', '')), ...uiFiles].includes(name)), 'Selezione --only vuota o suite sconosciuta');
  for (const file of files) {
    if (process.argv.includes('--ui-only') || (process.argv.includes('--mongosh-only') && !file.includes('mongosh')) || (only && !only.includes(file.replace('.js', '')))) {
      omitted.push({ test: file, motivo: 'Filtro esplicito --ui-only/--mongosh-only/--only' }); continue;
    }
    await esegui(file.replace('.js', ''), process.execPath, [`test/${file}`]);
  }
  if (process.argv.includes('--no-ui')) omitted.push(...uiFiles.map(test => ({ test, motivo: '--no-ui esplicito' })));
  else {
    const { chromium } = require('playwright');
    browserExecutable = [process.env.LAB_BROWSER_EXECUTABLE, chromium.executablePath(),
      process.platform === 'win32' && 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      process.platform === 'win32' && 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => p && fs.existsSync(p));
    for (const name of uiFiles) {
      if ((process.argv.includes('--mongosh-only') && !name.includes('mongosh')) || (only && !only.includes(name))) { omitted.push({ test: name, motivo: '--mongosh-only/--only esplicito' }); continue; }
      if (browserExecutable) await esegui(name, process.execPath, [`test/${name}.js`]);
      else results.push({ name, ok: false, prerequisiteFailed: 'Chromium Playwright non installato', executable: chromium.executablePath() });
    }
  }
  const phases = ['barriera', 'prima_riga', 'commit', 'trigger_mql', 'indice', 'indice_commit', 'dipendenza', 'dipendenza_commit', 'savepoint', 'dominio', 'dominio_commit', 'routine_commit', 'native_savepoint', 'trigger_state_commit', 'routine_nested_commit', 'dominio_validate_commit', 'cascade_before', 'cascade_commit'];
  if (process.argv.includes('--no-failover') || process.argv.includes('--ui-only') || process.argv.includes('--mongosh-only') || only) omitted.push({ test: 'e2e-sql-mongo-failover', motivo: 'Esclusione esplicita', phases });
  else for (const phase of phases) {
    const result = await esegui(`failover-${phase}`, process.execPath, ['test/e2e-sql-mongo-failover.js', `--phase=${phase}`], { timeout: 240000 });
    if (!result.ok) {
      proprieta();
      await esegui(`ripristino-${phase}`, 'docker', ['start', ...names.filter(n => n.startsWith('codedb-sql-node-'))]);
      await esegui(`replica-dopo-${phase}`, process.execPath, ['test/fixtures/sql-native-init.cjs']);
    }
  }
  // La mutazione quorum preesistente deve fallire proprio nel controllo sul
  // mancato avanzamento: prima serve la baseline indice riuscita.
  if (process.argv.includes('--sensitivity') && results.find(r => r.name === 'failover-indice')?.ok) {
    const result = await esegui('mutant-quorum', process.execPath, ['test/e2e-sql-mongo-failover.js', '--mutant=quorum'], { timeout: 240000 });
    result.expectedFailure = true;
    result.detected = result.exitCode === 1 && /Migrazione senza progressi/.test(result.tail || '');
    result.ok = result.detected;
  }
  assert(results.some(r => !['stack-up', 'replica-init'].includes(r.name)), 'Nessuna suite eseguita: filtri incompatibili');
  salva();
  if (results.some(r => !r.ok)) process.exitCode = 1;
}
main().catch(error => {
  fs.mkdirSync(reportDir, { recursive: true });
  results.push({ name: 'prerequisiti-runner', ok: false, errore: error.stack }); salva();
  console.error(error); process.exitCode = 1;
});

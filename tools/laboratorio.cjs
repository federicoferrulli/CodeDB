'use strict';

// Ciclo di vita del solo progetto Docker codedb-affidabilita.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { verifica } = require('../test/lab/percorsi.cjs');
const root = path.resolve(__dirname, '..');
const compose = ['compose', '-f', path.join(root, 'test/lab/compose.yml')];
function stage() {
  const dir = path.resolve(root, '.scratch/lab-source');
  const marker = path.join(dir, '.codedb-lab-source');
  verifica(root, dir);
  if (path.basename(dir) !== 'lab-source') throw new Error('Directory di staging non valida');
  if (fs.existsSync(dir)) {
    verifica(dir, marker);
    if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== 'codedb-affidabilita') throw new Error('Staging preesistente non riconosciuto: ' + dir);
    // Mantiene l'inode della directory: Docker può averla già montata.
    for (const name of fs.readdirSync(dir)) {
      if (name === '.codedb-lab-source') continue;
      const item = verifica(dir, path.join(dir, name));
      fs.rmSync(item, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(marker, 'codedb-affidabilita');
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(listed.stderr);
  const files = new Set(listed.stdout.split('\0').filter(Boolean));
  // Anche il codice appena creato appartiene alla revisione in prova. Git
  // applica gli ignore; l'elenco ammesso evita di esportare file locali JSON
  // arbitrari o configurazioni che non siano sorgenti applicativi.
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  if (untracked.status !== 0) throw new Error(untracked.stderr);
  for (const relative of untracked.stdout.split('\0').filter(Boolean)) {
    if (/^(?:db|auth|backup|server|mcp|public|ui|test|tools)\/.+\.(?:[cm]?js|tsx?|jsx|css|html|svg|wasm|png|ico|woff2?)$/.test(relative)
      || /^[^/]+\.[cm]?js$/.test(relative) || /^package(?:-lock)?\.json$/.test(relative)) files.add(relative);
  }
  files.add('tools/laboratorio.cjs'); files.add('.github/workflows/laboratorio.yml');
  const copied = [], hashes = {};
  for (const relative of [...files].sort()) {
    if (/^(?:test-reports|\.agents|\.codex|\.scratch|\.git|conns|data|backups|provenienza)(?:\/|$)/.test(relative)
      || /^(?:connections|vault|\.env)/.test(relative) || /\.(?:p12|pfx|pem|key|p8|jks|keystore)$/.test(relative)) continue;
    if (/(?:^|\/)(?:\.env(?:\.|$)|(?:vault|connections)\.(?:json|ini)$)/.test(relative)) continue;
    const src = path.resolve(root, relative), dst = path.resolve(dir, relative);
    verifica(root, src); verifica(dir, dst);
    if (!fs.existsSync(src)) continue;
    if (!fs.lstatSync(src).isFile()) throw new Error('Sorgente non regolare: ' + relative);
    fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); copied.push(relative);
    hashes[relative] = createHash('sha256').update(fs.readFileSync(dst)).digest('hex');
  }
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, '.lab-files.json'), JSON.stringify({ created: new Date().toISOString(), revision: revision.stdout.trim(),
    sourceDigest: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), files: copied, hashes }, null, 2));
  console.log('Staging filtrato: ' + copied.length + ' file, senza configurazioni locali.');
}
function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker ha terminato con codice ${result.status}`);
  return result;
}
const dc = args => docker([...compose, ...args]);
const exec = args => dc(['exec', '-T', 'prove', ...args]);
function verificaCampagna() {
  const existing = spawnSync('docker', [...compose, 'ps', '-q', 'prove'], { cwd: root, encoding: 'utf8' });
  if (existing.error || existing.status !== 0) throw existing.error || new Error(existing.stderr);
  if (existing.stdout.trim()) exec(['node', '-e', 'const fs=require("fs");const p="/laboratorio/repo/test/lab/lock.cjs";if(fs.existsSync(p))require(p).assicuratiLibero()']);
}
function up() {
  dc(['up', '-d', '--wait', 'mongo', 'mongo-auth', 'mysql', 'postgres']);
  dc(['exec', '-T', 'mongo', 'mongosh', '--quiet', '--eval', '(async()=>{ try { rs.status(); } catch(e) { if(e.code!==94) throw e; rs.initiate({_id:"lab",members:[{_id:0,host:"127.0.0.1:27017"}]}); } let ready=false; for(let i=0;i<120;i++){if(db.hello().isWritablePrimary){ready=true;break;} await sleep(500);} if(!ready)throw new Error("Primario MongoDB non pronto"); print("Replica lab pronta: PRIMARY"); })();']);
  dc(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'postgres', '-c', 'CREATE EXTENSION IF NOT EXISTS postgis']);
}
function copia() { stage(); exec(['node', '/sorgente/test/lab/prepara.cjs']); }
function rapporti() {
  const selected = process.env.LAB_REPORT_DIR;
  if (selected && !/^\/laboratorio\/rapporti\/[a-zA-Z0-9_-]+$/.test(selected)) throw new Error('Cartella rapporti fuori dal laboratorio o non valida.');
  const dir = path.join(root, '.scratch', 'lab-reports', 'docker', ...(selected ? [path.posix.basename(selected)] : []));
  fs.mkdirSync(dir, { recursive: true });
  dc(['cp', `prove:${selected || '/laboratorio/rapporti'}/.`, dir]);
  const metadata = { data: new Date().toISOString(), container: [] };
  const snapshot = spawnSync('docker', [...compose, 'exec', '-T', 'prove', 'cat', '/laboratorio/file-copiati.json'], { cwd: root, encoding: 'utf8' });
  if (snapshot.status === 0) fs.writeFileSync(path.join(dir, 'sorgenti.json'), snapshot.stdout);
  const ids = spawnSync('docker', [...compose, 'ps', '-q'], { cwd: root, encoding: 'utf8' });
  if (ids.status === 0) for (const id of ids.stdout.trim().split(/\s+/).filter(Boolean)) {
    const info = spawnSync('docker', ['inspect', '--format', '{{json .}}', id], { encoding: 'utf8' });
    if (info.status === 0) {
      const value = JSON.parse(info.stdout);
      metadata.container.push({ nome: value.Name, immagine: value.Config.Image, digestLocale: value.Image });
    }
  }
  fs.writeFileSync(path.join(dir, 'ambiente.json'), JSON.stringify(metadata, null, 2));
  console.log('Rapporti copiati in ' + dir);
}
const action = process.argv[2] || 'help';
let releaseLock = () => {};
try {
  if (['prepara', 'test', 'nuovi'].includes(action)) {
    const lock = verifica(root, path.join(root, '.scratch/lab-command.json')); fs.mkdirSync(path.dirname(lock), { recursive: true });
    if (fs.existsSync(lock)) {
      const old = JSON.parse(fs.readFileSync(lock, 'utf8'));
      let active = true;
      try { process.kill(old.pid, 0); } catch (err) { if (err.code === 'ESRCH') active = false; else throw err; }
      if (active) throw new Error(`Comando laboratorio ${old.action} già attivo (PID ${old.pid}).`);
      fs.unlinkSync(lock);
    }
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, action }), { flag: 'wx' });
    releaseLock = () => { if (fs.existsSync(lock) && JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid) fs.unlinkSync(lock); };
    process.once('exit', releaseLock);
  }
  if (action === 'up') up();
  else if (action === 'prepara') {
    verificaCampagna(); stage(); up(); dc(['--profile', 'prove', 'up', '-d', '--build', 'prove']); exec(['node', '/sorgente/test/lab/prepara.cjs']);
    exec(['npm', 'ci']);
    // Electron recente scarica il binario al primo require. La rete appartiene
    // alla preparazione, non al timeout delle prove di avvio dell'applicazione.
    exec(['node', 'node_modules/electron/install.js']);
    exec(['node', '-e', 'const r=require("child_process").spawnSync(require("electron"),["--no-sandbox","--version"],{stdio:"inherit"});if(r.error)throw r.error;process.exit(r.status??1)']);
    exec(['npx', '--no-install', 'playwright', 'install', 'chromium']);
    exec(['npm', 'run', 'build:ui']);
    exec(['node', '-e', 'require("playwright").chromium.launch().then(async b=>{console.log("Chromium pronto");await b.close()})']);
  } else if (action === 'test' || action === 'nuovi') {
    verificaCampagna(); copia(); exec(['npm', 'run', 'build:ui']);
    let failure;
    const overrides = ['LAB_FILTER', 'LAB_REPORT_DIR', 'LAB_SUITE_TIMEOUT_MS', 'INSERT_MONGO_PORT']
      .flatMap(name => process.env[name] ? ['-e', name + '=' + process.env[name]] : []);
    try { dc(['exec', '-T', ...overrides, 'prove', 'node', action === 'test' ? 'test/lab/esegui.cjs' : 'test/lab/nuovi.cjs']); }
    catch (err) { failure = err; }
    rapporti(); if (failure) throw failure;
  } else if (action === 'rapporti') rapporti();
  else if (action === 'stato') dc(['ps']);
  else if (action === 'stop') dc(['stop']);
  else if (action === 'down') dc(['down']);
  else console.log('Uso: node tools/laboratorio.cjs up|prepara|test|nuovi|rapporti|stato|stop|down\nDown rimuove solo i container del laboratorio; i volumi vengono conservati.');
} catch (err) { console.error(err.message); process.exitCode = 1; }
finally { releaseLock(); }

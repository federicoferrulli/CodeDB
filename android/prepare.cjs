'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(__dirname, 'build/node-project');
const NODE_SHA = 'bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af';

function fileApplicazione(name) {
  return /^(auth|backup|db|mcp|public|server)\//.test(name)
    || /^(package(-lock)?\.json|electron-server-auth\.js|LICENSE(\.md)?|MANLEVA\.md|EULA\.md)$/.test(name);
}

function estraiZip(archive, directory) {
  // Il JDK è già richiesto dalla build Android; jar legge ZIP anche su Linux.
  const jar = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar') : 'jar';
  fs.mkdirSync(directory, { recursive: true });
  execFileSync(jar, ['xf', path.resolve(archive)], { cwd: directory, stdio: 'inherit' });
}

async function prepara() {
  fs.mkdirSync(path.join(__dirname, '.cache'), { recursive: true });
  const archive = path.join(__dirname, '.cache/node.zip');
  if (!fs.existsSync(archive)) {
    const response = await fetch('https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip');
    if (!response.ok) throw new Error(`Download Node.js Mobile: HTTP ${response.status}`);
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  if (crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== NODE_SHA) {
    throw new Error('Checksum Node.js Mobile diverso da quello atteso.');
  }
  estraiZip(archive, path.join(__dirname, '.cache/node'));

  // Solo sorgenti tracciati, letti dal working tree: mai vault, .env o connessioni personali.
  // La destinazione è fissa e interna ad android/build, non è un percorso ricevuto dall'utente.
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(DEST, { recursive: true });
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0');
  for (const name of files.filter(fileApplicazione)) {
    const target = path.join(DEST, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, name), target);
  }
  fs.copyFileSync(path.join(__dirname, 'mobile.cjs'), path.join(DEST, 'mobile.cjs'));
  // Node 18 non deduce ESM dalla sintassi dei .js: estensione esplicita nella
  // sola copia Android del modulo foglia importato dal gateway MCP.
  fs.copyFileSync(path.join(DEST, 'public/js/schema-analisi.js'), path.join(DEST, 'public/js/schema-analisi.mjs'));
  const gateway = path.join(DEST, 'mcp/McpGateway.js');
  const gatewaySource = fs.readFileSync(gateway, 'utf8');
  if (!gatewaySource.includes("'schema-analisi.js'")) throw new Error('Aggiornare il percorso Android del modulo di analisi MCP.');
  fs.writeFileSync(gateway, gatewaySource.replace("'schema-analisi.js'", "'schema-analisi.mjs'"));
  // Nessun addon compilato per il runner dentro l'APK: ssh2 ha già il fallback JavaScript.
  const npm = process.env.npm_execpath || (process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    : '/usr/local/lib/node_modules/npm/bin/npm-cli.js');
  if (fs.existsSync(npm)) {
    execFileSync(process.execPath, [npm, 'ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: DEST, stdio: 'inherit' });
  } else {
    execFileSync('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: DEST, stdio: 'inherit' });
  }
  console.log('Runtime Android preparato in ' + DEST);
}

if (require.main === module) prepara().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { fileApplicazione, estraiZip };

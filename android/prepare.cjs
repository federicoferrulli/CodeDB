'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(__dirname, 'build/node-project');
const NODE_SHA = 'bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af';

function fileApplicazione(name) {
  if (name === 'public/logo.png') return false;
  return /^(auth|backup|db|mcp|public|server)\//.test(name)
    || /^(package(-lock)?\.json|electron-server-auth\.js|LICENSE(\.md)?|MANLEVA\.md|EULA\.md)$/.test(name);
}

function copiaApplicazione(root, dest) {
  const gitFiles = (...args) => execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8' }).split('\0');
  const files = gitFiles().filter(fileApplicazione);
  const nuovi = gitFiles('--others', '--exclude-standard', '--', 'auth', 'backup', 'db', 'mcp', 'public', 'server');
  for (const name of nuovi) {
    if (/(?:^|\/)(?:\.[^/]*|data|backups|conns|node_modules)(?:\/|$)/.test(name)) continue;
    if (/\.[cm]?js$/.test(name) || /^public\/.+\.(?:css|html|svg|png|ico|webp|woff2?)$/.test(name)) files.push(name);
  }
  const rootReale = fs.realpathSync(root);
  for (const name of files) {
    const source = path.join(rootReale, name);
    const stat = fs.lstatSync(source, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || path.relative(source, fs.realpathSync(source))) {
      throw new Error('Sorgente Android non regolare: ' + name);
    }
    const target = path.join(dest, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function aggiornaRiferimento(dest, fileRel, from, to) {
  const full = path.join(dest, fileRel);
  const source = fs.readFileSync(full, 'utf8');
  if (!source.includes(from)) throw new Error(`Aggiornare il percorso Android in ${fileRel}: manca ${from}`);
  fs.writeFileSync(full, source.split(from).join(to));
}

function esponiModuloEsm(dest, fromRel, toRel, rimpiazzi = []) {
  fs.copyFileSync(path.join(dest, fromRel), path.join(dest, toRel));
  for (const [from, to] of rimpiazzi) aggiornaRiferimento(dest, toRel, from, to);
}

function estraiZip(archive, directory) {
  // Il JDK è già richiesto dalla build Android; jar legge ZIP anche su Linux.
  const jar = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar') : 'jar';
  fs.mkdirSync(directory, { recursive: true });
  execFileSync(jar, ['xf', path.resolve(archive)], { cwd: directory, stdio: 'inherit' });
}

function potaNodeModules(dir) {
  const cartelleSuperflue = new Set(['@types', 'test', 'tests', '__tests__', 'docs', 'example', 'examples']);
  const fileSuperfluo = /(?:\.map|\.d\.[cm]?ts|(?:^|[\\/])(?:readme|changelog|history)[^\\/]*\.md)$/i;
  let rimossi = 0;
  // electron-updater serve solo al desktop Electron, mai al runtime Android.
  fs.rmSync(path.join(dir, 'electron-updater'), { recursive: true, force: true });
  const visita = (corrente) => {
    let voci;
    try { voci = fs.readdirSync(corrente, { withFileTypes: true }); } catch { return; }
    for (const voce of voci) {
      const full = path.join(corrente, voce.name);
      if (voce.isDirectory()) {
        if (cartelleSuperflue.has(voce.name.toLowerCase())) {
          fs.rmSync(full, { recursive: true, force: true });
          rimossi++;
        } else {
          visita(full);
        }
      } else if (voce.isFile() && fileSuperfluo.test(full)) {
        fs.rmSync(full, { force: true });
        rimossi++;
      }
    }
  };
  visita(dir);
  return rimossi;
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

  // La destinazione è fissa e interna ad android/build, non è un percorso ricevuto dall'utente.
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(DEST, { recursive: true });
  copiaApplicazione(ROOT, DEST);
  fs.copyFileSync(path.join(__dirname, 'mobile.cjs'), path.join(DEST, 'mobile.cjs'));
  // Node 18 non deduce ESM dalla sintassi dei .js: estensione esplicita nella
  // sola copia Android dei moduli ESM foglia usati dal backend (senza toccare i .js serviti al browser).
  esponiModuloEsm(DEST, 'public/js/schema-analisi.js', 'public/js/schema-analisi.mjs');
  aggiornaRiferimento(DEST, 'mcp/risorse-e-prompt.js', "'schema-analisi.js'", "'schema-analisi.mjs'");
  esponiModuloEsm(DEST, 'public/js/query-lexer.js', 'public/js/query-lexer.mjs');
  esponiModuloEsm(DEST, 'public/js/query-error.js', 'public/js/query-error.mjs', [["'./query-lexer.js'", "'./query-lexer.mjs'"]]);
  aggiornaRiferimento(DEST, 'db/queryError.js', "'../public/js/query-error'", "'../public/js/query-error.mjs'");
  // Nessun addon compilato per il runner dentro l'APK: ssh2 ha già il fallback JavaScript.
  const npm = process.env.npm_execpath || (process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    : '/usr/local/lib/node_modules/npm/bin/npm-cli.js');
  if (fs.existsSync(npm)) {
    execFileSync(process.execPath, [npm, 'ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: DEST, stdio: 'inherit' });
  } else {
    execFileSync('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: DEST, stdio: 'inherit' });
  }
  fs.rmSync(path.join(DEST, 'package-lock.json'), { force: true });
  const potati = potaNodeModules(path.join(DEST, 'node_modules'));
  console.log(`Pulizia dipendenze Android: ${potati} voci non-runtime rimosse.`);
  const unicode = require('./unicode.cjs').preparaUnicode(DEST);
  console.log(`Compatibilità Unicode Android: ${unicode} file trasformati senza dipendenza da ICU.`);
  console.log('Runtime Android preparato in ' + DEST);
}

if (require.main === module) prepara().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { copiaApplicazione, fileApplicazione, estraiZip };

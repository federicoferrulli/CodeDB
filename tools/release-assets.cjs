'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { valida, versione } = require('./firma.cjs');

const nomeSicuro = name => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) && !name.includes('..');
const hash = (file, tipo = 'sha256', formato = 'hex') => crypto.createHash(tipo).update(fs.readFileSync(file)).digest(formato);
function percorsoGpg(p, binary = process.env.GPG_BINARY || '') {
  const normalized = p.replace(/\\/g, '/');
  return process.platform === 'win32' && /\/usr\/bin\//i.test(binary.replace(/\\/g, '/'))
    ? normalized.replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`) : normalized;
}
function elenco(dir) {
  return fs.readdirSync(dir).sort().map(name => {
    if (!nomeSicuro(name) || !fs.lstatSync(path.join(dir, name)).isFile()) throw new Error(`Asset non regolare o nome non sicuro: ${name}`);
    return name;
  });
}
function metadati(dir, name, version) {
  const info = yaml.load(fs.readFileSync(path.join(dir, name), 'utf8'));
  if (info?.version !== version || !Array.isArray(info.files) || !info.files.length) throw new Error(`Metadati aggiornamento non validi: ${name}`);
  for (const f of info.files) {
    if (typeof f.url !== 'string' || !nomeSicuro(f.url)) throw new Error(`URL asset non relativo: ${name}`);
    const file = path.join(dir, f.url);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`Asset mancante: ${f.url}`);
    if (f.sha512 !== hash(file, 'sha512', 'base64')) throw new Error(`SHA512 errato: ${f.url}`);
    if (f.size !== undefined && f.size !== fs.statSync(file).size) throw new Error(`Dimensione errata: ${f.url}`);
    if (f.blockMapSize !== undefined && (!Number.isInteger(f.blockMapSize) || f.blockMapSize <= 0 || f.blockMapSize >= fs.statSync(file).size)) throw new Error(`Blockmap incorporata non valida: ${f.url}`);
  }
  if (!info.files.some(f => f.url === info.path && f.sha512 === info.sha512)) throw new Error(`Riferimento legacy incoerente: ${name}`);
  return info;
}
function richiesti(target, version, release) {
  const base = `CodeDB-${version}`;
  if (target === 'win') return [`${base}-setup.exe`, `${base}-setup.exe.blockmap`];
  if (target.startsWith('mac-')) return [`${base}-${target.slice(4)}.dmg`, `${base}-${target.slice(4)}.zip`, `${base}-${target.slice(4)}.zip.blockmap`];
  if (target === 'linux') return ['AppImage', 'deb', 'rpm'].map(ext => `${base}-${require('builder-util').getArtifactArchName(require('builder-util').Arch.x64, ext)}.${ext}`);
  if (target === 'android') return release ? [`${base}-android.apk`, `${base}-android.aab`] : [`${base}-android-debug.apk`];
  throw new Error('Target degli asset sconosciuto.');
}
function verifica(dir, version, targets, release) {
  const names = elenco(dir);
  const channel = require('semver').prerelease(version)?.[0];
  for (const target of targets.filter(t => t !== 'android')) {
    const suffix = target.startsWith('mac-') ? '-mac' : target === 'linux' ? '-linux' : '';
    if (!['latest', ...(channel ? [String(channel)] : [])].some(c => names.includes(`${c}${suffix}.yml`))) {
      throw new Error(`Metadati del canale mancanti per ${target}.`);
    }
  }
  for (const target of targets) for (const name of richiesti(target, version, release)) {
    if (!names.includes(name) || !fs.statSync(path.join(dir, name)).size) throw new Error(`Asset obbligatorio mancante: ${name}`);
  }
  const referenziati = new Set();
  for (const name of names.filter(n => n.endsWith('.yml'))) for (const file of metadati(dir, name, version).files) referenziati.add(file.url);
  for (const name of names.filter(n => /\.(exe|zip|AppImage)$/.test(n))) {
    if (!referenziati.has(name)) throw new Error(`Asset senza metadati di aggiornamento: ${name}`);
  }
  for (const name of names.filter(n => n.endsWith('.blockmap'))) {
    if (!names.includes(name.slice(0, -9))) throw new Error(`Blockmap senza artefatto: ${name}`);
  }
  return names;
}
function stage(source, dest, target, version, release) {
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error('La destinazione degli asset deve essere vuota.');
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(source).sort()) {
    if (!nomeSicuro(name) || name.startsWith('builder-') || !/\.(exe|dmg|zip|AppImage|deb|rpm|apk|aab|blockmap|yml)$/.test(name)) continue;
    const file = path.join(source, name);
    if (!fs.lstatSync(file).isFile()) throw new Error(`Asset non regolare: ${name}`);
    if (name.endsWith('.yml')) metadati(source, name, version);
    fs.copyFileSync(file, path.join(dest, name), fs.constants.COPYFILE_EXCL);
  }
  verifica(dest, version, [target], release);
}
function raccogli(source, dest, version, release) {
  const targets = ['win', 'mac-x64', 'mac-arm64', 'linux', 'android'];
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error('La cartella finale deve essere vuota.');
  fs.mkdirSync(dest, { recursive: true });
  const merged = new Map();
  for (const target of targets) {
    const dir = path.join(source, target);
    const names = verifica(dir, version, [target], release);
    for (const name of names) {
      if (!name.endsWith('.yml')) {
        fs.copyFileSync(path.join(dir, name), path.join(dest, name), fs.constants.COPYFILE_EXCL);
        continue;
      }
      const info = metadati(dir, name, version);
      const old = merged.get(name);
      if (!old) merged.set(name, info);
      else {
        if (!target.startsWith('mac-') || !name.endsWith('-mac.yml')) throw new Error(`Metadati duplicati fra piattaforme: ${name}`);
        for (const key of new Set([...Object.keys(old), ...Object.keys(info)])) {
          if (!['files', 'path', 'sha512', 'releaseDate'].includes(key) && JSON.stringify(old[key]) !== JSON.stringify(info[key])) throw new Error(`Metadati incompatibili fra architetture: ${name}`);
        }
        if (info.files.some(f => old.files.some(o => o.url === f.url))) throw new Error(`Asset duplicato nei metadati: ${name}`);
        old.files.push(...info.files);
      }
    }
  }
  for (const [name, info] of merged) fs.writeFileSync(path.join(dest, name), yaml.dump(info, { lineWidth: -1 }));
  return verifica(dest, version, targets, release);
}
function manifest(dir) {
  const names = elenco(dir).filter(n => !['SHA256SUMS', 'SHA256SUMS.asc'].includes(n));
  if (!names.length) throw new Error('Nessun asset da includere nel manifest.');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), names.map(n => `${hash(path.join(dir, n))}  ${n}\n`).join(''));
}
function verificaManifest(dir) {
  const text = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8');
  const names = [];
  for (const line of text.trimEnd().split('\n')) {
    const m = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!m || !nomeSicuro(m[2]) || ['SHA256SUMS', 'SHA256SUMS.asc'].includes(m[2]) || hash(path.join(dir, m[2])) !== m[1]) throw new Error('Manifest SHA256SUMS non valido o asset alterato.');
    names.push(m[2]);
  }
  if (JSON.stringify(names) !== JSON.stringify(elenco(dir).filter(n => !['SHA256SUMS', 'SHA256SUMS.asc'].includes(n)))) throw new Error('Manifest incompleto, duplicato o non ordinato.');
}
function firmaManifest(dir, env = process.env) {
  const attiva = valida('gpg', env, env.CODEDB_RELEASE === 'true');
  if (!attiva) { manifest(dir); verificaManifest(dir); return; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-gpg-'));
  fs.chmodSync(temp, 0o700);
  const gpgPath = p => percorsoGpg(p, env.GPG_BINARY);
  const childEnv = { ...env, GNUPGHOME: gpgPath(temp) };
  delete childEnv.GPG_PRIVATE_KEY; delete childEnv.GPG_PASSPHRASE;
  const gpg = (args, input) => {
    const r = spawnSync(env.GPG_BINARY || 'gpg', ['--homedir', gpgPath(temp), '--batch', '--no-tty', ...args.map(gpgPath)], { env: childEnv, input, encoding: 'utf8', windowsHide: true });
    if (r.error || r.status !== 0) throw new Error('Operazione GPG fallita: verifica chiave, fingerprint e passphrase.');
    return r.stdout;
  };
  try {
    gpg(['--import'], env.GPG_PRIVATE_KEY);
    const fingerprint = env.GPG_KEY_FINGERPRINT.toUpperCase();
    const keys = gpg(['--with-colons', '--list-secret-keys', fingerprint]);
    if (!keys.split('\n').some(l => l.startsWith('fpr:') && l.split(':')[9] === fingerprint)) throw new Error('Fingerprint GPG diverso dalla chiave importata.');
    fs.writeFileSync(path.join(dir, 'CODEDB-RELEASE-KEY.asc'), gpg(['--armor', '--export', fingerprint]));
    manifest(dir);
    gpg(['--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--local-user', fingerprint,
      '--armor', '--detach-sign', '--output', path.join(dir, 'SHA256SUMS.asc'), path.join(dir, 'SHA256SUMS')], `${env.GPG_PASSPHRASE || ''}\n`);
    const status = gpg(['--status-fd', '1', '--verify', path.join(dir, 'SHA256SUMS.asc'), path.join(dir, 'SHA256SUMS')]);
    if (!status.split('\n').some(l => l.startsWith('[GNUPG:] VALIDSIG ') && (l.split(' ')[2] === fingerprint || l.trimEnd().endsWith(` ${fingerprint}`)))) throw new Error('Firma GPG non valida per il fingerprint configurato.');
    verificaManifest(dir);
  } finally {
    spawnSync(env.GPGCONF_BINARY || 'gpgconf', ['--homedir', gpgPath(temp), '--kill', 'all'], { env: childEnv, windowsHide: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
function verificaFirmaPubblica(dir, env = process.env) {
  const signature = path.join(dir, 'SHA256SUMS.asc');
  if (!fs.existsSync(signature)) {
    if (env.CODEDB_REQUIRE_GPG === 'true') throw new Error('Firma GPG obbligatoria assente.');
    return;
  }
  const fingerprint = String(env.GPG_KEY_FINGERPRINT || '').toUpperCase();
  if (!/^[A-F0-9]{40,64}$/.test(fingerprint)) throw new Error('Configura il fingerprint fidato per verificare la firma pubblica.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-gpg-verifica-'));
  fs.chmodSync(temp, 0o700);
  const run = args => {
    const r = spawnSync(env.GPG_BINARY || 'gpg', ['--homedir', percorsoGpg(temp, env.GPG_BINARY), '--batch', '--no-tty', ...args.map(p => percorsoGpg(p, env.GPG_BINARY))], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error('Verifica pubblica GPG fallita.');
    return r.stdout;
  };
  try {
    run(['--import', path.join(dir, 'CODEDB-RELEASE-KEY.asc')]);
    const status = run(['--status-fd', '1', '--verify', signature, path.join(dir, 'SHA256SUMS')]);
    if (!status.split('\n').some(l => l.startsWith('[GNUPG:] VALIDSIG ') && (l.split(' ')[2] === fingerprint || l.trimEnd().endsWith(` ${fingerprint}`)))) throw new Error('Firmatario GPG diverso dal fingerprint fidato.');
  } finally {
    spawnSync(env.GPGCONF_BINARY || 'gpgconf', ['--homedir', percorsoGpg(temp, env.GPG_BINARY), '--kill', 'all'], { windowsHide: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { nomeSicuro, hash, percorsoGpg, elenco, richiesti, metadati, verifica, stage, raccogli, manifest, verificaManifest, firmaManifest, verificaFirmaPubblica };
if (require.main === module) {
  try {
    const [cmd, source, dest, target] = process.argv.slice(2);
    const version = versione(require('../package.json').version).version;
    if (cmd === 'stage') stage(source, dest, target, version, process.env.CODEDB_RELEASE === 'true');
    else if (cmd === 'raccogli') { raccogli(source, dest, version, process.env.CODEDB_RELEASE === 'true'); firmaManifest(dest); }
    else if (cmd === 'manifest') firmaManifest(source);
    else if (cmd === 'verifica') { verificaManifest(source); verificaFirmaPubblica(source); }
    else throw new Error('Uso: release-assets.cjs stage|raccogli|manifest|verifica sorgente [destinazione] [target]');
    console.log('Asset e integrità verificati.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

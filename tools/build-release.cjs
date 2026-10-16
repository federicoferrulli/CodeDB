'use strict';
const { spawnSync } = require('node:child_process');
const { valida } = require('./firma.cjs');

function main(args = process.argv.slice(2), env = process.env) {
  const piattaforma = args[0] === 'dir' ? { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform] : args[0];
  if (!['win', 'mac', 'linux', 'store'].includes(piattaforma) || args.slice(1).some(a => a !== '--release' && !(piattaforma === 'store' && a === '--prova'))) {
    throw new Error('Uso: node tools/build-release.cjs win|mac|linux|dir [--release] oppure store [--prova]');
  }
  if (args.includes('--prova')) env = { ...env, CODEDB_STORE_TEST: 'true' };
  if (env.CODEDB_RELEASE && !['true', 'false'].includes(env.CODEDB_RELEASE)) throw new Error('CODEDB_RELEASE accetta true o false.');
  const release = args.includes('--release') || env.CODEDB_RELEASE === 'true';
  if (piattaforma === 'store') require('./store.cjs').identita(env);
  else valida(piattaforma, env, release);
  const arch = env.CODEDB_BUILD_ARCH || process.arch;
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Architettura desktop non supportata.');
  const r = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), `--${piattaforma === 'store' ? 'win' : piattaforma}`, `--${arch}`,
    ...(args[0] === 'dir' ? ['--dir'] : []), '--config', 'tools/electron-builder.cjs', '--publish', 'never'], {
    cwd: require('node:path').resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true,
    env: { ...env, CODEDB_BUILD_PLATFORM: piattaforma, CODEDB_RELEASE: String(release), CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
  if (r.error || r.status !== 0) throw new Error('Packaging interrotto: controlla il diagnostico del builder.');
}
module.exports = { main };
if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}

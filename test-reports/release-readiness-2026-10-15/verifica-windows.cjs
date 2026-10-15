'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'dist/release-0.2.1-beta.1');
const executablePath = path.join(output, 'win-unpacked/CodeDB.exe');
const archive = path.join(output, 'win-unpacked/resources/app.asar');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const runtime = file => /^(auth|backup|db|mcp|server|public|bin)\//.test(file)
  || /^(server\.js|electron-(main|aggiornamenti|server-auth)\.js|package(-lock)?\.json|LICENSE\.md|EULA\.md|MANLEVA\.md)$/.test(file);
(async () => {
  const asar = await import('@electron/asar');
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const entries = files.filter(runtime).map(file => ({ file, sha256: sha(fs.readFileSync(path.join(root, file))) }));
  for (const item of entries) {
    // electron-builder esclude il lockfile dal runtime; resta nell'impronta dei sorgenti.
    if (item.file === 'package-lock.json' || item.file.endsWith('.d.ts')) continue;
    const bytes = asar.extractFile(archive, path.normalize(item.file));
    if (item.file === 'package.json') assert.equal(JSON.parse(bytes).version, '0.2.1-beta.1');
    else assert.equal(sha(bytes), item.sha256, 'Contenuto ASAR diverso: ' + item.file);
  }
  const paths = asar.listPackage(archive).map(p => p.replaceAll('\\', '/').replace(/^\//, ''));
  const top = new Set(entries.map(e => e.file.split('/')[0])); top.add('node_modules');
  assert(paths.every(file => top.has(file.split('/')[0])), 'ASAR contiene un percorso estraneo al runtime');
  const installer = path.join(output, 'CodeDB-0.2.1-beta.1-setup.exe');
  assert(fs.statSync(installer).size > 100000000, 'Installer incompleto');
  fs.writeFileSync(path.join(__dirname, 'candidato-runtime.json'), JSON.stringify({
    versione: '0.2.1-beta.1', gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    nota: 'Snapshot del checkout locale, comprende modifiche non committate e nuovi moduli.',
    installer, installerSha256: sha(fs.readFileSync(installer)), asarSha256: sha(fs.readFileSync(archive)),
    fileRuntimeVerificati: entries.filter(e => e.file !== 'package-lock.json' && !e.file.endsWith('.d.ts')).length,
    soloBuild: ['package-lock.json', 'public/js/viewport.d.ts'], percorsiAsar: paths.length, files: entries,
  }, null, 2));
  console.log(`OK ASAR: ${entries.length - 2} file runtime confrontati con i sorgenti, nessun percorso estraneo`);
  const smoke = spawnSync(executablePath, [path.join(root, 'test/smoke-distribuzione.cjs'), archive], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 45000,
  });
  assert.equal(smoke.status, 0, smoke.stderr || smoke.error?.message);
  assert.match(smoke.stdout, /"http":"ok"/);
  console.log(smoke.stdout.trim());
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-windows-smoke-'));
  let app;
  try {
    const env = { ...process.env, CODEDB_RBAC: 'off', HOST: '127.0.0.1', CODEDB_PUBLIC_BIND: '127.0.0.1', PORT: '0',
      CODEDB_CONNECTIONS_FILE: path.join(profile, 'connections.ini'), CODEDB_CONNECTIONS_DIR: path.join(profile, 'conns'),
      CODEDB_BACKUPS_DIR: path.join(profile, 'backups'), CODEDB_SCRIPT_RESULTS_DIR: path.join(profile, 'scripts'),
      CODEDB_UI_AUDIT_FILE: path.join(profile, 'ui.log'), CODEDB_MCP_AUDIT_FILE: path.join(profile, 'mcp.log'),
      GUI_MONGO_PASSPHRASE: '' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath, args: ['--user-data-dir=' + profile], env, timeout: 30000 });
    const info = await app.evaluate(({ app }) => ({ versione: app.getVersion(), packaged: app.isPackaged, userData: app.getPath('userData') }));
    assert.equal(path.resolve(info.userData), profile, 'Profilo Electron non isolato');
    assert.equal(info.versione, '0.2.1-beta.1'); assert(info.packaged);
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
    assert.match(page.url(), /^http:\/\/127\.0\.0\.1:\d+/);
    assert.deepEqual(errors, []);
    const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true);
    await page.screenshot({ path: path.join(__dirname, 'windows-avvio.png') });
    console.log('OK app Windows pacchettizzata: finestra, UI senza errori, profilo isolato e sandbox renderer attiva');
  } finally {
    await app?.close();
    assert(profile.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

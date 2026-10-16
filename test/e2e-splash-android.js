'use strict';

// Registra l'avvio reale: nessuna pausa o schermata di anteprima aggiunta all'app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { _android } = require('playwright');
const adb = path.resolve('android/.cache/sdk/platform-tools/adb.exe');
const serial = 'emulator-5580', pkg = 'com.codedb.android.debug';
const dir = 'test-reports/splash-mobile';
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8' }).trim();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const capture = name => fs.writeFileSync(`${dir}/${name}.png`, execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p']));

(async () => {
  assert.equal(run('shell', 'getprop', 'ro.kernel.qemu'), '1', 'Usare soltanto l’emulatore dedicato');
  fs.mkdirSync(dir, { recursive: true });
  const device = (await _android.devices({ omitDriverInstall: true })).find(d => d.serial() === serial);
  assert(device);
  const rotation = run('shell', 'settings', 'get', 'system', 'user_rotation');
  const autoRotation = run('shell', 'settings', 'get', 'system', 'accelerometer_rotation');
  const motion = run('shell', 'settings', 'get', 'global', 'animator_duration_scale');
  const font = run('shell', 'settings', 'get', 'system', 'font_scale');
  let recording;
  async function ready() {
    const page = await (await device.webView({ pkg }, { timeout: 120000 })).page();
    await page.waitForFunction(() => typeof window.__codedbBack === 'function', null, { timeout: 120000 });
    await wait(800);
    return page;
  }
  async function start() {
    run('shell', 'am', 'force-stop', pkg);
    await wait(300);
    run('shell', 'am', 'start', '-W', '-n', `${pkg}/com.codedb.android.MainActivity`);
    await wait(2200);
  }
  try {
    run('shell', 'settings', 'put', 'global', 'animator_duration_scale', '1');
    run('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
    run('shell', 'settings', 'put', 'system', 'user_rotation', '0');
    let page = await ready();
    for (const theme of ['light', 'custom', 'dark']) {
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      // Lascia completare anche la scrittura differita di localStorage prima del force-stop.
      await wait(6000);
      if (theme === 'dark') {
        recording = spawn(adb, ['-s', serial, 'shell', 'screenrecord', '--time-limit', '25', '--bit-rate', '4000000', '--size', '720x1600', '/sdcard/codedb-avvio.mp4'], { windowsHide: true, stdio: 'ignore' });
        await wait(400);
      }
      await start();
      capture(`splash-${theme}`);
      page = await ready();
      assert.equal(await page.evaluate(async () => (await import('/js/theme.js')).temaCorrente()), theme, 'Il tema scelto sopravvive al riavvio');
      if (recording) {
        if (recording.exitCode === null) await new Promise(resolve => recording.once('exit', resolve));
        assert.equal(recording.exitCode, 0, 'Registrazione dello splash completata');
        run('pull', '/sdcard/codedb-avvio.mp4', `${dir}/avvio-reale.mp4`);
        recording = undefined;
      }
    }
    run('shell', 'settings', 'put', 'system', 'user_rotation', '1');
    await wait(500);
    await start();
    capture('splash-orizzontale');
    await ready();
    run('shell', 'settings', 'put', 'system', 'user_rotation', '0');
    run('shell', 'settings', 'put', 'global', 'animator_duration_scale', '0');
    await wait(500);
    await start();
    capture('splash-movimento-ridotto');
    await ready();
    run('shell', 'settings', 'put', 'system', 'font_scale', '1.6');
    await wait(500);
    await start();
    capture('splash-caratteri-grandi');
    await ready();
    console.log('OK splash Android: avvii reali chiaro/scuro/personalizzato, orizzontale, movimento ridotto e video.');
  } finally {
    if (recording?.exitCode === null) await new Promise(resolve => recording.once('exit', resolve));
    for (const [scope, key, value] of [['system', 'user_rotation', rotation], ['system', 'accelerometer_rotation', autoRotation], ['system', 'font_scale', font], ['global', 'animator_duration_scale', motion]]) {
      run('shell', 'settings', value === 'null' ? 'delete' : 'put', scope, key, ...(value === 'null' ? [] : [value]));
    }
    await device.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

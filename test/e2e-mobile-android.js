'use strict';

// Solo emulatore dedicato: controlla il gesto di sistema e fotografa anche le barre native.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _android } = require('playwright');
const adb = path.resolve('android/.cache/sdk/platform-tools/adb.exe');
const serial = 'emulator-5580', pkg = 'com.codedb.android.debug';
const dir = 'test-reports/mobile-shell/android';
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8' }).trim();
const capture = name => fs.writeFileSync(`${dir}/${name}.png`, execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p']));

(async () => {
  assert.equal(run('shell', 'getprop', 'ro.kernel.qemu'), '1', 'Non usare un telefono personale');
  fs.mkdirSync(dir, { recursive: true });
  const navigation = run('shell', 'cmd', 'overlay', 'list').match(/\[x\] (com\.android\.internal\.systemui\.navbar\.\S+)/)?.[1];
  let device;
  try {
    run('install', '-r', path.resolve('android/app/build/outputs/apk/debug/app-debug.apk'));
    run('shell', 'input', 'keyevent', '4');
    run('shell', 'am', 'force-stop', pkg);
    run('shell', 'am', 'start', '-W', '-n', `${pkg}/com.codedb.android.MainActivity`);
    // Attende anche la transizione del colore delle icone gestita da System UI.
    await new Promise(resolve => setTimeout(resolve, 1200));
    capture('avvio');
    device = (await _android.devices({ omitDriverInstall: true })).find(d => d.serial() === serial);
    assert(device);
    const web = await device.webView({ pkg }, { timeout: 120000 });
    const page = await web.page();
    page.setDefaultTimeout(30000);
    await page.waitForFunction(() => typeof window.__codedbBack === 'function');
    await page.evaluate(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true })), require('../package.json').version);
    await page.reload();
    await page.waitForFunction(() => typeof window.__codedbBack === 'function');
    await page.waitForFunction(() => !document.getElementById('onboarding-overlay').dataset.arcDialog);
    for (const theme of ['light', 'dark', 'custom']) {
      await page.evaluate(async theme => {
        if (theme === 'custom') {
          const c = await import('/js/theme-colori.js');
          localStorage.setItem('codedb:temi', JSON.stringify({ custom: { id: 'custom', nome: 'Bosco', base: 'dark', scelte: { ...c.scelteIniziali('dark'), bg: '#123b2c' } } }));
        }
        (await import('/js/theme.js')).scegliTema(theme);
      }, theme);
      await page.waitForTimeout(350);
      capture(theme);
    }
    run('shell', 'cmd', 'overlay', 'enable-exclusive', '--category', 'com.android.internal.systemui.navbar.gestural');
    await page.waitForTimeout(500);
    for (const [start, end] of [[2, 500], [1077, 580]]) {
      await page.locator('#mobile-nav-conns').click();
      await page.locator('.arc-navigation-sheet').waitFor();
      await page.waitForTimeout(400);
      run('shell', 'input', 'swipe', String(start), '900', String(end), '900', '700');
      await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'Indietro chiude prima il pannello');
    }
    capture('gesto-indietro');
    // Il tema personalizzato deve essere già presente mentre il server riparte.
    run('shell', 'am', 'force-stop', pkg);
    run('shell', 'am', 'start', '-W', '-n', `${pkg}/com.codedb.android.MainActivity`);
    await new Promise(resolve => setTimeout(resolve, 1200));
    capture('splash-tema-salvato');
    console.log('OK Android: temi e barre native, gesto Indietro reale, riavvio con tema salvato.');
  } finally {
    if (navigation) run('shell', 'cmd', 'overlay', 'enable-exclusive', '--category', navigation);
    await device?.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { configurazione } = require('../tools/electron-builder.cjs');
const { identita } = require('../tools/store.cjs');

module.exports = (async () => {
  const env = { MICROSOFT_STORE_IDENTITY_NAME: '12345.CodeDB', MICROSOFT_STORE_PUBLISHER: 'CN=00000000-0000-0000-0000-000000000001',
    MICROSOFT_STORE_PUBLISHER_DISPLAY_NAME: 'Editore di prova & soci', MICROSOFT_STORE_VERSION: '1.2.37.0' };
  for (const key of Object.keys(env)) {
    const copia = { ...env }; delete copia[key];
    assert.throws(() => identita(copia), /Configura/);
  }
  for (const version of ['0.2.1.0', '1.2.3.1', '1.2.3-beta.1', '1.2.65536.0', '1.02.3.0', '1.2.3']) {
    assert.throws(() => identita({ ...env, MICROSOFT_STORE_VERSION: version }), /quattro interi/);
  }
  assert.throws(() => identita({ ...env, MICROSOFT_STORE_IDENTITY_NAME: 'CodeDB.ProvaStore' }), /collaudi/);
  assert.throws(() => identita({ ...env, CSC_LINK: 'non-usare.pfx' }), /non usa/);
  assert.throws(() => identita({ CODEDB_STORE_TEST: 'tru' }), /true o false/);
  const cfg = configurazione('store', env);
  await require('app-builder-lib/out/util/config/config').validateConfiguration(cfg, { isEnabled: false });
  assert.deepEqual(cfg.win.target, ['appx']);
  assert.equal(cfg.publish, null);
  assert.equal(cfg.forceCodeSigning, false);
  assert.equal(cfg.extraMetadata.codedbStoreTest, false);
  assert.equal(configurazione('store', { CODEDB_STORE_TEST: 'true' }).extraMetadata.codedbStoreTest, true);
  assert.equal(cfg.appx.electronUpdaterAware, false);
  assert.deepEqual(cfg.appx.capabilities, ['runFullTrust']);
  assert.equal(cfg.directories.output, 'dist/store');
  assert.match(configurazione('store', { CODEDB_STORE_TEST: 'true' }).win.artifactName, /prova/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-store-'));
  try {
    // Esercita il template e il generatore reali del builder installato.
    const Appx = require('app-builder-lib/out/targets/AppxTarget').default;
    const builder = Object.create(Appx.prototype);
    builder.options = cfg.appx;
    builder.packager = { info: { metadata: require('../package.json') }, config: cfg, platformSpecificBuildOptions: cfg.win, appInfo: { name: 'codedb', productFilename: 'CodeDB', productName: 'CodeDB', description: 'Database',
      getVersionInWeirdWindowsForm: () => '0.2.1.0' }, getResource: async () => null };
    const file = path.join(temp, 'AppxManifest.xml');
    await builder.writeManifest(file, require('builder-util').Arch.x64, cfg.appx.publisher, []);
    await cfg.appxManifestCreated(file);
    const xml = fs.readFileSync(file, 'utf8');
    assert.match(xml, /<Identity[\s\S]*?Version="1\.2\.37\.0"/);
    assert.match(xml, /Editore di prova &amp; soci/);
    assert.match(xml, /<DisplayName>CodeDB Manager<\/DisplayName>/);
    assert.match(xml, /DisplayName="CodeDB Manager"/);
    assert.match(xml, /EntryPoint="Windows.FullTrustApplication"/);
    assert.match(xml, /runFullTrust/);
    assert.match(xml, /Language="it-IT"/);
    fs.writeFileSync(file, '<Package Version="1.2.37.0"/>');
    await assert.rejects(() => cfg.appxManifestCreated(file), /Identity assente/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }

  // Il gestore vero deve evitare sia richieste di rete sia timer nel canale Store.
  const source = fs.readFileSync(path.join(__dirname, '../electron-aggiornamenti.js'), 'utf8');
  function carica(store, erroreApertura = false) {
    const eventi = [], module = { exports: {} };
    const context = { module, console, URL, setTimeout: () => { eventi.push('timer'); return {}; }, setImmediate,
      process: { windowsStore: store, env: { CODEDB_UPDATE_URL: 'https://example.test/updates' } },
      require: name => {
        if (name === 'electron') return { app: { isPackaged: true, getVersion: () => '1.0.0' },
          shell: { openExternal: async url => { eventi.push(url); if (erroreApertura) throw Error('Store assente'); } },
          dialog: { showMessageBox: async opts => { eventi.push(opts.message); return { response: 0 }; } } };
        assert.equal(name, 'electron-updater'); eventi.push('updater');
        return { autoUpdater: { setFeedURL: () => eventi.push('feed'), checkForUpdates: async () => { eventi.push('controllo'); return null; } } };
      } };
    vm.runInNewContext(source, context);
    return { gestore: module.exports.creaGestoreAggiornamenti({}), eventi };
  }
  const store = carica(true);
  store.gestore.avviaControlloDifferito();
  await store.gestore.controlla(false);
  assert.deepEqual(store.eventi, []);
  await store.gestore.controlla(true);
  assert.deepEqual(store.eventi, ['ms-windows-store://downloadsandupdates']);
  const errore = carica(true, true); await errore.gestore.controlla(true);
  assert.match(errore.eventi[1], /Apri Microsoft Store/);
  assert(!errore.eventi.includes('updater'));
  const indipendente = carica(false);
  indipendente.gestore.avviaControlloDifferito(); await indipendente.gestore.controlla(true);
  assert(indipendente.eventi.includes('timer') && indipendente.eventi.includes('controllo') && indipendente.eventi.includes('feed'));
  assert(!indipendente.eventi.some(e => e.startsWith('ms-windows-store:')));
  console.log('OK canali Windows: identità/versioni Store, manifest reale, aggiornamenti Store e indipendenti.');
})();

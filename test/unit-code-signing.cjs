'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { valida, versione } = require('../tools/firma.cjs');
const { configurazione } = require('../tools/electron-builder.cjs');
const assets = require('../tools/release-assets.cjs');
function fixture(root, version = '1.2.3-beta.1') {
  const incoming = path.join(root, 'incoming');
  for (const target of ['win', 'mac-x64', 'mac-arm64', 'linux', 'android']) {
    const dir = path.join(incoming, target); fs.mkdirSync(dir, { recursive: true });
    for (const name of assets.richiesti(target, version, true)) fs.writeFileSync(path.join(dir, name), `fixture ${name}`);
    const files = assets.richiesti(target, version, true).filter(n => /\.(exe|zip|AppImage)$/.test(n)).map(url => ({ url,
      sha512: assets.hash(path.join(dir, url), 'sha512', 'base64'), size: fs.statSync(path.join(dir, url)).size }));
    if (files.length) fs.writeFileSync(path.join(dir, target.startsWith('mac') ? 'latest-mac.yml' : target === 'win' ? 'latest.yml' : 'latest-linux.yml'),
      yaml.dump({ version, files, path: files[0].url, sha512: files[0].sha512 }));
  }
  return incoming;
}
module.exports = (async () => {
  require('./unit-android-unicode.cjs');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-firma-test-'));
  try {
    const win = { AZURE_CODE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net/', AZURE_CODE_SIGNING_ACCOUNT: 'account',
      AZURE_CERT_PROFILE: 'profilo', AZURE_PUBLISHER_NAME: 'CodeDB', AZURE_CLIENT_ID: 'id', AZURE_TENANT_ID: 'tenant', AZURE_SUBSCRIPTION_ID: 'sub' };
    const mac = { CSC_LINK: 'fixture', CSC_KEY_PASSWORD: 'fixture', APPLE_ID: 'test@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'fixture', APPLE_TEAM_ID: 'ABCDEFGHIJ' };
    const android = { ANDROID_KEYSTORE_PATH: path.join(temp, 'fixture.jks'), ANDROID_KEYSTORE_PASSWORD: 'fixture', ANDROID_KEY_ALIAS: 'fixture', ANDROID_KEY_PASSWORD: 'fixture', ANDROID_VERSION_CODE: '1' };
    fs.writeFileSync(android.ANDROID_KEYSTORE_PATH, 'fixture senza chiave privata');
    for (const [platform, env] of [['win', win], ['mac', mac], ['android', android]]) {
      assert.equal(valida(platform, {}), false);
      assert.throws(() => valida(platform, {}, true), /incompleta/i);
      assert.equal(valida(platform, env, true), true);
      for (const key of Object.keys(env).filter(k => k !== 'ANDROID_VERSION_CODE')) {
        const incomplete = { ...env }; delete incomplete[key];
        assert.throws(() => valida(platform, incomplete), /incompleta/i, `sensibilità: manca ${key}`);
      }
    }
    assert.throws(() => valida('android', { ...android, ANDROID_KEYSTORE_PATH: path.join(temp, 'assente') }, true), /esistente/);
    for (const code of ['0', '-1', '2100000001', 'abc']) assert.throws(() => valida('android', { ...android, ANDROID_VERSION_CODE: code }, true), /VERSION_CODE/);
    assert.throws(() => valida('win', { ...win, AZURE_CODE_SIGNING_ENDPOINT: 'http://example.test' }, true), /HTTPS/);
    assert.throws(() => valida('mac', { ...mac, APPLE_TEAM_ID: 'errato' }, true), /10 caratteri/);
    assert.throws(() => valida('gpg', { CODEDB_REQUIRE_GPG: 'true' }, true), /incompleta/);
    assert.throws(() => valida('gpg', { GPG_PRIVATE_KEY: 'fixture' }), /incompleta/);
    for (const v of ['1.2.3', '1.2.3-beta.1', '1.2.3-rc.1']) for (const tag of [v, `v${v}`]) assert.equal(versione(v, tag).version, v);
    for (const v of ['01.2.3', '1.2.3-01', '1.2']) assert.throws(() => versione(v), /SemVer/);
    assert.throws(() => versione('1.2.3', 'v1.2.4'), /coincidere/);
    const schema = config => require('app-builder-lib/out/util/config/config').validateConfiguration(config, { isEnabled: false });
    for (const [platform, env] of [['win', win], ['mac', mac], ['linux', {}]]) for (const release of [false, true]) {
      const cfg = configurazione(platform, release ? { ...env, CODEDB_RELEASE: 'true' } : {}); await schema(cfg);
      if (platform !== 'linux') assert.equal(cfg.forceCodeSigning, release);
      if (platform === 'mac') { assert.equal(cfg.mac.notarize, release); if (!release) assert.equal(cfg.mac.identity, '-'); }
      if (platform === 'win') { assert.equal(cfg.win.signExecutable, release); if (release) assert.equal(cfg.win.azureSignOptions.publisherName, 'CodeDB'); }
    }
    await assert.rejects(() => schema({ ...configurazione('win', {}), opzioneInesistente: true }), /unknown property/);
    assert.throws(() => require('../tools/build-release.cjs').main(['win'], { CODEDB_RELEASE: 'tru' }), /true o false/);
    assert.throws(() => require('../tools/verifica-mongosh-nativi.cjs')({ electronPlatformName: 'piattaforma-errata', arch: 1 }), /runner/);
    const source = fixture(temp), dest = path.join(temp, 'finale');
    assets.raccogli(source, dest, '1.2.3-beta.1', true);
    assert.equal(assets.metadati(dest, 'latest-mac.yml', '1.2.3-beta.1').files.length, 2);
    assets.manifest(dest); assets.verificaManifest(dest);
    const apk = path.join(dest, 'CodeDB-1.2.3-beta.1-android.apk'), original = fs.readFileSync(apk);
    fs.appendFileSync(apk, 'alterazione controllata'); assert.throws(() => assets.verificaManifest(dest), /alterato/); fs.writeFileSync(apk, original);
    fs.writeFileSync(path.join(dest, 'asset-aggiunto.exe'), 'fixture'); assert.throws(() => assets.verificaManifest(dest), /incompleto/); fs.unlinkSync(path.join(dest, 'asset-aggiunto.exe'));
    const meta = path.join(dest, 'latest-mac.yml'), originalMeta = fs.readFileSync(meta);
    for (const mutation of [f => f.size++, f => { f.sha512 = 'errato'; }, f => { f.url = '../esterno.zip'; }, f => { f.url = 'https://example.test/a.zip'; }]) {
      const info = yaml.load(originalMeta.toString()); mutation(info.files[0]); fs.writeFileSync(meta, yaml.dump(info));
      assert.throws(() => assets.metadati(dest, 'latest-mac.yml', '1.2.3-beta.1'));
    }
    fs.writeFileSync(meta, originalMeta);
    fs.renameSync(meta, path.join(dest, 'canale-errato.yml'));
    assert.throws(() => assets.verifica(dest, '1.2.3-beta.1', ['mac-x64', 'mac-arm64'], true), /canale mancanti/);
    fs.renameSync(path.join(dest, 'canale-errato.yml'), meta);
    const missing = path.join(source, 'linux', assets.richiesti('linux', '1.2.3-beta.1', true).find(n => n.endsWith('.rpm'))); fs.unlinkSync(missing);
    assert.throws(() => assets.verifica(path.dirname(missing), '1.2.3-beta.1', ['linux'], true), /obbligatorio mancante/);
    assets.verificaManifest(dest);
    console.log('OK firma: schema installato, credenziali assenti/incomplete, modalità obbligatoria, metadati e checksum; fixture negative rilevate e ripristinate.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})();
module.exports.fixture = fixture;

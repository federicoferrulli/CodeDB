'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createClient } = require('electron-updater/out/providerFactory');
const { HttpError } = require('builder-util-runtime');
const semver = require('semver');

const sorgente = path.join(__dirname, '../electron-aggiornamenti.js');
const carica = createRequire(sorgente);
const checksum = Buffer.alloc(64, 1).toString('base64');
const metadata = (version, file = `CodeDB-${version}-setup.exe`) => JSON.stringify({
  version, files: [{ url: file, sha512: checksum, size: 42 }], path: file, sha512: checksum,
});
const release = (tag, files = ['latest.yml'], extra = {}) => ({
  tag_name: tag, name: tag, body: 'Note della versione', draft: false,
  prerelease: !!semver.prerelease(tag), assets: files.map(name => ({ name })), ...extra,
});
const feed = '<feed>' + ['v0.2.1-beta.1', 'v0.2.0-beta.1'].map(tag =>
  `<entry><title>${tag}</title><link href="https://github.com/federicoferrulli/CodeDB/releases/tag/${tag}"/><content>Beta</content></entry>`).join('') + '</feed>';

// Attraversa il gestore usato dal pulsante e la factory reale di electron-updater.
async function controllo({ releases = [release('v0.2.0-beta.1')], version = '0.1.5-beta.1',
  platform = 'win32', env = {}, risposte = {}, erroreApi } = {}) {
  const richieste = [], messaggi = [];
  let provider, risultato, errore;
  const updater = { currentVersion: semver.parse(version), allowPrerelease: true,
    setFeedURL: config => { provider = createClient(config, updater, runtime); },
    checkForUpdates: async () => {
      try { risultato = await provider.getLatestVersion(); return { updateInfo: risultato,
        isUpdateAvailable: semver.gt(risultato.version, version) }; }
      catch (err) { errore = err; throw err; }
    },
  };
  const runtime = { platform, executor: { request: async opts => {
    const url = new URL(opts.path, `${opts.protocol}//${opts.hostname}`);
    richieste.push(url.href);
    if (url.hostname === 'api.github.com') {
      if (erroreApi) throw erroreApi;
      return JSON.stringify(typeof releases === 'function' ? releases(Number(url.searchParams.get('page'))) : releases);
    }
    if (url.pathname.endsWith('.atom')) return feed;
    if (Object.hasOwn(risposte, url.pathname)) {
      const risposta = risposte[url.pathname];
      if (risposta instanceof Error) throw risposta;
      return risposta;
    }
    if (url.pathname === '/federicoferrulli/CodeDB/releases/download/v0.2.0-beta.1/latest.yml') return metadata('0.2.0-beta.1');
    throw new HttpError(404);
  } } };
  provider = createClient({ provider: 'github', owner: 'federicoferrulli', repo: 'CodeDB' }, updater, runtime);
  const modulo = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sorgente, 'utf8'), { module: modulo, URL, setTimeout, setImmediate,
    process: { env }, console: { warn() {} }, require: name => {
      if (name === 'electron') return { app: { isPackaged: true, getVersion: () => version },
        dialog: { showMessageBox: async opts => { messaggi.push(opts); return { response: 2 }; } },
        shell: { openExternal: async () => assert.fail('Non deve aprire pagine automaticamente') } };
      if (name === 'electron-updater') return { autoUpdater: updater };
      return carica(name);
    } });
  await modulo.exports.creaGestoreAggiornamenti({}).controlla(true);
  return { risultato, errore, richieste, messaggi, provider };
}

module.exports = (async () => {
  const normale = await controllo();
  assert.ifError(normale.errore);
  assert.equal(normale.risultato.version, '0.2.0-beta.1', 'un tag senza release non deve bloccare una release installabile');
  assert.match(normale.messaggi[0].message, /È disponibile CodeDB 0.2.0-beta.1/);
  assert(!normale.richieste.some(url => url.includes('download/v0.2.1-beta.1')), 'non deve cercare file sotto il tag incompleto');
  const files = normale.provider.resolveFiles(normale.risultato);
  assert.equal(files[0].url.href, 'https://github.com/federicoferrulli/CodeDB/releases/download/v0.2.0-beta.1/CodeDB-0.2.0-beta.1-setup.exe');
  assert.equal(files[0].info.sha512, checksum);

  const incompleta = await controllo({ releases: [release('v0.3.0-beta.1', ['latest.yml'], { draft: true }),
    release('v0.2.1-beta.1', ['latest-mac.yml']), release('v0.2.0-beta.1')] });
  assert.ifError(incompleta.errore);
  assert.equal(incompleta.risultato.version, '0.2.0-beta.1');

  for (const [platform, filename, asset] of [['darwin', 'latest-mac.yml', 'CodeDB-0.2.0-beta.1-arm64.zip'],
    ['linux', 'latest-linux.yml', 'CodeDB-0.2.0-beta.1-x86_64.AppImage']]) {
    const prova = await controllo({ platform, releases: [release('v0.2.0-beta.1', [filename])],
      risposte: { [`/federicoferrulli/CodeDB/releases/download/v0.2.0-beta.1/${filename}`]: metadata('0.2.0-beta.1', asset) } });
    assert.ifError(prova.errore);
    assert.equal(prova.provider.resolveFiles(prova.risultato)[0].info.url, asset);
  }

  const stabile = await controllo({ version: '0.1.0', releases: [release('v0.3.0-beta.1'), release('v0.2.0')],
    risposte: { '/federicoferrulli/CodeDB/releases/download/v0.2.0/latest.yml': metadata('0.2.0') } });
  assert.ifError(stabile.errore);
  assert.equal(stabile.risultato.version, '0.2.0');
  const beta = await controllo({ releases: [release('v0.3.0-alpha.1'), release('v0.2.0-beta.1')] });
  assert.ifError(beta.errore);
  assert.equal(beta.risultato.version, '0.2.0-beta.1');

  const pagine = await controllo({ releases: pagina => pagina === 1
    ? Array.from({ length: 100 }, (_, i) => release(`v1.0.${i}`, [])) : [release('v0.2.0-beta.1')] });
  assert.ifError(pagine.errore);
  assert.equal(pagine.risultato.version, '0.2.0-beta.1');
  assert(pagine.richieste.some(url => url.endsWith('page=2')));
  const canale = await controllo({ env: { CODEDB_UPDATE_CHANNEL: 'preview' }, releases: [release('v0.3.0-beta.1'),
    release('v0.2.0-preview.1', ['preview.yml'])], risposte: {
    '/federicoferrulli/CodeDB/releases/download/v0.2.0-preview.1/preview.yml': metadata('0.2.0-preview.1'),
  } });
  assert.ifError(canale.errore);
  assert.equal(canale.risultato.version, '0.2.0-preview.1');
  assert((await controllo({ releases: [] })).errore, 'assenza di pacchetti non significa app aggiornata');

  const rete = new HttpError(403);
  assert.equal((await controllo({ erroreApi: rete })).errore, rete, 'un errore di rete non equivale ad app aggiornata');
  const corrotto = await controllo({ risposte: { '/federicoferrulli/CodeDB/releases/download/v0.2.0-beta.1/latest.yml': 'files: [}' } });
  assert(corrotto.errore, 'metadati malformati devono essere segnalati');
  const sparito = await controllo({ risposte: { '/federicoferrulli/CodeDB/releases/download/v0.2.0-beta.1/latest.yml': new HttpError(404) } });
  assert(sparito.errore, 'un file dichiarato nella release ma non scaricabile deve produrre un errore');
  const incoerente = await controllo({ risposte: { '/federicoferrulli/CodeDB/releases/download/v0.2.0-beta.1/latest.yml': metadata('9.0.0') } });
  assert.match(incoerente.errore.message, /non corrisponde al tag/);

  const generico = await controllo({ env: { CODEDB_UPDATE_URL: 'https://updates.example.test/' },
    risposte: { '/latest.yml': metadata('0.2.0-beta.1') } });
  assert.ifError(generico.errore);
  assert(!generico.richieste.some(url => url.includes('github.com')), 'il server HTTPS personalizzato resta indipendente');
  console.log('OK aggiornamenti: tag incompleti, canali, Windows/macOS/Linux, checksum, errori e feed personalizzato.');
})();

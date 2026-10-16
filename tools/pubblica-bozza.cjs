'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { versione } = require('./firma.cjs');
const { verifica, verificaManifest, verificaFirmaPubblica, elenco, hash } = require('./release-assets.cjs');

// La richiesta HTTP è iniettabile: i test esercitano anche retry e fallimenti parziali.
async function verificaTag(tag, commit, request) {
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Serve il commit completo della build da pubblicare.');
  let ref = await request('GET', `/git/ref/tags/${encodeURIComponent(tag)}`);
  if (!ref) return; // GitHub creerà il tag sul commit indicato alla pubblicazione.
  for (let i = 0; ref.object?.type === 'tag' && i < 10; i++) ref = await request('GET', `/git/tags/${ref.object.sha}`);
  if (ref.object?.type !== 'commit' || ref.object.sha !== commit) throw new Error('Il tag punta a un commit diverso dalla build.');
}

async function pubblica(dir, version, tag, request, opzioni = {}) {
  const { prerelease } = versione(version, tag);
  const { firmata = true, pubblica: rendiPubblica = false, commit = process.env.GITHUB_SHA } = opzioni;
  if (!firmata && !prerelease) throw new Error('I pacchetti di prova possono essere pubblicati solo come pre-release.');
  verifica(dir, version, ['win', 'mac-x64', 'mac-arm64', 'linux', 'android'], firmata);
  verificaManifest(dir);
  verificaFirmaPubblica(dir);
  if (rendiPubblica) await verificaTag(tag, commit, request);
  let release = await request('GET', `/releases/tags/${encodeURIComponent(tag)}`);
  if (release && !release.draft) throw new Error('La release è già pubblicata: nessun asset modificato.');
  const incompleta = { draft: true, prerelease, name: `CodeDB ${version} — INCOMPLETA`,
    body: 'Caricamento in corso. Non pubblicare questa bozza finché il workflow non è concluso.' };
  release = release ? await request('PATCH', `/releases/${release.id}`, incompleta)
    : await request('POST', '/releases', { ...incompleta, tag_name: tag, target_commitish: commit });
  const id = release.id;
  // Il manifest precedente viene tolto prima di toccare gli altri asset.
  const old = await request('GET', `/releases/${id}/assets?per_page=100`);
  if (old.length === 100) throw new Error('Troppi asset nella bozza: riconciliazione manuale necessaria.');
  old.sort((a, b) => Number(b.name.startsWith('SHA256SUMS')) - Number(a.name.startsWith('SHA256SUMS')));
  for (const asset of old) await request('DELETE', `/releases/assets/${asset.id}`);
  const names = elenco(dir).sort((a, b) => Number(a.startsWith('SHA256SUMS')) - Number(b.startsWith('SHA256SUMS')) || a.localeCompare(b));
  for (const name of names) {
    await request('UPLOAD', `/releases/${id}/assets?name=${encodeURIComponent(name)}`, path.join(dir, name));
  }
  const uploaded = await request('GET', `/releases/${id}/assets?per_page=100`);
  if (uploaded.length !== names.length || new Set(uploaded.map(a => a.name)).size !== names.length) throw new Error('La bozza contiene asset mancanti o duplicati.');
  for (const name of names) {
    const asset = uploaded.find(a => a.name === name);
    if (!asset || asset.state !== 'uploaded' || asset.size !== fs.statSync(path.join(dir, name)).size || asset.digest !== `sha256:${hash(path.join(dir, name))}`) {
      throw new Error(`Verifica remota fallita: ${name}. La bozza rimane INCOMPLETA.`);
    }
  }
  const current = await request('GET', `/releases/${id}`);
  if (!current.draft) throw new Error('La bozza è stata pubblicata durante il caricamento. Intervento manuale necessario.');
  if (rendiPubblica) await verificaTag(tag, commit, request);
  const limiti = firmata
    ? 'Pacchetti di distribuzione: macOS con Developer ID e notarizzazione, Android con chiave persistente. Windows può essere senza firma secondo la configurazione scelta.'
    : 'Beta di prova: Windows senza firma Authenticode; macOS con firma ad hoc, senza notarizzazione; Android debug, solo per prove e non per Google Play. macOS può richiedere un intervento manuale per l’avvio; l’aggiornamento automatico macOS non è garantito.';
  const result = await request('PATCH', `/releases/${id}`, { draft: !rendiPubblica, prerelease, name: `CodeDB ${version}`,
    ...(rendiPubblica && prerelease ? { make_latest: 'false' } : {}),
    body: `Pacchetti Windows, macOS Intel/Apple Silicon, Linux e Android.\n\n${limiti}\n\nAsset, metadati di aggiornamento e SHA256SUMS verificati prima della pubblicazione.\n\nScaricare il pacchetto per la propria piattaforma: gli archivi Source code contengono soltanto i sorgenti.\n\n${rendiPubblica ? 'Release pubblicata da GitHub Actions dopo la verifica di tutti gli allegati.' : 'Bozza completa: pubblicazione manuale.'}` });
  const finale = await request('GET', `/releases/${id}`);
  if (finale.draft !== !rendiPubblica || finale.prerelease !== prerelease) throw new Error('Lo stato finale della release non corrisponde a quello richiesto.');
  return result;
}
function githubRequest(env = process.env) {
  if (!env.GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '')) throw new Error('Configura GH_TOKEN e GITHUB_REPOSITORY.');
  return async (method, route, body) => {
    const upload = method === 'UPLOAD';
    const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (body) headers['Content-Type'] = upload ? 'application/octet-stream' : 'application/json';
    if (upload) headers['Content-Length'] = String(fs.statSync(body).size);
    const response = await fetch(`https://${upload ? 'uploads' : 'api'}.github.com/repos/${env.GITHUB_REPOSITORY}${route}`, {
      method: upload ? 'POST' : method, headers,
      ...(body ? { body: upload ? fs.createReadStream(body) : JSON.stringify(body) } : {}),
      ...(upload ? { duplex: 'half' } : {}), signal: AbortSignal.timeout(600000),
    });
    if (response.status === 404 && method === 'GET' && (route.startsWith('/releases/tags/') || route.startsWith('/git/ref/tags/'))) return null;
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: operazione ${method} non completata.`);
    return response.status === 204 ? null : response.json();
  };
}
module.exports = { pubblica, githubRequest };
if (require.main === module) {
  const version = require('../package.json').version;
  const tag = process.env.GITHUB_REF?.startsWith('refs/tags/') ? process.env.GITHUB_REF.slice(10) : `v${version}`;
  const rendiPubblica = process.env.CODEDB_PUBLISH === 'true';
  pubblica(process.argv[2] || 'release-assets', version, tag, githubRequest(), {
    firmata: process.env.CODEDB_RELEASE !== 'false', pubblica: rendiPubblica,
  }).then(() => console.log(rendiPubblica ? 'Release pubblicata con tutti gli asset verificati.' : 'Bozza completa; pubblicazione manuale.'))
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}

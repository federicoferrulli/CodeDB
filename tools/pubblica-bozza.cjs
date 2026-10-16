'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { versione } = require('./firma.cjs');
const { verifica, verificaManifest, verificaFirmaPubblica, elenco, hash } = require('./release-assets.cjs');

// La richiesta HTTP è iniettabile: i test esercitano anche retry e fallimenti parziali.
async function pubblica(dir, version, tag, request) {
  const { prerelease } = versione(version, tag);
  verifica(dir, version, ['win', 'mac-x64', 'mac-arm64', 'linux', 'android'], true);
  verificaManifest(dir);
  verificaFirmaPubblica(dir);
  let release = await request('GET', `/releases/tags/${encodeURIComponent(tag)}`);
  if (release && !release.draft) throw new Error('La release è già pubblicata: nessun asset modificato.');
  const incompleta = { draft: true, prerelease, name: `CodeDB ${version} — INCOMPLETA`,
    body: 'Caricamento in corso. Non pubblicare questa bozza finché il workflow non è concluso.' };
  release = release ? await request('PATCH', `/releases/${release.id}`, incompleta)
    : await request('POST', '/releases', { ...incompleta, tag_name: tag, target_commitish: process.env.GITHUB_SHA });
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
  await request('PATCH', `/releases/${id}`, { draft: true, prerelease, name: `CodeDB ${version}`,
    body: 'Tutti i target obbligatori hanno completato build e verifiche native. Asset e SHA256SUMS verificati anche dopo il caricamento.\n\nPubblicazione manuale: consultare docs/CODE_SIGNING.md e i rapporti della run prima di pubblicare.' });
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
    if (response.status === 404 && method === 'GET' && route.startsWith('/releases/tags/')) return null;
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: operazione ${method} non completata.`);
    return response.status === 204 ? null : response.json();
  };
}
module.exports = { pubblica, githubRequest };
if (require.main === module) {
  const version = require('../package.json').version;
  const tag = process.env.GITHUB_REF?.startsWith('refs/tags/') ? process.env.GITHUB_REF.slice(10) : `v${version}`;
  pubblica(process.argv[2] || 'release-assets', version, tag, githubRequest()).then(() => console.log('Bozza completa; pubblicazione manuale.'))
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}

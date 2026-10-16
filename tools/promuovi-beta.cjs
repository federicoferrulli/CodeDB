'use strict';
const fs = require('node:fs');
const { versione } = require('./firma.cjs');
const { pubblica, githubRequest } = require('./pubblica-bozza.cjs');

// Si promuove l'artifact originale: non si ricompila un tag con sorgenti successivi.
async function prepara(runId, request, repo) {
  if (!/^[1-9]\d*$/.test(runId || '')) throw new Error('ID run non valido.');
  const run = await request('GET', `/actions/runs/${runId}`);
  if (run.status !== 'completed' || run.conclusion !== 'success' || run.path !== '.github/workflows/release.yml'
      || !['push', 'workflow_dispatch'].includes(run.event) || run.head_repository?.full_name !== repo
      || !/^[a-f0-9]{40}$/.test(run.head_sha || '')) throw new Error('Serve una build riuscita del workflow ufficiale nello stesso repository.');
  const commit = run.head_sha;
  const comparison = await request('GET', `/compare/${commit}...main`);
  if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('Il commit della build deve essere già integrato in main.');
  const pkg = await request('GET', `/contents/package.json?ref=${commit}`);
  if (pkg.encoding !== 'base64') throw new Error('Formato package.json remoto inatteso.');
  const { version } = JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8'));
  if (!versione(version).prerelease) throw new Error('Questo workflow promuove solo pre-release di prova.');
  const { artifacts } = await request('GET', `/actions/runs/${runId}/artifacts?per_page=100`);
  const matches = artifacts.filter(a => a.name === 'release-completa');
  if (artifacts.length >= 100 || matches.length !== 1 || matches[0].expired || matches[0].workflow_run?.head_sha !== commit) {
    throw new Error('Artifact release-completa mancante, ambiguo, scaduto o relativo a un altro commit.');
  }
  return { commit, version, tag: `v${version}`, artifactId: matches[0].id };
}

module.exports = { prepara };
if (require.main === module) {
  (async () => {
    const request = githubRequest();
    const info = await prepara(process.env.CODEDB_BUILD_RUN, request, process.env.GITHUB_REPOSITORY);
    if (process.argv[2] === 'prepara') {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `artifact-id=${info.artifactId}\n`);
      console.log(`Build verificata: ${info.commit}, tag ${info.tag}, artifact ${info.artifactId}.`);
    } else if (process.argv[2] === 'pubblica') {
      const result = await pubblica(process.argv[3] || 'release-assets', info.version, info.tag, request,
        { firmata: false, pubblica: true, commit: info.commit });
      console.log(`Beta pubblicata: ${result.html_url}`);
    } else throw new Error('Uso: promuovi-beta.cjs prepara|pubblica [directory asset]');
  })().catch(e => { console.error(e.message); process.exitCode = 1; });
}

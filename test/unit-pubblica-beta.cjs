'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pubblica } = require('../tools/pubblica-bozza.cjs');
const { modalitaRelease } = require('../tools/firma.cjs');
const { prepara } = require('../tools/promuovi-beta.cjs');
const assets = require('../tools/release-assets.cjs');

module.exports = (async () => {
  const signing = require('./unit-code-signing.cjs'); await signing;
  assert.deepEqual(modalitaRelease('1.2.3-beta.1', false, false), { pubblica: false, firmata: false });
  assert.deepEqual(modalitaRelease('1.2.3-beta.1', true, false), { pubblica: true, firmata: false });
  assert.deepEqual(modalitaRelease('1.2.3-beta.1', true, true), { pubblica: true, firmata: true });
  assert.deepEqual(modalitaRelease('1.2.3', true, false), { pubblica: true, firmata: true });
  assert.deepEqual(modalitaRelease('1.2.3', false, false), { pubblica: false, firmata: false });

  const commit = 'a'.repeat(40), other = 'b'.repeat(40), version = '1.2.3-beta.1', tag = `v${version}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-pubblica-beta-'));
  try {
    const source = signing.fixture(temp, version, false), dir = path.join(temp, 'final');
    assets.raccogli(source, dir, version, false); assets.manifest(dir);
    let release, uploaded, mutations, uploadFailure, digestWrong, tagCommit;
    const reset = () => { release = null; uploaded = []; mutations = []; uploadFailure = false; digestWrong = false; tagCommit = commit; };
    const request = async (method, route, data) => {
      if (method === 'GET' && route.startsWith('/git/ref/')) return { object: { type: 'tag', sha: other } };
      if (method === 'GET' && route.startsWith('/git/tags/')) return { object: { type: 'commit', sha: tagCommit } };
      if (method === 'GET' && route.includes('/assets?')) return digestWrong ? uploaded.map(a => ({ ...a, digest: 'alterato' })) : uploaded;
      if (method === 'GET') return release;
      mutations.push({ method, route, data });
      if (method === 'POST') return (release = { ...data, id: 42 });
      if (method === 'PATCH') return (release = { ...release, ...data });
      if (method === 'DELETE') { uploaded = uploaded.filter(a => a.id !== Number(route.split('/').pop())); return; }
      if (method === 'UPLOAD') {
        if (uploadFailure) throw Error('upload interrotto');
        uploaded.push({ id: uploaded.length + 1, name: path.basename(data), size: fs.statSync(data).size,
          digest: `sha256:${assets.hash(data)}`, state: 'uploaded' });
      }
    };
    const opts = { firmata: false, pubblica: true, commit };
    reset();
    await pubblica(dir, version, tag, request, opts);
    assert.equal(release.draft, false); assert.equal(release.prerelease, true);
    assert.equal(release.target_commitish, commit);
    assert.equal(uploaded.length, assets.elenco(dir).length);
    assert.match(release.body, /senza notarizzazione/); assert.match(release.body, /Android debug/);
    const publication = mutations.findIndex(m => m.method === 'PATCH' && m.data.draft === false);
    assert(publication > mutations.findLastIndex(m => m.method === 'UPLOAD'), 'Pubblicare solo dopo tutti gli upload');
    const count = mutations.length;
    await assert.rejects(() => pubblica(dir, version, tag, request, opts), /già pubblicata/);
    assert.equal(mutations.length, count);

    reset(); uploadFailure = true;
    await assert.rejects(() => pubblica(dir, version, tag, request, opts), /upload interrotto/);
    assert.equal(release.draft, true);
    assert(!mutations.some(m => m.data?.draft === false));
    reset(); digestWrong = true;
    await assert.rejects(() => pubblica(dir, version, tag, request, opts), /remota fallita/);
    assert.equal(release.draft, true);
    reset(); tagCommit = other;
    await assert.rejects(() => pubblica(dir, version, tag, request, opts), /commit/);
    assert.equal(mutations.length, 0);
    reset();
    await assert.rejects(() => pubblica(dir, '1.2.3', 'v1.2.3', request, opts), /pre-release/);
    assert.equal(mutations.length, 0);
    await assert.rejects(() => pubblica(dir, version, tag, request, { ...opts, commit: '' }), /commit/);
    assert.equal(mutations.length, 0);

    // Se il tag cambia durante il caricamento, la bozza non deve diventare pubblica.
    reset();
    await assert.rejects(() => pubblica(dir, version, tag, async (...args) => {
      const result = await request(...args);
      if (args[0] === 'UPLOAD') tagCommit = other;
      return result;
    }, opts), /commit/);
    assert.equal(release.draft, true);

    const repo = 'owner/CodeDB';
    const run = { id: 123, status: 'completed', conclusion: 'success', path: '.github/workflows/release.yml',
      event: 'workflow_dispatch', head_sha: commit, head_repository: { full_name: repo } };
    const artifact = { id: 456, name: 'release-completa', expired: false, workflow_run: { head_sha: commit } };
    const responses = {
      '/actions/runs/123': run,
      [`/compare/${commit}...main`]: { status: 'ahead' },
      [`/contents/package.json?ref=${commit}`]: { encoding: 'base64', content: Buffer.from(JSON.stringify({ version })).toString('base64') },
      '/actions/runs/123/artifacts?per_page=100': { artifacts: [artifact] },
    };
    const read = async (method, route) => { assert.equal(method, 'GET'); assert(Object.hasOwn(responses, route), route); return responses[route]; };
    assert.deepEqual(await prepara('123', read, repo), { commit, version, tag, artifactId: 456 });
    for (const change of [{ conclusion: 'failure' }, { status: 'in_progress' }, { event: 'pull_request' },
      { path: '.github/workflows/altro.yml' }, { head_repository: { full_name: 'fork/CodeDB' } }]) {
      responses['/actions/runs/123'] = { ...run, ...change };
      await assert.rejects(() => prepara('123', read, repo));
    }
    responses['/actions/runs/123'] = run;
    responses[`/compare/${commit}...main`] = { status: 'diverged' };
    await assert.rejects(() => prepara('123', read, repo), /main/);
    responses[`/compare/${commit}...main`] = { status: 'ahead' };
    artifact.expired = true;
    await assert.rejects(() => prepara('123', read, repo), /artifact/i);
    artifact.expired = false; artifact.workflow_run.head_sha = other;
    await assert.rejects(() => prepara('123', read, repo), /artifact/i);
    artifact.workflow_run.head_sha = commit;
    responses['/actions/runs/123/artifacts?per_page=100'].artifacts.push({ ...artifact });
    await assert.rejects(() => prepara('123', read, repo), /artifact/i);
    await assert.rejects(() => prepara('../123', read, repo), /run/);
    console.log('OK pubblicazione: beta senza certificati, stabile firmata, upload/digest/tag protetti e provenienza della build.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})();

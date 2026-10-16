'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { pubblica } = require('../tools/pubblica-bozza.cjs');
const assets = require('../tools/release-assets.cjs');
module.exports = (async () => {
  const signingTests = require('./unit-code-signing.cjs'); await signingTests;
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8'));
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.jobs.bozza.permissions.contents, 'write');
  assert.deepEqual(workflow.jobs.raccogli.needs, ['verifica', 'windows', 'mac', 'linux', 'android']);
  assert.equal(workflow.on.workflow_dispatch.inputs.pubblica.default, false);
  assert.deepEqual(workflow.on.push.tags, ['v*', '[0-9]*']);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== 'bozza') assert.notEqual(job.permissions?.contents, 'write');
    for (const step of job.steps) assert(!/--publish\s+always/.test(step.run || ''), 'Nessun job deve pubblicare direttamente dal builder');
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-bozza-'));
  try {
    for (const version of ['1.2.3', '1.2.3-beta.1']) {
      const dir = path.join(temp, version); fs.mkdirSync(dir);
      const source = signingTests.fixture(dir, version), final = path.join(dir, 'final');
      assets.raccogli(source, final, version, true); assets.manifest(final);
      for (const tag of [version, `v${version}`]) {
        let state = null, uploaded = [], next = 1, failUpload = false, mutations = 0;
        const request = async (method, route, data) => {
          if (method === 'GET' && route.includes('/assets?')) return uploaded;
          if (method === 'GET') return state;
          mutations++;
          if (method === 'POST') return (state = { ...data, id: 42 });
          if (method === 'PATCH') return (state = { ...state, ...data });
          if (method === 'DELETE') { uploaded = uploaded.filter(a => a.id !== Number(route.split('/').pop())); return; }
          if (method === 'UPLOAD') {
            if (failUpload) { failUpload = false; throw new Error('rete interrotta'); }
            uploaded.push({ id: next++, name: path.basename(data), size: fs.statSync(data).size, digest: `sha256:${assets.hash(data)}`, state: 'uploaded' });
          }
        };
        await pubblica(final, version, tag, request);
        assert.equal(state.draft, true); assert.equal(state.prerelease, version.includes('-')); assert.equal(state.tag_name, tag);
        assert.equal(state.name, `CodeDB ${version}`);
        failUpload = true; await assert.rejects(() => pubblica(final, version, tag, request), /rete interrotta/);
        assert.match(state.name, /INCOMPLETA/); assert(!uploaded.some(a => a.name === 'SHA256SUMS'));
        await pubblica(final, version, tag, request);
        assert.equal(state.name, `CodeDB ${version}`); assert.equal(uploaded.length, assets.elenco(final).length);
        const prior = mutations; state.draft = false;
        await assert.rejects(() => pubblica(final, version, tag, request), /già pubblicata/); assert.equal(mutations, prior);
        state.draft = true;
        await assert.rejects(() => pubblica(final, version, tag, async (...args) => {
          const result = await request(...args);
          return args[0] === 'GET' && args[1].includes('/assets?') && result.length ? result.map(a => ({ ...a, digest: 'alterato' })) : result;
        }), /remota fallita/);
        assert.match(state.name, /INCOMPLETA/);
      }
    }
    console.log('OK release: bozza unica, stabili/beta, tag con/senza v, caricamento parziale, retry e digest remoto alterato.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})();

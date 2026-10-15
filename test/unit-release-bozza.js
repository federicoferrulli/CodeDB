'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { GitHubPublisher } = require('electron-publish/out/gitHubPublisher');
const yaml = require('js-yaml');

module.exports = (async () => {
  const radice = path.join(__dirname, '..');
  const workflow = yaml.load(fs.readFileSync(path.join(radice, '.github/workflows/release.yml'), 'utf8'));
  const passo = workflow.jobs.build.steps.find(s => s.run?.startsWith('npm run release:'));
  const sorgente = path.join(radice, 'tools/pubblica.js');
  const requireReale = createRequire(sorgente);

  for (const versione of ['1.0.0', '1.0.0-beta.1']) {
    for (const { piattaforma } of workflow.jobs.build.strategy.matrix.include) {
      let ambienteBuilder;
      const modulo = { exports: {} };
      const requireFinto = nome => {
        if (nome === 'child_process') return { spawnSync: (comando, argomenti, opzioni) => {
          if (comando === 'git') return { status: 0, stdout: '' };
          assert.deepEqual(Array.from(argomenti).slice(1), [`--${piattaforma}`, '--publish', 'always']);
          ambienteBuilder = opzioni.env;
          return { status: 0 };
        } };
        if (nome === path.join(radice, 'package.json')) return { version: versione };
        return requireReale(nome);
      };
      requireFinto.main = modulo;
      requireFinto.resolve = requireReale.resolve;
      vm.runInNewContext(fs.readFileSync(sorgente, 'utf8'), {
        module: modulo, require: requireFinto, __dirname: path.dirname(sorgente),
        console: { log() {}, warn() {}, error() {} },
        process: {
          argv: [process.execPath, sorgente, piattaforma], execPath: process.execPath,
          env: { ...passo.env }, exit: codice => assert.equal(codice, 0),
        },
      }, { filename: sorgente });
      assert.ok(ambienteBuilder, 'lo script deve avviare electron-builder');

      // Il publisher reale costruisce il payload; soltanto la richiesta HTTP è sostituita.
      const chiavi = ['EP_DRAFT', 'EP_PRE_RELEASE', 'EP_PRELEASE', 'GITHUB_RELEASE_TOKEN'];
      const precedenti = Object.fromEntries(chiavi.map(k => [k, process.env[k]]));
      let publisher;
      try {
        for (const k of chiavi) {
          if (ambienteBuilder[k] === undefined) delete process.env[k];
          else process.env[k] = ambienteBuilder[k];
        }
        publisher = new GitHubPublisher({}, {
          ...require('../package.json').build.publish[0], token: '__test__',
        }, versione, { publish: 'always' });
      } finally {
        for (const k of chiavi) {
          if (precedenti[k] === undefined) delete process.env[k];
          else process.env[k] = precedenti[k];
        }
      }
      publisher.githubRequest = async (_url, _token, dati) => dati;
      const richiesta = await publisher.createRelease();
      assert.equal(richiesta.draft, true, `${piattaforma} ${versione}: GitHub deve ricevere una bozza`);
      assert.equal(richiesta.tag_name, `v${versione}`);
    }
  }
  console.log('  OK   Release in bozza: workflow → script → payload GitHub, stabili e beta su tre piattaforme');
})();

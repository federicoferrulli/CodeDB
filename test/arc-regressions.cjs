'use strict';
// Regressioni UI senza database esterni. Ogni suite usa il proprio server isolato.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const suites = ['unit', 'e2e-avvio-ui', 'e2e-fk-inserimento', 'e2e-fk-viste',
  'e2e-editor-geometrico', 'e2e-geometrie-viste', 'e2e-numeri-esatti-inserimento',
  'e2e-incolla-esatto-atomico', 'e2e-selezione-celle-viste', 'e2e-uml',
  'e2e-uml-progetto', 'e2e-uml-progetto-regressioni', 'e2e-uml-modalita',
  'e2e-query-virtual-scroll', 'e2e-split-bersaglio-riquadro', 'e2e-tocco-griglia',
  'e2e-richieste-intellisense', 'e2e-barra-grafo', 'e2e-palette'];
const dir = 'test-reports/arc/regressioni';
fs.mkdirSync(dir, { recursive: true });
const results = [];
for (const suite of suites) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [`test/${suite}.js`], { encoding: 'utf8', timeout: 180000 });
  fs.writeFileSync(`${dir}/${suite}.log`, (result.stdout || '') + (result.stderr || '') + (result.error?.message || ''));
  results.push({ suite, code: result.status, durationMs: Date.now() - started });
  console.log(`${result.status === 0 ? 'OK' : 'ERRORE'} ${suite}`);
}
fs.writeFileSync(`${dir}/report.json`, JSON.stringify(results, null, 2));
if (results.some(result => result.code !== 0)) process.exitCode = 1;

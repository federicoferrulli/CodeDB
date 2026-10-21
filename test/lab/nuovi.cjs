'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runSuite } = require('./runner.cjs');
if (process.env.CODEDB_LAB_CONTAINER !== '1' || !fs.existsSync('/.dockerenv')) throw new Error('Usare il runner Docker isolato.');
const dir = process.env.LAB_REPORT_DIR || '/laboratorio/rapporti/nuovi';
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync('/laboratorio/file-copiati.json', path.join(dir, 'sorgenti.json'));
const env = { ...process.env, LAB_REPORT_DIR: dir,
  LAB_MONGO_PORT: '27017', LAB_MONGO_URI: 'mongodb://127.0.0.1:27017/?directConnection=true',
  LAB_MYSQL_PORT: '3306', LAB_MYSQL_PASSWORD: 'lab_mysql', LAB_PG_PORT: '5432', LAB_PG_PASSWORD: 'lab_postgres' };
const results = [];
(async () => {
require('./lock.cjs').acquisisci('nuove prove reali');
for (const [suite, args] of [['unit-infrastruttura', ['--sensitivity']], ['unit-runner', []], ['unit-connection', []], ['unit-sensitivity', []], ['query', ['--sensitivity']], ['mcp', []], ['mcp-sql', []], ['mcp-sensitivity', []], ['integrita', []], ['dialog-menu', []], ['browser', []]]) {
  const name = suite + (args.length ? '-sensibilita' : '');
  const result = await runSuite({ file: path.join(__dirname, suite + '.cjs'), args, env,
    cwd: path.resolve(__dirname, '../..'), log: path.join(dir, name + '.log'), timeoutMs: 900000 });
  results.push({ suite: name, ...result });
  console.log(JSON.stringify({ suite: name, esito: result.esito, code: result.code, ms: result.ms,
    errori: result.errori.length, saltati: result.saltati.length, log: result.log }));
  fs.writeFileSync(path.join(dir, 'campagna.json'), JSON.stringify(results, null, 2));
}
if (results.some(r => r.esito !== 'superato')) process.exitCode = 1;
})().catch(err => { console.error(err); process.exitCode = 1; });

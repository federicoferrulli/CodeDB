'use strict';

// Esegue ogni suite in un gruppo di processi separato; conserva anche i fallimenti.
const fs = require('node:fs');
const path = require('node:path');
const { esclusioni, timeout } = require('./manifest.cjs');
if (process.env.CODEDB_LAB_CONTAINER !== '1' || !fs.existsSync('/.dockerenv')) {
  throw new Error('Le suite storiche si eseguono solo nel container isolato del laboratorio.');
}
const root = path.resolve(__dirname, '../..');
const dir = process.env.LAB_REPORT_DIR || '/laboratorio/rapporti';
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync('/laboratorio/file-copiati.json', path.join(dir, 'sorgenti.json'));
const filtro = process.env.LAB_FILTER ? new RegExp(process.env.LAB_FILTER) : null;
const tutti = fs.readdirSync(path.join(root, 'test')).filter(f => /^e2e(?:-|\.)/.test(f) && /\.(?:js|cjs)$/.test(f)).sort();
const selezionati = tutti.filter(f => !esclusioni[f] && (!filtro || filtro.test(f)));
const report = { inizio: new Date().toISOString(), node: process.version, filtro: process.env.LAB_FILTER || null,
  totaleInventario: tutti.length, selezionati, nonSelezionati: tutti.filter(f => !esclusioni[f] && !selezionati.includes(f)),
  suites: [], esclusioni: tutti.filter(f => esclusioni[f]).map(file => ({ file, motivo: esclusioni[file] })) };
const salva = () => fs.writeFileSync(path.join(dir, 'esecuzione.json'), JSON.stringify(report, null, 2));
async function prova(file) {
  const log = path.join(dir, file + '.log');
  const result = await require('./runner.cjs').runSuite({ file: path.join(root, 'test', file), log, cwd: root, timeoutMs: Number(process.env.LAB_SUITE_TIMEOUT_MS || timeout[file] || 180000) });
  result.file = file;
  report.suites.push(result); salva();
  console.log(result.esito.toUpperCase() + ' ' + file + ' (' + result.ms + ' ms)');
  if (result.esito !== 'superato') console.log(fs.readFileSync(log, 'utf8').split('\n').slice(-8).join('\n'));
}
(async () => {
  require('./lock.cjs').acquisisci('E2E esistenti');
  for (const file of selezionati) await prova(file);
  report.fine = new Date().toISOString(); salva();
  const counts = report.suites.reduce((a, r) => (a[r.esito] = (a[r.esito] || 0) + 1, a), {});
  console.log(JSON.stringify(counts));
  if (report.suites.length === 0 || report.suites.some(r => r.esito !== 'superato')) process.exitCode = 1;
})().catch(err => { console.error(err); process.exitCode = 1; });

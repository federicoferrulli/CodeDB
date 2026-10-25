'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
if (process.argv.includes('--worker')) {
  if (process.argv.includes('--references')) {
    require('../../db/pg-routine-selezione').riferimentiRoutineBackup = async () => [];
    require('./backup-promozione-postgres.cjs');
  } else {
  require('../../db/pg-promozione').promuoviTabelleCompatibili = async () => false;
  const Module = require('node:module'), filename = require.resolve('../../db/importArtifactAdapter');
  const source = fs.readFileSync(filename, 'utf8');
  const changed = source.replace('if (external.rows.some(item => item.schema && item.schema !== plan.targetDb))', 'if (false)');
  assert.notEqual(changed, source, 'Riprodurre in memoria lo scambio di schemi precedente');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(changed, filename); require.cache[filename] = mod;
  require('./backup-selettivo-esterno.cjs');
  }
} else {
  const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/promozione-mutanti');
  const { inoltraOutputFiglio } = require('./output-mutanti.cjs');
  async function run(mutant, references = false) {
    const out = path.join(dir, (references ? 'riferimenti-' : '') + (mutant ? 'mutante' : 'controllo')); fs.mkdirSync(out, { recursive: true });
    const suite = references ? 'backup-promozione-postgres' : 'backup-selettivo-esterno';
    const json = path.join(out, suite + '.json'); fs.rmSync(json, { force: true });
    const child = spawn(process.execPath, mutant ? [__filename, '--worker', ...(references ? ['--references'] : [])] : [path.join(__dirname, suite + '.cjs')], {
      cwd: root, windowsHide: true, env: { ...process.env, LAB_REPORT_DIR: out }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = fs.createWriteStream(path.join(out, 'console.log'));
    inoltraOutputFiglio(child, { log, mutante: mutant ? (references ? 'riferimenti-omessi' : 'scambio-schemi') : null });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await new Promise(resolve => log.end(resolve));
    return { code, report: fs.existsSync(json) ? JSON.parse(fs.readFileSync(json)) : null };
  }
  (async () => {
    const base = await run(false), report = { suite: 'backup-promozione-mutanti', base };
    if (base.code === 0 && base.report?.ok) {
      const mutant = await run(true), data = mutant.report;
      const expected = ['selettivo-drop', 'selettivo-merge', 'full-drop'].flatMap(mode =>
        ['vista-esterna-dati', 'riferimenti-catalogo-al-bersaglio', 'fk-accetta-nuovo-padre-rifiuta-orfano', 'cleanup-preserva-vista-e-fk-esterne'].map(id => mode + '-' + id))
        .concat(['incompatibile-rifiutato-per-fk', 'incompatibile-originale-e-dipendenze-intatti', 'incompatibile-cleanup-preserva-vista-e-fk-esterne']);
      const failures = (data?.verifiche || []).filter(x => !x.ok).map(x => x.id).sort();
      report.mutante = { ...mutant, rilevato: mutant.code === 1 && !data?.fatale && !data?.erroreChiusura && data?.hashStabili
        && data?.cleanup?.completato === true && data.verifiche.length === base.report.verifiche.length
        && JSON.stringify(failures) === JSON.stringify(expected.sort())
        && expected.every(id => base.report.verifiche.some(x => x.id === id && x.ok)) };
    }
    const refBase = await run(false, true), refMutant = await run(true, true), refData = refMutant.report;
    report.riferimenti = { base: refBase, mutant: refMutant,
      rilevato: refBase.code === 0 && refBase.report?.ok && refMutant.code === 1
        && !refData?.fatale && !refData?.erroreChiusura && refData?.hashStabili && refData?.cleanup?.completato === true
        && refData.verifiche.length === refBase.report.verifiche.length
        && JSON.stringify(refData.fallimenti) === JSON.stringify(['reg-selettivo/funzioni-e-riferimenti', 'reg-selettivo/dopo-cleanup']) };
    report.ok = base.code === 0 && base.report?.ok && report.mutante?.rilevato === true && report.riferimenti.rilevato === true;
    fs.writeFileSync(path.join(dir, 'backup-promozione-mutanti.json'), JSON.stringify(report, null, 2));
    console.log(`${report.ok ? 'OK' : 'FAIL'} sensibilità identità PostgreSQL e dipendenze esterne`);
    if (!report.ok) process.exitCode = 1;
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

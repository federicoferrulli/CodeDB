'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/selettivo-mutanti');
const flags = process.argv;
if (flags.includes('--worker')) {
  const mutant = process.env.LAB_SELETTIVO_MUTANT;
  const Module = require('node:module');
  const filename = path.join(root, ['dipendenze', 'prerequisiti'].includes(mutant) ? 'db/backupRestoreAdapter.js'
    : mutant === 'colonne' ? 'db/schema-merge.js' : mutant === 'quotatura' ? 'db/pg-schema-compare.js' : 'backup/lib/restore.js');
  let source = fs.readFileSync(filename, 'utf8');
  const before = source;
  if (mutant === 'trigger') {
    const seam = 'triggers: (schemaObjects.triggers || []).filter(item => onlyCollections.includes(item.table))';
    assert.equal(source.split(seam).length - 1, 2); source = source.replaceAll(seam, 'triggers: []');
  } else if (mutant === 'routine') {
    source = source.replace("opts.selectedRoutines = await require('../../db/pg-routine-selezione')",
      "opts.selectedRoutines = opts.schemaSnapshot.objects.routines || await require('../../db/pg-routine-selezione')");
  } else if (mutant === 'precaricamento') {
    source = source.replace('while (types.length || routines.length)', 'while (types.length)');
  } else if (mutant === 'dipendenze') {
    source = source.replace('const ripristinaDipendenze = await sospendiDipendenzeSelettive(plan, staging);', 'const ripristinaDipendenze = null;');
  } else if (mutant === 'quotatura') {
    source = source.replace('module.exports = { canonicaIdentificatori };', 'module.exports = { canonicaIdentificatori: value => value };');
  } else if (mutant === 'prerequisiti') {
    source = source.replace("if (type === 'postgresql' && ['types', 'routines', 'collations', 'extensions'].includes(field))", 'if (false)');
  } else if (mutant === 'colonne') {
    source = source.replace('module.exports = { schemaMergeConColonneLocali };', 'module.exports = { schemaMergeConColonneLocali: incoming => incoming };');
  } else throw new Error('Mutante sconosciuto.');
  assert.notEqual(source, before, 'La mutazione deve colpire il codice in memoria');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(source, filename); require.cache[filename] = mod;
  require('./backup-selettivo-dipendenze.cjs');
} else {
  const { inoltraOutputFiglio } = require('./output-mutanti.cjs');
  const triggerFailures = ['drop', 'merge'].flatMap(mode => ['esito', 'presente-nello-staging', 'dati-catalogo-nativi'].map(id => `trigger-${mode}-${id}`));
  const cases = [['mysql', 'trigger', triggerFailures], ['postgresql', 'trigger', triggerFailures],
    ['mysql', 'dipendenze', ['dipendenze-drop-esito', 'dipendenze-drop-dati-scelti']],
    ['postgresql', 'dipendenze', ['dipendenze-drop-esito', 'dipendenze-drop-dati-scelti']],
    ['postgresql', 'routine', ['routine-locale-esito', 'routine-locale-staging-preservato', 'routine-locale-dati-catalogo-nativi']],
    ['postgresql', 'quotatura', ['tipo-compatibile-esito', 'tipo-compatibile-dati-catalogo-nativi', 'tipo-nuovo-esito', 'tipo-nuovo-catalogo-dati']],
    ['postgresql', 'prerequisiti', ['tipo-nuovo-esito', 'tipo-nuovo-catalogo-dati']],
    ['postgresql', 'precaricamento', ['routine-default-esito', 'routine-default-corpo-e-dati']],
    ...['mysql', 'postgresql'].map(engine => [engine, 'colonne', ['colonne-locali-esito', 'colonne-locali-valori-default']])];
  async function run(engine, mutant) {
    const out = path.join(dir, engine + '-' + (mutant || 'controllo')); fs.mkdirSync(out, { recursive: true });
    const json = path.join(out, 'backup-selettivo-dipendenze.json'); fs.rmSync(json, { force: true });
    const child = spawn(process.execPath, [mutant ? __filename : path.join(__dirname, 'backup-selettivo-dipendenze.cjs'), '--worker', engine], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LAB_REPORT_DIR: out, LAB_SELETTIVO_MUTANT: mutant || '' },
    });
    const log = fs.createWriteStream(path.join(out, 'console.log'));
    inoltraOutputFiglio(child, { log, mutante: mutant || null });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await new Promise(resolve => log.end(resolve));
    return { code, report: fs.existsSync(json) ? JSON.parse(fs.readFileSync(json)) : null };
  }
  (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const report = { suite: 'backup-selettivo-mutanti', controlli: {}, mutanti: [] };
    for (const engine of ['mysql', 'postgresql']) report.controlli[engine] = await run(engine);
    if (Object.values(report.controlli).every(x => x.code === 0 && x.report?.ok)) for (const [engine, mutant, expected] of cases) {
      const result = await run(engine, mutant), data = result.report;
      const failures = (data?.verifiche || []).filter(x => !x.ok).map(x => x.id).sort();
      const detected = result.code === 1 && data?.sorgentiStabili && data?.pulizia === 'completata'
        && !data?.erroreFatale && !data?.errorePulizia && !data?.erroreChiusura
        && data.verifiche.length === report.controlli[engine].report.verifiche.length
        && JSON.stringify(failures) === JSON.stringify([...expected].sort())
        && expected.every(id => report.controlli[engine].report.verifiche.some(x => x.id === id && x.ok));
      report.mutanti.push({ engine, mutant, rilevato: !!detected, ...result });
      console.log(`${detected ? 'OK' : 'FAIL'} sensibilità ${engine}/${mutant}`);
    }
    report.ok = Object.values(report.controlli).every(x => x.code === 0 && x.report?.ok)
      && report.mutanti.length === cases.length && report.mutanti.every(x => x.rilevato);
    fs.writeFileSync(path.join(dir, 'backup-selettivo-mutanti.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

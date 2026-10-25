'use strict';

// I guasti deliberati devono fallire esattamente gli oracoli previsti.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/ripristino-unita');
fs.mkdirSync(dir, { recursive: true });
const payload = ['destinazione', 'drop', 'selezione', 'origine', 'connessione', 'in-corso'].map(x => 'payload-diverso-' + x);
const leases = ['tab', 'socket'].flatMap(x => ['successo/1', 'errore/1', 'successo/2'].map(y => x + '/' + y));
const suites = [
  { file: 'unit-backup-lease.js', count: 7, mutants: { '--mutant': leases, '--mutant-preparazione': ['preparazione-fallita'] } },
  { file: 'unit-backup-registro.js', count: 21, mutants: {
    '--mutant=ripetizione': ['idempotenza-in-corso', 'idempotenza-concluso', 'idempotenza-richiesta-equivalente', ...payload],
    // La connessione viene dalla sessione: alterare il payload non la cambia.
    '--mutant=payload-ignorato': payload.filter(id => id !== 'payload-diverso-connessione'),
    '--mutant=identita-ignorata': ['isolamento-owner', 'isolamento-actor'],
    '--mutant=permessi-ignorati': ['permesso-connessione-rivalutato', 'avvio-rispetta-connScope'],
  } },
  { file: 'unit-trasporto-ripristino.js', count: 7, mutants: {
    '--mutant=tab': ['STATO-SENZA-TAB', 'ACK-DOPO-CHIUSURA-TAB'],
    '--mutant=retry': ['NESSUN-RETRY-RESTORE'],
    '--mutant=disconnect': ['DISCONNECT-ESITO-INCERTO', 'OFFLINE-NESSUN-ACCODAMENTO'],
  } },
];
const sourceFiles = ['db/restoreOperations.js', 'server/eventi-backup.js', 'server/operazioni.js',
  'server/createServer.js', 'public/js/trasporto.js', ...suites.map(x => 'test/' + x.file), 'test/lab/unit-ripristino.cjs'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file,
  createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { suite: 'unit-ripristino', sorgenti: hashes(), verifiche: [], mutanti: [] };
function run(suite, flag) {
  const name = suite.file.replace('.js', '') + (flag ? '-' + flag.replace(/^--/, '').replace('=', '-') : '-controllo');
  const out = path.join(dir, name); fs.mkdirSync(out, { recursive: true });
  const result = spawnSync(process.execPath, [path.join(root, 'test', suite.file), ...(flag ? [flag] : [])], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60000, env: { ...process.env, LAB_REPORT_DIR: out },
  });
  const text = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(out, 'console.log'), text);
  const checks = [...text.matchAll(/^(?:MUTANTE [^:]+: )?(OK|FAIL) ([^:\r\n]+)(?::[^\r\n]*)?$/gm)]
    .map(match => ({ id: match[2], ok: match[1] === 'OK' }));
  return { code: result.status, errore: result.error?.message, verifiche: checks, log: path.join(out, 'console.log') };
}
for (const suite of suites) {
  const base = run(suite);
  const ok = base.code === 0 && !base.errore && base.verifiche.length === suite.count && base.verifiche.every(x => x.ok);
  report.verifiche.push({ file: suite.file, ...base, ok });
  console.log(`${ok ? 'OK' : 'FAIL'} ${suite.file}: ${base.verifiche.length} controlli`);
  if (ok && process.argv.includes('--sensitivity')) for (const [flag, expected] of Object.entries(suite.mutants)) {
    const result = run(suite, flag), failures = result.verifiche.filter(x => !x.ok).map(x => x.id).sort();
    const detected = result.code === 1 && !result.errore && result.verifiche.length === suite.count
      && JSON.stringify(failures) === JSON.stringify([...expected].sort())
      && expected.every(id => base.verifiche.some(x => x.id === id && x.ok));
    report.mutanti.push({ file: suite.file, flag, ...result, rilevato: detected });
    console.log(`${detected ? 'OK' : 'FAIL'} sensibilità ${suite.file} ${flag}`);
  }
}
report.sorgentiStabili = JSON.stringify(report.sorgenti) === JSON.stringify(hashes());
report.ok = report.sorgentiStabili && report.verifiche.every(x => x.ok) && report.mutanti.every(x => x.rilevato);
fs.writeFileSync(path.join(dir, 'unit-ripristino.json'), JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

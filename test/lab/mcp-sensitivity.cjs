'use strict';

// Un exit 1 da solo non prova la sensibilità: possono mancare database o
// dipendenze. Sono accettati soltanto i fallimenti degli oracoli attesi, con
// i valori effettivamente corrotti osservati sui database reali.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const outputDir = process.env.LAB_REPORT_DIR || path.join(root, '.scratch/lab-reports');
const caseDir = path.join(outputDir, 'mcp-sensitivity-cases');
fs.mkdirSync(caseDir, { recursive: true });
const report = { suite: 'sensibilita-mcp-reale', startedAt: new Date().toISOString(), results: [] };
const cases = [
  { id: 'MCP-MUTANTE-TOKEN', file: 'mcp.cjs', flag: '--mutant-confirmation-reuse', report: 'mcp-mutant.json',
    expected: ['MCP-001'], evidence: [/count: 2/, /replayOk: true/] },
  { id: 'MCP-MUTANTE-ATOMICITA', file: 'mcp-sql.cjs', flag: '--mutant-sql-partial-commit', report: 'mcp-sql-mutant.json',
    expected: ['mysql-SQL-001', 'postgresql-SQL-001'], evidence: [/amount: 60/] },
];
for (const entry of cases) {
  const logPath = path.join(caseDir, `${entry.id}.log`);
  const reportPath = path.join(caseDir, entry.report);
  // Un artefatto di un vecchio giro non può convalidare un processo fallito.
  if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
  const started = Date.now();
  const child = spawnSync(process.execPath, [path.join(__dirname, entry.file), entry.flag], {
    cwd: root, env: { ...process.env, LAB_REPORT_DIR: caseDir, LAB_MCP_REPORT: '' },
    encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  fs.writeFileSync(logPath, `${child.stdout || ''}\n${child.stderr || ''}`, 'utf8');
  try {
    assert.equal(child.error, undefined, `Impossibile completare il processo mutante: ${child.error}`);
    assert.equal(child.status, 1, 'Il test deve rilevare la mutazione con exit 1.');
    const result = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(result.mutant, true);
    assert.equal(result.passed, 0);
    assert.equal(result.failed, entry.expected.length);
    assert.deepEqual(result.results.filter(row => row.status === 'failed').map(row => row.id).sort(), entry.expected.slice().sort());
    for (const row of result.results) {
      for (const evidence of entry.evidence) assert.match(row.error, evidence, `Il fallimento ${row.id} deve dimostrare il valore reale corrotto.`);
    }
    report.results.push({ id: entry.id, status: 'passed', durationMs: Date.now() - started, detected: entry.expected, report: reportPath, log: logPath });
    console.log(`PASS ${entry.id}: rilevati ${entry.expected.join(', ')} con corruzione reale attesa.`);
  } catch (error) {
    report.results.push({ id: entry.id, status: 'failed', durationMs: Date.now() - started, error: error.stack || String(error), log: logPath });
    console.error(`FAIL ${entry.id}: ${error.stack || error}`);
    process.exitCode = 1;
  }
}
report.finishedAt = new Date().toISOString();
report.passed = report.results.filter(row => row.status === 'passed').length;
report.failed = report.results.filter(row => row.status === 'failed').length;
const reportPath = path.join(outputDir, 'mcp-sensitivity.json');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Sensibilità MCP: ${report.passed} mutazioni rilevate, ${report.failed} prove fallite. Report: ${reportPath}`);

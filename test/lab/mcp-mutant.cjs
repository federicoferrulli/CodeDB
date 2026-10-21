'use strict';

// Mutazione esclusivamente in memoria del server usa e getta. Il sorgente di
// produzione resta intatto; la prova di riuso token deve rilevare il difetto.
if (['confirmation-reuse', 'sql-partial-commit'].includes(process.env.CODEDB_LAB_MCP_MUTANT)) {
  const fs = require('node:fs');
  const path = require('node:path');
  const Module = require('node:module');
  const sqlMutant = process.env.CODEDB_LAB_MCP_MUTANT === 'sql-partial-commit';
  const target = path.resolve(__dirname, sqlMutant ? '../../db/sqlWriteBatch.js' : '../../mcp/McpGateway.js');
  const original = Module._extensions['.js'];
  Module._extensions['.js'] = function compile(mod, filename) {
    if (path.resolve(filename) !== target) return original(mod, filename);
    const source = fs.readFileSync(filename, 'utf8');
    const needle = sqlMutant
      ? 'results.push(await dialetto.esegui(conn, statementDelBatch(statements, index)));'
      : 'session.pendingWrites.delete(token); // monouso';
    if (source.split(needle).length !== 2) throw new Error('Mutazione MCP non applicabile: bersaglio cambiato.');
    const replacement = sqlMutant
      ? `${needle}\nif (index === 0) { await dialetto.commit(conn); await dialetto.begin(conn); if (dialetto.dentroLaTransazione) await dialetto.dentroLaTransazione(conn); }`
      : '/* laboratorio: consumo monouso rimosso intenzionalmente */';
    mod._compile(source.replace(needle, replacement), filename);
    process.stderr.write(`[LAB MUTANTE] Mutazione in memoria: ${process.env.CODEDB_LAB_MCP_MUTANT}.\n`);
  };
}

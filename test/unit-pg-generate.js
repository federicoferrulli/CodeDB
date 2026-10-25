'use strict';

// LAB008: cataloghi PG17/18 simulati, lettori di metadati e DDL di produzione.
// Il database reale e l'oracolo nativo sono in lab/backup-pg-generate.cjs.
// Mutanti isolati nel processo: --mutant-expression, --mutant-kind,
// --mutant-notnull, --mutant-collation, --mutant-metadata, --mutant-selezione.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const pgDdl = require('../db/pg-ddl');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const root = path.resolve(__dirname, '..');
const schema = 'Schema origine', table = 'Misure';
const expression = '(base * (2)::numeric)';
const textExpression = "(testo || ' / ''quoted'' STORED NOT NULL COLLATE'::text)";
const ordinaryDefault = "'DEFAULT GENERATED VIRTUAL'::text";
const report = { suite: 'unit-pg-generate', iniziato: new Date().toISOString(), mutanti: process.argv.filter(arg => arg.startsWith('--mutant-')), verifiche: [] };
report.sorgenti = Object.fromEntries(['db/pg-ddl.js', 'db/PostgreSqlStrategy.js', 'db/sqlMetadati.js', 'test/unit-pg-generate.js']
  .map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));

function catalogo(kind) {
  const columns = [
    { name: 'id', ctype: 'integer', notnull: true, cdefault: null },
    { name: 'base', ctype: 'numeric(10,2)', notnull: false, cdefault: null },
    { name: 'Calcolato', ctype: 'numeric(11,2)', notnull: true, cdefault: expression, generated: kind },
    { name: 'testo', ctype: 'text', notnull: false, cdefault: null },
    { name: 'etichetta', ctype: 'text', notnull: true, cdefault: textExpression, generated: kind, collation: '"C"' },
    { name: 'facoltativa', ctype: 'text', notnull: false, cdefault: '(testo)', generated: kind },
    { name: 'ordinaria', ctype: 'text', notnull: false, cdefault: ordinaryDefault },
  ].map(column => ({ typeSchema: 'pg_catalog', typeName: column.ctype, identity: '', generated: '', ...column }));
  const calls = [];
  let releases = 0;
  // Emula la proiezione del catalogo: i nuovi metadati non compaiono finché
  // la query non li legge. Gli alias sono liberi, il contratto pubblico no.
  const project = (row, sql, source, value) => {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = sql.match(new RegExp(`\\b${escaped}\\b(?:\\s+AS\\s+(?:"([^"]+)"|(\\w+)))?`, 'i'));
    if (match) row[match[1] || match[2] || source.split('.').pop()] = value;
  };
  const query = async (sql, params) => {
    sql = String(sql); calls.push({ sql, params });
    if (/^(BEGIN READ ONLY|SET LOCAL search_path|ROLLBACK)/.test(sql)) return { rows: [] };
    if (/FROM information_schema\.table_constraints/.test(sql)) {
      assert.deepEqual(params, [table, schema], '[PG-FIXTURE] PK della tabella nello schema corretto');
      return { rows: [{ name: 'id' }] };
    }
    if (/FROM information_schema\.columns/.test(sql)) {
      if (/is_identity\s*=\s*'YES'/.test(sql)) return { rows: [] };
      assert.deepEqual(params, [table, schema], '[PG-FIXTURE] campi della tabella nello schema corretto');
      return { rows: columns.map(column => {
        const row = { name: column.name, ctype: column.ctype, nullable: column.notnull ? 'NO' : 'YES',
          cdefault: column.generated ? null : column.cdefault, identity: 'NO', identity_generation: null,
          generated: column.generated ? 'ALWAYS' : 'NEVER', base_type: column.ctype, enum_values: null };
        project(row, sql, 'c.generation_expression', column.generated ? column.cdefault : null);
        project(row, sql, 'a.attgenerated', column.generated);
        project(row, sql, 'c.collation_name', column.collation ? 'C' : null);
        project(row, sql, 'c.collation_schema', column.collation ? 'pg_catalog' : null);
        // La forma regcollation::text è l'oracolo nativo già usato da pg-ddl.
        const collation = sql.match(/a\.attcollation::regcollation::text(?:\s+END)?\s+AS\s+(?:"([^"]+)"|(\w+))/i);
        if (collation) row[collation[1] || collation[2]] = column.collation || null;
        return row;
      }) };
    }
    if (/pg_catalog\.pg_sequence\s+p/.test(sql)) return { rows: [] };
    if (/SELECT a\.attname AS name/.test(sql) && /pg_catalog\.pg_attribute/.test(sql)) {
      assert.deepEqual(params, [schema, table], '[PG-FIXTURE] attributi della tabella nello schema corretto');
      return { rows: columns.map(column => ({ ...column })) };
    }
    if (/pg_get_constraintdef/.test(sql)) return { rows: [{ def: 'PRIMARY KEY (id)' }] };
    if (/SELECT t\.oid, t\.typtype|SELECT a\.attname, a\.atttypid/.test(sql)) return { rows: [] };
    throw new Error(`[PG-FIXTURE] Query non prevista: ${sql}`);
  };
  const strategy = new PostgreSqlStrategy();
  strategy.pool = { query, async connect() { return { query, release() { releases++; } }; } };
  return { columns, calls, query, strategy, get releases() { return releases; } };
}

function columnLine(ddl, column) {
  const prefix = '"' + column.replaceAll('"', '""') + '" ';
  const line = ddl.split('\n').map(value => value.trim()).find(value => value.startsWith(prefix));
  assert.ok(line, `[PG-GENERATA-COLONNA] colonna ${column} presente`);
  return line.replace(/,$/, '');
}
function withoutLiterals(sql) { return sql.replace(/'(?:''|[^'])*'/g, "'<letterale>'"); }
function checkExpressions(ddl, kind) {
  for (const [name, expr] of [['Calcolato', expression], ['etichetta', textExpression], ['facoltativa', '(testo)']]) {
    const line = columnLine(ddl, name);
    assert.ok(line.includes(`GENERATED ALWAYS AS (${expr})`), `[PG-GENERATA-ESPRESSIONE] ${name}: espressione SQL verbatim\n${line}`);
    assert.ok(new RegExp(`\\)\\s+${kind}\\b`).test(withoutLiterals(line)), `[PG-GENERATA-MODO] ${name}: atteso ${kind}\n${line}`);
    assert.ok(!/\bDEFAULT\b/.test(withoutLiterals(line)), `[PG-GENERATA-ESPRESSIONE] ${name}: il calcolo non è un DEFAULT`);
  }
  assert.ok(columnLine(ddl, 'Calcolato').startsWith('"Calcolato" numeric(11,2) '), '[PG-GENERATA-TIPO] precisione numerica e nome quotato');
}
function checkProperties(ddl) {
  assert.ok(/\bNOT NULL\b/.test(withoutLiterals(columnLine(ddl, 'Calcolato'))), '[PG-GENERATA-NOTNULL] vincolo della generata numerica');
  const label = withoutLiterals(columnLine(ddl, 'etichetta'));
  assert.ok(/\bNOT NULL\b/.test(label), '[PG-GENERATA-NOTNULL] vincolo della generata testo');
  assert.ok(/\bCOLLATE\s+"C"/.test(label), '[PG-GENERATA-COLLATION] collation esplicita del testo');
  assert.ok(!/\bNOT NULL\b/.test(withoutLiterals(columnLine(ddl, 'facoltativa'))), '[PG-GENERATA-NOTNULL] la generata nullable rimane nullable');
}
function checkOrdinary(ddl) {
  const line = columnLine(ddl, 'ordinaria');
  assert.ok(line.includes(`DEFAULT ${ordinaryDefault}`), '[PG-GENERATA-ORDINARIA] il DEFAULT ordinario rimane espressione');
  assert.ok(!/\bGENERATED\b/.test(withoutLiterals(line)), '[PG-GENERATA-ORDINARIA] le parole nel letterale non creano una generata');
  assert.ok(!/\bNOT NULL\b/.test(withoutLiterals(line)), '[PG-GENERATA-ORDINARIA] nullabilità ordinaria');
}

const mutant = flag => process.argv.includes(`--mutant-${flag}`);
const ddlOriginal = pgDdl.pgCreateTable, tableDdlOriginal = PostgreSqlStrategy.prototype.tableDdl;
const fieldsOriginal = PostgreSqlStrategy.prototype.tableFields, readOriginal = pgDdl.pgColonneDaSalvare;
function mutateDdl(ddl) {
  if (!ddl) return ddl;
  if (mutant('expression')) ddl = ddl.replace(expression, '(base * (3)::numeric)');
  if (mutant('kind')) ddl = ddl.replace(/\) (STORED|VIRTUAL)\b/g, (_whole, kind) => ') ' + (kind === 'STORED' ? 'VIRTUAL' : 'STORED'));
  if (mutant('notnull')) ddl = ddl.split('\n').map(line => line.trim().startsWith('"Calcolato" ') ? line.replace(/\s+NOT NULL\b/, '') : line).join('\n');
  if (mutant('collation')) ddl = ddl.split('\n').map(line => line.trim().startsWith('"etichetta" ') ? line.replace(/\s+COLLATE\s+"C"/, '') : line).join('\n');
  return ddl;
}
if (report.mutanti.length) {
  pgDdl.pgCreateTable = async (...args) => mutateDdl(await ddlOriginal(...args));
  PostgreSqlStrategy.prototype.tableDdl = async function(...args) { return mutateDdl(await tableDdlOriginal.apply(this, args)); };
  if (mutant('metadata')) PostgreSqlStrategy.prototype.tableFields = async function(...args) {
    return (await fieldsOriginal.apply(this, args)).map(field => {
      if (!field.generated) return field;
      const result = { ...field }; delete result.generationExpression; delete result.generationKind; return result;
    });
  };
  if (mutant('selezione')) pgDdl.pgColonneDaSalvare = async (...args) => {
    const result = await readOriginal(...args);
    return { ...result, nomi: [...result.nomi, 'Calcolato'], select: result.select + ', "Calcolato"::text AS "Calcolato"',
      columnSchema: [...result.columnSchema, { name: 'Calcolato', type: 'numeric(11,2)', nullable: false }] };
  };
}

async function check(id, action) {
  const entry = { id, ok: false };
  try { await action(); entry.ok = true; }
  catch (error) { entry.errore = error.stack; }
  report.verifiche.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${id}${entry.errore ? ': ' + entry.errore.split('\n')[0] : ''}`);
}

async function main() {
  for (const [code, kind] of [['s', 'STORED'], ['v', 'VIRTUAL']]) {
    await check(`metadati-${kind}`, async () => {
      const { strategy, columns } = catalogo(code);
      const fields = await strategy.tableFields(schema, table);
      assert.equal(fields.length, columns.length);
      for (const column of columns) {
        const field = fields.find(item => item.name === column.name);
        assert.equal(field.generated, !!column.generated, '[PG-GENERATA-METADATI] indicatore di colonna calcolata');
        assert.equal(field.nullable, !column.notnull);
        assert.equal(field.types[0], column.ctype);
        if (column.generated) {
          assert.equal(field.generationExpression, column.cdefault, '[PG-GENERATA-METADATI] espressione dal catalogo');
          assert.equal(field.generationKind, kind, '[PG-GENERATA-METADATI] STORED/VIRTUAL dal catalogo');
          assert.equal(field.default, null, '[PG-GENERATA-METADATI] espressione separata dal default');
        } else {
          assert.equal(field.generationExpression ?? null, null);
          assert.equal(field.generationKind ?? null, null);
        }
      }
    });
    for (const mode of ['backup', 'strategy']) {
      const makeDdl = async () => {
        const fixture = catalogo(code);
        const ddl = mode === 'backup'
          ? await pgDdl.pgCreateTable(fixture.query, schema, table, { qualificato: true })
          : await fixture.strategy.tableDdl(schema, table);
        assert.ok(ddl.startsWith(mode === 'backup' ? 'CREATE TABLE "Schema origine"."Misure" (' : 'CREATE TABLE "Misure" ('), '[PG-GENERATA-NOME] qualificazione delle due vie');
        if (mode === 'strategy') assert.ok(fixture.releases > 0, '[PG-GENERATA-POOL] connessione di catalogo rilasciata');
        return ddl;
      };
      await check(`${mode}-espressione-${kind}`, async () => checkExpressions(await makeDdl(), kind));
      await check(`${mode}-vincoli-${kind}`, async () => checkProperties(await makeDdl()));
      await check(`${mode}-ordinaria-${kind}`, async () => checkOrdinary(await makeDdl()));
    }
    await check(`lettura-${kind}`, async () => {
      const { query } = catalogo(code);
      const result = await pgDdl.pgColonneDaSalvare(query, schema, table);
      assert.deepEqual(result.nomi, ['id', 'base', 'testo', 'ordinaria'], '[PG-GENERATA-SELEZIONE] nessuna generata nel flusso dati');
      assert.deepEqual(result.columnSchema.map(column => column.name), result.nomi, '[PG-GENERATA-SELEZIONE] metadati delle sole colonne salvate');
      for (const name of ['Calcolato', 'etichetta', 'facoltativa']) assert.ok(!result.select.includes('"' + name + '"'), '[PG-GENERATA-SELEZIONE] SELECT priva dei valori calcolati');
      const selected = await pgDdl.pgColonneDaSalvare(query, schema, table, ['id', 'Calcolato']);
      assert.deepEqual(selected.nomi, ['id'], '[PG-GENERATA-SELEZIONE] onlyColumns non reintroduce una generata');
    });
  }
  report.ok = report.verifiche.every(item => item.ok); report.finito = new Date().toISOString();
  if (process.env.LAB_REPORT_DIR) {
    fs.mkdirSync(process.env.LAB_REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.LAB_REPORT_DIR, 'unit-pg-generate.json'), JSON.stringify(report, null, 2));
  }
  if (!report.ok) throw new Error(`[PG-GENERATE] ${report.verifiche.filter(item => !item.ok).length}/${report.verifiche.length} verifiche fallite`);
  return report;
}

module.exports = main().finally(() => {
  pgDdl.pgCreateTable = ddlOriginal; pgDdl.pgColonneDaSalvare = readOriginal;
  PostgreSqlStrategy.prototype.tableDdl = tableDdlOriginal; PostgreSqlStrategy.prototype.tableFields = fieldsOriginal;
}).catch(error => {
  process.exitCode = 1; console.error(error.message);
  if (require.main !== module) throw error;
});

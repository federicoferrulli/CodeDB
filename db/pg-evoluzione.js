'use strict';

const { quotaSempre } = require('./identificatori');
const { pgColonne } = require('./pg-ddl');
const { partiTabella } = require('./schema-merge');
const { riqualificaDdl } = require('../backup/lib/restore');
const q = name => quotaSempre(name, 'postgresql');

// Si opera su tabelle già svuotate nella transazione di promozione. ALTER
// conserva OID e attributi comuni; RESTRICT lascia al DBMS la verifica delle
// dipendenze che renderebbero una modifica incompatibile, senza CASCADE.
async function evolviTabella({ strategy, targetDb, stagingDb, name }) {
  const query = (sql, params) => strategy.pool.query(sql, params);
  const target = `${q(targetDb)}.${q(name)}`;
  const rewrite = sql => riqualificaDdl(sql, stagingDb, targetDb, 'postgresql');
  const before = await pgColonne(query, targetDb, name);
  const after = await pgColonne(query, stagingDb, name);
  const ddl = rewrite(await strategy.tableDdl(stagingDb, name));
  const definitions = partiTabella(ddl).parts;
  const definition = col => definitions.find(part => part.startsWith(q(col.name) + ' '));
  const constraints = async db => (await query(`SELECT c.conname AS name,pg_get_constraintdef(c.oid) AS ddl
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname=$2 AND c.contype IN ('p','u','c','x')`, [db, name])).rows;
  const oldKeys = await constraints(targetDb), newKeys = await constraints(stagingDb);
  const retained = new Set();
  for (const key of oldKeys) {
    if (newKeys.some(next => next.name === key.name && rewrite(next.ddl) === key.ddl)) retained.add(key.name);
    else await query(`ALTER TABLE ${target} DROP CONSTRAINT ${q(key.name)}`);
  }
  for (const col of before) if (!after.some(next => next.name === col.name)) {
    await query(`ALTER TABLE ${target} DROP COLUMN ${q(col.name)} RESTRICT`);
  }
  for (const col of after) {
    const old = before.find(item => item.name === col.name), column = q(col.name);
    if (!old) { await query(`ALTER TABLE ${target} ADD COLUMN ${definition(col)}`); continue; }
    const alter = suffix => query(`ALTER TABLE ${target} ALTER COLUMN ${column} ${suffix}`);
    if (old.generated !== col.generated || old.generationKind !== col.generationKind
        || (col.generated && old.generationExpression !== rewrite(col.generationExpression))) {
      // La sostituzione è necessaria quando cambia la natura della colonna.
      // Una dipendenza esterna impedisce la DROP e causa rollback completo.
      await query(`ALTER TABLE ${target} DROP COLUMN ${column} RESTRICT`);
      await query(`ALTER TABLE ${target} ADD COLUMN ${definition(col)}`);
      continue;
    }
    if (old.identity && !col.identity) await alter('DROP IDENTITY');
    const typeChanged = old.ctype !== rewrite(col.ctype) || (old.collation || '') !== rewrite(col.collation || '');
    if (typeChanged) {
      if (old.cdefault && !old.generated && !old.identity) await alter('DROP DEFAULT');
      await alter(`TYPE ${rewrite(col.ctype)}${col.collation ? ' COLLATE ' + rewrite(col.collation) : ''} USING NULL::${rewrite(col.ctype)}`);
    }
    if (!old.identity && col.identity) {
      const identity = definition(col).slice(definition(col).indexOf('GENERATED '));
      await alter('ADD ' + identity);
    } else if (old.identity && col.identity && old.identity !== col.identity) await alter(`SET GENERATED ${col.identity}`);
    if (!col.generated && !col.identity && (typeChanged || old.cdefault !== rewrite(col.cdefault || '') || !!old.identity)) {
      await alter(col.cdefault == null ? 'DROP DEFAULT' : `SET DEFAULT ${rewrite(col.cdefault)}`);
    }
    if (old.notnull !== col.notnull) await alter(col.notnull ? 'SET NOT NULL' : 'DROP NOT NULL');
  }
  for (const key of newKeys) if (!retained.has(key.name)) {
    await query(`ALTER TABLE ${target} ADD CONSTRAINT ${q(key.name)} ${rewrite(key.ddl)}`);
  }
}

module.exports = { evolviTabella };

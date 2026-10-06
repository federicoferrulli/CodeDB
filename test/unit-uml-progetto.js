'use strict';
const assert = require('assert');
const { prepara, applica } = require('../db/umlProgetto');
const { guardStrategy } = require('../auth/guardStrategy');
const { can } = require('../auth/permissions');
const DbStrategy = require('../db/DbStrategy');
const { registraEventi } = require('../server');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');

const crea = { kind: 'createTable', table: 'ordini', columns: [
  { name: 'id', type: 'integer', primaryKey: true, nullable: false },
  { name: 'cliente_id', type: 'integer', nullable: true },
] };
const fk = { kind: 'addForeignKey', table: 'ordini', name: 'fk_cliente', target: 'clienti', columns: ['cliente_id'], references: ['id'], onDelete: 'CASCADE' };
const allow = () => {};
function strategia(type) {
  return { type, ddl: 'CREATE TABLE clienti (id integer primary key)', calls: [],
    applySchemaStatement: DbStrategy.prototype.applySchemaStatement,
    async listCollections() { return [{ name: 'clienti' }]; },
    async tableDdl() { return this.ddl; },
    async tableAuxDdl() { return { indexes: [], foreignKeys: [] }; },
    async tableFields() { return [{ name: 'id', types: ['integer'], nullable: false, default: null }]; },
    async columnDefinition() { return { extra: '', columnType: 'integer', defaultValue: null }; },
    async primaryKeyName() { return 'clienti_pkey'; },
    async columnRelations() { return [{ nome: 'fk_cliente' }]; },
    async collectionAggregate(_db, _table, p) { this.calls.push(p.pipeline); return {}; },
  };
}

module.exports = (async () => {
  const { defaultDaCreate } = require('../db/mysqlColonne');
  const expression = "(concat('a)', 'b', (1 + 2)))";
  assert.strictEqual(defaultDaCreate(`CREATE TABLE t (\n  \`c\` varchar(50) DEFAULT ${expression} COMMENT 'nota'\n)`, '`c`'), expression);
  assert.strictEqual(defaultDaCreate('CREATE TABLE t (\n `c` timestamp DEFAULT CURRENT_TIMESTAMP(6)\n)', '`c`'), 'CURRENT_TIMESTAMP(6)');
  await assert.rejects(DbStrategy.prototype.applySchemaStatement.call(strategia('mysql'), 'vendite', 'clienti', undefined, { sql: 'DROP TABLE clienti' }));
  for (const type of ['mysql', 'postgresql']) {
    const raw = strategia(type);
    const principal = { grants: [{ connName: 'test', capabilities: ['read', 'ddl'], scope: { databases: ['vendite'], collections: ['clienti', 'ordini'] } }] };
    const strategy = guardStrategy(raw, { principal, connName: 'test' });
    const authorize = (coll) => { assert.ok(can(principal, { connName: 'test', capability: 'ddl', db: 'vendite', coll }), 'scope negato'); };
    const plan = await prepara(strategy, 'vendite', [crea, fk], authorize);
    assert.strictEqual(raw.calls.length, 0, 'l’anteprima non esegue DDL');
    assert.match(plan.steps[0].sql, /CREATE TABLE/);
    assert.match(plan.steps[1].sql, /ON DELETE CASCADE/);
    assert.ok(plan.steps[0].sql.includes(type === 'mysql' ? '`vendite`.`ordini`' : '"vendite"."ordini"'));
    const result = await applica(strategy, plan, authorize);
    assert.strictEqual(result.status, 'completato', result.error);
    assert.deepStrictEqual(raw.calls, plan.steps.map((s) => s.sql), 'esegue esattamente l’SQL mostrato');
    await applica(strategy, plan, authorize);
    assert.strictEqual(raw.calls.length, 2, 'lo stesso token non ripete le DDL');

    const stale = await prepara(strategy, 'vendite', [crea, fk], authorize);
    raw.ddl += ' -- cambiato';
    assert.strictEqual((await applica(strategy, stale, authorize)).status, 'interrotto');
    assert.strictEqual(raw.calls.length, 2, 'schema cambiato: nessuna DDL eseguita');
    await assert.rejects(prepara(strategy, 'vendite', [{ ...fk, target: 'segreti' }], authorize), /scope negato/);
    await assert.rejects(prepara(strategy, 'vendite', [{ ...crea, columns: [{ name: 'x', type: 'int); DROP TABLE clienti; --' }] }], authorize));
    await assert.rejects(prepara(strategy, 'vendite', [crea, { ...fk, onDelete: 'CASCADE; DROP TABLE clienti' }], authorize));
    await assert.rejects(prepara(strategy, 'vendite', [crea, { ...fk, references: ['id', 'id2'] }], authorize));

    const partial = await prepara(raw, 'vendite', [crea, fk], allow);
    raw.calls = [];
    raw.collectionAggregate = async (_db, _table, p) => { raw.calls.push(p.pipeline); if (raw.calls.length === 2) throw new Error('Rete interrotta'); };
    const failed = await applica(raw, partial, allow);
    assert.strictEqual(failed.status, 'interrotto');
    assert.deepStrictEqual(failed.results.map((r) => r.status), ['applicato', 'da_verificare']);
    await applica(raw, partial, allow);
    assert.strictEqual(raw.calls.length, 2, 'nemmeno un errore di rete permette un retry delle scritture');
  }
  const raw = strategia('postgresql');
  for (const type of ['postgresql', 'mysql']) {
    const s = strategia(type);
    const replacement = { ...fk, kind: 'replaceForeignKey', table: 'clienti', target: 'clienti', oldName: fk.name, onDelete: 'SET DEFAULT', onUpdate: 'SET DEFAULT' };
    if (type === 'mysql') await assert.rejects(prepara(s, 'vendite', [replacement], allow), /Azione referenziale/);
    else {
      const plan = await prepara(s, 'vendite', [replacement], allow);
      assert.match(plan.steps[0].sql, /ON DELETE SET DEFAULT ON UPDATE SET DEFAULT/);
    }
    s.columnRelations = async () => [{ nome: fk.name, db: 'comune', tabella: 'clienti' }];
    await assert.rejects(prepara(s, 'vendite', [{ ...replacement, onDelete: 'CASCADE' }], allow), /altro schema/,
      'un client diretto non può ritargettare una FK esterna contro un omonimo locale');
  }
  for (const type of ['mysql', 'postgresql']) {
    const s = strategia(type);
    const alteration = (table, oldName, name, type) => ({ kind: 'alterColumn', table, oldName, column: { name, type, nullable: false } });
    const sequential = await prepara(s, 'vendite', [
      alteration('clienti', 'id', 'id', 'bigint'), alteration('clienti', 'id', 'id', 'integer'),
      crea,
      alteration('ordini', 'id', 'numero', 'bigint'),
      { kind: 'addColumn', table: 'ordini', column: { name: 'nota', type: 'varchar(30)' } },
      alteration('ordini', 'nota', 'descrizione', 'varchar(60)'),
      { kind: 'renameTable', table: 'ordini', name: 'rinominata' },
      alteration('rinominata', 'descrizione', 'descrizione', 'varchar(90)'),
      { ...fk, table: 'rinominata' },
      { ...fk, kind: 'replaceForeignKey', table: 'rinominata', oldName: fk.name, name: 'fk_nuova' },
      { kind: 'dropForeignKey', table: 'rinominata', name: 'fk_nuova' },
      { kind: 'replacePrimaryKey', table: 'rinominata', columns: ['numero', 'cliente_id'] },
      { kind: 'dropPrimaryKey', table: 'rinominata' },
      { kind: 'addPrimaryKey', table: 'rinominata', columns: ['numero'] },
    ], allow);
    assert.match(sequential.steps.find(step => step.index === 1).sql, /(?:TYPE|`id`) integer/i, 'il secondo ALTER deve riportare il tipo a integer');
    assert.match(sequential.steps.find(step => step.index === 7).sql, /rinominata.*varchar\(90\)/, 'si modifica la colonna rinominata nella tabella rinominata');
    if (type === 'postgresql') {
      const replacement = sequential.steps.find(step => step.index === 11).sql.match(/ADD CONSTRAINT "([^"]+)"/)[1];
      assert.ok(sequential.steps.find(step => step.index === 12).sql.includes(replacement), 'DROP usa la PK prodotta dal passo precedente');
    }
    assert.strictEqual(s.calls.length, 0, 'la simulazione non esegue DDL');
  }
  const mysql = strategia('mysql');
  mysql.ddl = "CREATE TABLE `clienti` (`id` int AUTO_INCREMENT, `nota` text DEFAULT 'AUTO_INCREMENT=7') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";
  const concurrent = await prepara(mysql, 'vendite', [crea, fk], allow);
  mysql.ddl = mysql.ddl.replace('ENGINE=InnoDB ', 'ENGINE=InnoDB AUTO_INCREMENT=42 ');
  assert.strictEqual((await applica(mysql, concurrent, allow)).status, 'completato', 'un INSERT non invalida l’anteprima');
  const changedDefault = await prepara(mysql, 'vendite', [crea, fk], allow);
  mysql.ddl = mysql.ddl.replace("'AUTO_INCREMENT=7'", "'AUTO_INCREMENT=8'");
  assert.strictEqual((await applica(mysql, changedDefault, allow)).status, 'interrotto', 'i default non sono contatori da ignorare');
  const plan = await prepara(raw, 'vendite', [crea], allow);
  const [a, b] = await Promise.all([applica(raw, plan, allow), applica(raw, plan, allow)]);
  assert.strictEqual(raw.calls.length, 1, 'due applicazioni concorrenti eseguono una volta');
  assert.ok([a.status, b.status].includes('in_corso'));

  const sess = sessioneFinta({ tabId: 'tab-uml', connName: 'locale', dbType: 'postgresql', strategy: strategia('postgresql') });
  const ctx = contestoFinto({ sessioni: [['tab-uml', sess]] });
  registraEventi(ctx);
  const request = { tabId: 'tab-uml', db: 'vendite', operations: [crea] };
  const preview = await ctx.socket.chiama('uml:preview', request);
  assert.strictEqual(preview.ok, true, preview.error);
  const invalid = await ctx.socket.chiama('uml:apply', { ...request, token: 'inventato' });
  assert.strictEqual(invalid.ok, false);
  const wrongDb = await ctx.socket.chiama('uml:apply', { ...request, db: 'altro', token: preview.token });
  assert.strictEqual(wrongDb.ok, false);
  const applied = await ctx.socket.chiama('uml:apply', { ...request, token: preview.token, sql: 'DROP DATABASE vendite' });
  assert.strictEqual(applied.status, 'completato', applied.error);
  assert.strictEqual(sess.strategy.calls.length, 1);
  assert.match(sess.strategy.calls[0], /^CREATE TABLE/);

  const { validaDocumento } = await import('../public/js/uml-modello.js');
  const { doc } = validaDocumento({ versione: 1, progetto: [crea, fk] });
  assert.strictEqual(doc.progetto.length, 2, 'la bozza sopravvive al salvataggio/import');
  assert.strictEqual(doc.progetto[0].columns[0].primaryKey, true);
  const { campiProgettati, tabelleProgettate, metadatiProgettati } = await import('../public/js/uml-progetto-modello.js');
  const fields = campiProgettati([], 'ordini', [crea,
    { kind: 'addColumn', table: 'ordini', column: { name: 'nota', type: 'varchar(20)', nullable: false, default: 'iniziale' } },
    { kind: 'alterColumn', table: 'ordini', oldName: 'nota', column: { name: 'descrizione', type: 'varchar(40)', nullable: true, default: 'successivo' } },
  ]);
  assert.strictEqual(fields.find(f => f.name === 'id').nullable, false);
  assert.strictEqual(fields.find(f => f.name === 'descrizione').default, 'successivo');
  assert.ok(!fields.some(f => f.name === 'nota'), 'il form vede il nome prodotto dalla bozza');
  const ops = [crea, fk, { kind: 'renameTable', table: 'ordini', name: 'acquisti' },
    { kind: 'renameTable', table: 'clienti', name: 'persone' },
    { kind: 'alterColumn', table: 'persone', oldName: 'id', column: { name: 'codice', type: 'bigint' } },
    { kind: 'alterColumn', table: 'acquisti', oldName: 'cliente_id', column: { name: 'persona_id', type: 'bigint' } }];
  const tables = tabelleProgettate(['clienti'], ops);
  assert(campiProgettati([], 'ordini', ops).some(f => f.name === 'persona_id'), 'anche il canvas segue la rinomina della tabella');
  assert.deepStrictEqual([...tables.keys()], ['acquisti', 'persone']);
  assert.strictEqual(tables.get('persone').origine, 'clienti', 'i metadati provengono dal nome reale');
  const projected = metadatiProgettati({ fields: [], relazioni: [] }, 'acquisti', tables.get('acquisti'), ops, 'vendite');
  assert(projected.fields.some(f => f.name === 'persona_id'));
  assert.deepStrictEqual(projected.relazioni[0].coppie, [{ campo: 'persona_id', colonna: 'codice' }]);
  assert.strictEqual(projected.relazioni[0].tabella, 'persone');
  const removed = [...ops, { kind: 'dropForeignKey', table: 'acquisti', name: fk.name }];
  assert.strictEqual(metadatiProgettati({ fields: [], relazioni: [] }, 'acquisti', tabelleProgettate(['clienti'], removed).get('acquisti'), removed, 'vendite').relazioni.length, 0);
  assert(!tabelleProgettate(['clienti'], [...ops, { kind: 'dropTable', table: 'persone' }]).has('persone'));
  assert.deepStrictEqual([...tabelleProgettate(['clienti'], ops.slice(0, 2)).keys()], ['clienti', 'ordini'], 'modificare un passo vede solo quelli precedenti');
  console.log('✓ Progetto UML: dialetti, scope, SQL esatto, snapshot, concorrenza, errori parziali, socket e persistenza');
})();

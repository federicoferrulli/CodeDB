'use strict';

// Bozza strutturata -> SQL del server. Nessun SQL fornito dal browser viene eseguito.
const { randomUUID, createHash } = require('crypto');
const DbStrategy = require('./DbStrategy');
const MySqlStrategy = require('./MySqlStrategy');
const PostgreSqlStrategy = require('./PostgreSqlStrategy');
const { quotaSempre, quotaQualificato } = require('./identificatori');

function nome(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 63 || /[\0\r\n]/.test(value)) {
    throw new Error('Nome mancante o non valido (massimo 63 byte UTF-8).');
  }
  DbStrategy.assertCreatableName(value.trim(), 'dell’oggetto');
  return value.trim();
}

function colonna(c) {
  if (!c || typeof c !== 'object') throw new Error('Colonna non valida.');
  const type = String(c.type || '').trim();
  DbStrategy.assertColumnType(type);
  if (String(c.default || '').length > 2000) throw new Error('Valore predefinito troppo lungo.');
  return { name: nome(c.name), type, nullable: c.nullable !== false,
    default: c.default == null ? '' : String(c.default), autoIncrement: c.autoIncrement === true,
    primaryKey: c.primaryKey === true };
}

function lista(values) {
  if (!Array.isArray(values) || !values.length || values.length > 64) throw new Error('Scegli da 1 a 64 colonne.');
  const out = values.map(nome);
  if (new Set(out).size !== out.length) throw new Error('Una colonna compare più volte nel vincolo.');
  return out;
}

async function impronte(strategy, db, targets) {
  const presenti = new Set((await strategy.listCollections(db)).map((t) => t.name));
  const out = {};
  for (const table of targets) {
    let ddl = presenti.has(table) ? await strategy.tableDdl(db, table) : null;
    if (ddl && strategy.type === 'mysql') {
      // Il contatore cambia con gli INSERT. Stringhe, commenti e nomi quotati
      // restano intatti: AUTO_INCREMENT scritto in un default è schema vero.
      ddl = ddl.replace(/'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|`(?:``|[^`])*`|\/\*[\s\S]*?\*\/|\bAUTO_INCREMENT\s*=\s*\d+\s*/gi,
        token => /^AUTO_INCREMENT\s*=/i.test(token) ? '' : token);
    }
    out[table] = ddl == null ? null
      : createHash('sha256').update(JSON.stringify([ddl, await strategy.tableAuxDdl(db, table)])).digest('hex');
  }
  return out;
}

async function prepara(strategy, db, operations, authorize) {
  if (!['mysql', 'postgresql', 'postgres'].includes(strategy.type)) throw new Error('La progettazione dello schema è disponibile su MySQL e PostgreSQL.');
  nome(db);
  if (!Array.isArray(operations) || !operations.length || operations.length > 100
      || Buffer.byteLength(JSON.stringify(operations)) > 256000) throw new Error('La bozza deve contenere da 1 a 100 operazioni, entro 256 KB.');
  const mysql = strategy.type === 'mysql';
  const dialect = mysql ? MySqlStrategy : PostgreSqlStrategy;
  const q = (s) => quotaSempre(s, strategy.type);
  const qt = (s) => quotaQualificato([db, s], strategy.type);
  const targets = new Set();
  const steps = [];
  const ops = JSON.parse(JSON.stringify(operations));
  // Autorizza TUTTI i bersagli prima di leggere metadati o applicare un passo.
  for (const op of ops) {
    op.table = nome(op.table);
    targets.add(op.table);
    if (op.name) op.name = nome(op.name);
    if (op.kind === 'renameTable') targets.add(op.name = nome(op.name));
    if (['addForeignKey', 'replaceForeignKey'].includes(op.kind)) targets.add(op.target = nome(op.target));
  }
  for (const table of targets) authorize(table);
  const before = await impronte(strategy, db, targets);
  // Questo è lo schema dopo l'ultimo passo compilato, non una seconda lettura
  // del database. Le origini servono solo a caricare i metadati non ancora letti.
  const tables = new Map(Object.keys(before).filter(t => before[t]).map(t => [t, { source: t }]));
  const fieldsOf = async state => {
    if (!state.fields) state.fields = new Map((await strategy.tableFields(db, state.source))
      .map(f => [f.name, { ...f, source: f.name }]));
    return state.fields;
  };
  const relationsOf = async state => {
    if (!state.relations) state.relations = new Map((await strategy.columnRelations(db, state.source)).map(r => [r.nome || r.constraint, r]));
    return state.relations;
  };
  const fieldOf = c => ({ ...c, nullable: c.primaryKey || c.autoIncrement ? false : c.nullable,
    types: [c.type], key: c.primaryKey ? 'PRI' : '',
    mysql: { extra: c.autoIncrement ? 'auto_increment' : '', defaultValue: c.default, columnType: c.type } });
  const newPrimaryKey = () => mysql ? 'PRIMARY' : `uml_pk_${randomUUID().replace(/-/g, '')}`;
  for (const [index, op] of ops.entries()) {
    const table = qt(op.table);
    const add = (sql, warning = '') => steps.push({ index, table: op.table, kind: op.kind, sql, warning,
      target: ['addForeignKey', 'replaceForeignKey'].includes(op.kind) ? op.target : (op.kind === 'renameTable' ? op.name : undefined) });
    const state = tables.get(op.table);
    if (op.kind !== 'createTable' && !state) throw new Error(`Tabella «${op.table}» non trovata.`);
    switch (op.kind) {
      case 'createTable': {
        if (state) throw new Error(`La tabella «${op.table}» esiste già.`);
        if (!Array.isArray(op.columns) || !op.columns.length || op.columns.length > 200) throw new Error('La tabella deve avere da 1 a 200 colonne.');
        const cols = op.columns.map(colonna);
        if (new Set(cols.map((c) => c.name)).size !== cols.length) throw new Error('Nomi di colonna duplicati.');
        const defs = cols.map((c) => dialect.columnSql({ ...c, nullable: c.primaryKey ? false : c.nullable }));
        const pk = cols.filter((c) => c.primaryKey).map((c) => q(c.name));
        const primaryKey = pk.length ? newPrimaryKey() : null;
        if (pk.length) defs.push(`${mysql ? '' : `CONSTRAINT ${q(primaryKey)} `}PRIMARY KEY (${pk.join(', ')})`);
        add(`CREATE TABLE ${table} (${defs.join(', ')})`);
        tables.set(op.table, { fields: new Map(cols.map(c => [c.name, fieldOf(c)])), relations: new Map(), primaryKey });
        break;
      }
      case 'addColumn': {
        const c = colonna(op.column);
        const fields = await fieldsOf(state);
        if (fields.has(c.name)) throw new Error(`Colonna «${c.name}» già presente.`);
        const primaryKey = c.primaryKey ? newPrimaryKey() : null;
        add(`ALTER TABLE ${table} ADD COLUMN ${dialect.columnSql(c)}${primaryKey ? ` ${mysql ? '' : `CONSTRAINT ${q(primaryKey)} `}PRIMARY KEY` : ''}`, 'La tabella esistente può richiedere un valore per le righe già presenti.');
        fields.set(c.name, fieldOf(c));
        if (primaryKey) state.primaryKey = primaryKey;
        break;
      }
      case 'alterColumn': {
        const old = nome(op.oldName);
        const c = colonna(op.column);
        const fields = await fieldsOf(state);
        const current = fields.get(old);
        if (!current) throw new Error(`Colonna «${old}» non trovata.`);
        if (c.name !== old && fields.has(c.name)) throw new Error(`Colonna «${c.name}» già presente.`);
        if (current.generated) throw new Error('Per cambiare una colonna generata serve una DDL esplicita che ne preservi l’espressione.');
        if (mysql) {
          current.mysql ||= await strategy.columnDefinition(db, state.source, current.source);
          add(MySqlStrategy.columnAlterSql(db, op.table, { oldName: old, column: c }, current.mysql), 'Il cambio di tipo può convertire o perdere valori.');
          if (c.default !== String(current.default ?? '')) {
            current.mysql.extra = String(current.mysql.extra || '').replace(/default_generated/ig, '');
            delete current.mysql.defaultExpression;
          }
          Object.assign(current.mysql, { defaultValue: c.default, columnType: c.type });
          if (!/^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/i.test(c.type)) {
            delete current.mysql.charset; delete current.mysql.collation;
          }
          if (!/^(geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)$/i.test(c.type)) delete current.mysql.srid;
        } else {
          // Gli attributi non richiesti (identity, default, espressioni generate) restano al DB.
          const clauses = [];
          if (c.type.toLowerCase() !== String(current.types[0]).toLowerCase()) clauses.push(`ALTER COLUMN ${q(old)} TYPE ${c.type} USING ${q(old)}::${c.type}`);
          if (c.nullable !== current.nullable) clauses.push(`ALTER COLUMN ${q(old)} ${c.nullable ? 'DROP' : 'SET'} NOT NULL`);
          if (c.default !== String(current.default || '')) clauses.push(`ALTER COLUMN ${q(old)} ${c.default ? `SET DEFAULT ${dialect.defaultSql(c.default)}` : 'DROP DEFAULT'}`);
          if (clauses.length) add(`ALTER TABLE ${table} ${clauses.join(', ')}`, 'Il cambio di tipo può convertire o perdere valori.');
          if (c.name !== old) add(`ALTER TABLE ${table} RENAME COLUMN ${q(old)} TO ${q(c.name)}`);
        }
        fields.delete(old);
        fields.set(c.name, { ...current, name: c.name, types: [c.type], nullable: c.nullable, default: c.default });
        break;
      }
      case 'dropColumn': {
        if (!(await fieldsOf(state)).delete(nome(op.name))) throw new Error(`Colonna «${op.name}» non trovata.`);
        add(`ALTER TABLE ${table} DROP COLUMN ${q(nome(op.name))}`, 'Elimina definitivamente i valori della colonna e può rimuovere indici dipendenti.');
        break;
      }
      case 'renameTable':
        if (tables.has(op.name)) throw new Error(`La tabella «${op.name}» esiste già.`);
        add(mysql ? `RENAME TABLE ${table} TO ${qt(nome(op.name))}` : `ALTER TABLE ${table} RENAME TO ${q(nome(op.name))}`);
        tables.delete(op.table); tables.set(op.name, state);
        break;
      case 'dropTable':
        add(`DROP TABLE ${table}`, 'Elimina definitivamente la tabella e tutti i suoi dati.');
        tables.delete(op.table);
        break;
      case 'addPrimaryKey':
        state.primaryKey = newPrimaryKey();
        add(`ALTER TABLE ${table} ADD ${mysql ? '' : `CONSTRAINT ${q(state.primaryKey)} `}PRIMARY KEY (${lista(op.columns).map(q).join(', ')})`, 'I valori devono essere univoci e non nulli.');
        break;
      case 'dropPrimaryKey':
      case 'replacePrimaryKey': {
        if (state.primaryKey === undefined) state.primaryKey = mysql ? 'PRIMARY' : await strategy.primaryKeyName(db, state.source);
        if (!state.primaryKey) throw new Error('Chiave primaria non trovata.');
        const key = mysql ? 'PRIMARY KEY' : `CONSTRAINT ${q(state.primaryKey)}`;
        state.primaryKey = op.kind === 'replacePrimaryKey' ? newPrimaryKey() : null;
        add(`ALTER TABLE ${table} DROP ${key}${state.primaryKey ? `, ADD ${mysql ? '' : `CONSTRAINT ${q(state.primaryKey)} `}PRIMARY KEY (${lista(op.columns).map(q).join(', ')})` : ''}`,
          'La chiave può essere usata da relazioni o da colonne auto-incrementali. Il DB rifiuta dipendenze incompatibili.');
        break;
      }
      case 'replaceForeignKey':
      case 'addForeignKey': {
        const columns = lista(op.columns), referenced = lista(op.references);
        if (columns.length !== referenced.length) throw new Error('La relazione deve avere lo stesso numero di colonne sui due lati.');
        if (!tables.has(op.target)) throw new Error('Crea prima la tabella di destinazione.');
        const action = (v) => {
          if (!['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', ...(!mysql ? ['SET DEFAULT'] : [])].includes(v)) throw new Error('Azione referenziale non valida.');
          return v;
        };
        let drop = '';
        const relations = await relationsOf(state);
        if (op.kind === 'replaceForeignKey') {
          const original = relations.get(op.oldName);
          if (original?.db && original.db !== db) throw new Error('Il vincolo punta a un altro schema: usa una DDL esplicita per modificarlo.');
          if (!relations.delete(op.oldName)) throw new Error('Chiave esterna da modificare non trovata.');
          drop = `DROP ${mysql ? 'FOREIGN KEY' : 'CONSTRAINT'} ${q(nome(op.oldName))}, `;
        }
        add(`ALTER TABLE ${table} ${drop}ADD CONSTRAINT ${q(nome(op.name))} FOREIGN KEY (${columns.map(q).join(', ')}) REFERENCES ${qt(op.target)} (${referenced.map(q).join(', ')}) ON DELETE ${action(op.onDelete || 'NO ACTION')} ON UPDATE ${action(op.onUpdate || 'NO ACTION')}`,
          'I dati esistenti devono rispettare il vincolo. CASCADE e SET NULL agiscono anche sulle righe collegate.');
        relations.set(op.name, op);
        break;
      }
      case 'dropForeignKey':
        // La destinazione non viene dedotta dal nome: verifica che sia davvero una FK.
        if (!(await relationsOf(state)).delete(op.name)) throw new Error('Chiave esterna non trovata.');
        add(`ALTER TABLE ${table} DROP ${mysql ? 'FOREIGN KEY' : 'CONSTRAINT'} ${q(nome(op.name))}`, 'Il database non controllerà più questa relazione.');
        break;
      default: throw new Error('Operazione di progetto non riconosciuta.');
    }
    if (['addPrimaryKey', 'replacePrimaryKey', 'dropPrimaryKey'].includes(op.kind)) {
      for (const f of (await fieldsOf(state)).values()) {
        const pk = op.kind !== 'dropPrimaryKey' && op.columns.includes(f.name);
        f.key = pk ? 'PRI' : (f.key === 'PRI' ? '' : f.key);
        if (pk) f.nullable = false;
      }
    }
  }
  if (!steps.length) throw new Error('La bozza non contiene modifiche da applicare.');
  return { token: randomUUID(), db, type: strategy.type, before, steps, operations: ops,
    expires: Date.now() + 10 * 60 * 1000, status: 'pronto', results: [] };
}

async function applica(strategy, plan, authorize) {
  if (!plan || plan.expires < Date.now()) throw new Error('Anteprima scaduta: genera una nuova anteprima.');
  if (strategy.type !== plan.type) throw new Error('La connessione è cambiata: genera una nuova anteprima.');
  for (const table of Object.keys(plan.before)) authorize(table);
  // Il token viene consumato PRIMA del primo await: doppio clic e retry non ripetono DDL.
  if (plan.status !== 'pronto') return { status: plan.status, results: plan.results, error: plan.error };
  plan.status = 'in_corso';
  try {
    const now = await impronte(strategy, plan.db, Object.keys(plan.before));
    if (JSON.stringify(now) !== JSON.stringify(plan.before)) throw new Error('Lo schema è cambiato dopo l’anteprima. Rileggilo prima di applicare la bozza.');
    for (const step of plan.steps) {
      try {
        authorize(step.table);
        if (step.target) authorize(step.target);
        await strategy.applySchemaStatement(plan.db, step.table, step.target, { sql: step.sql, [DbStrategy.UML_DDL]: true });
        strategy._cacheColonne?.clear();
        plan.results.push({ ...step, status: 'applicato' });
      } catch (err) {
        // Un errore di rete non prova che il server DB non abbia eseguito la DDL.
        plan.results.push({ ...step, status: 'da_verificare', error: err.message });
        throw err;
      }
    }
    plan.status = 'completato';
  } catch (err) {
    plan.status = 'interrotto';
    plan.error = err.message;
  }
  return { status: plan.status, results: plan.results, error: plan.error };
}

module.exports = { prepara, applica };

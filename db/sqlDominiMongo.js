'use strict';
const schemaApi = require('./sqlSchemaMongo');
const { leggiEspressione, emettiEspressione } = require('./sqlEspressioni');
const { ACCESS } = require('./sqlMongoContesto');
const CATALOG = '_codedb_sql_domains';
const word = p => String(p.peek()?.value || '').toUpperCase();
const eat = (p, name) => word(p) === name && !!p.next();
const expect = (p, name) => { if (!eat(p, name)) throw new Error(`Dominio SQL: atteso ${name}.`); };
function check(p, name) {
  p.expectPunct('('); const expr = leggiEspressione(p); p.expectPunct(')');
  emettiEspressione(expr, n => { if (n.toUpperCase() !== 'VALUE') throw new Error('Un CHECK di dominio può riferirsi soltanto a VALUE.'); return 'value'; });
  return { name, expr };
}
function parse(p, op) {
  expect(p, 'DOMAIN');
  const ifExists = op === 'dropDomain' && eat(p, 'IF'); if (ifExists) expect(p, 'EXISTS');
  const coll = p.parseIdent(), plan = { kind: 'ddl', op, coll, ifExists };
  if (op === 'dropDomain') { plan.cascade = eat(p, 'CASCADE'); eat(p, 'RESTRICT'); return plan; }
  if (op === 'createDomain') {
    eat(p, 'AS'); const definition = { ...schemaApi.tipo(p), nullable: true, checks: [] };
    while (!p.eof() && !p.isPunct(';')) {
      if (eat(p, 'DEFAULT')) definition.default = leggiEspressione(p);
      else if (eat(p, 'NOT')) { expect(p, 'NULL'); definition.nullable = false; }
      else if (eat(p, 'NULL')) definition.nullable = true;
      else {
        const name = eat(p, 'CONSTRAINT') ? p.parseIdent() : `${coll}_check_${definition.checks.length + 1}`;
        expect(p, 'CHECK'); definition.checks.push(check(p, name));
      }
    }
    if (new Set(definition.checks.map(c => c.name)).size !== definition.checks.length) throw new Error('Nome del vincolo di dominio duplicato.');
    if (definition.default) emettiEspressione(definition.default, () => { throw new Error('DEFAULT di dominio non può riferirsi a colonne.'); });
    plan.definition = definition; return plan;
  }
  if (eat(p, 'SET')) {
    if (eat(p, 'DEFAULT')) plan.action = { op: 'default', expr: leggiEspressione(p) };
    else { expect(p, 'NOT'); expect(p, 'NULL'); plan.action = { op: 'nullable', value: false }; }
  } else if (eat(p, 'DROP')) {
    if (eat(p, 'DEFAULT')) plan.action = { op: 'default' };
    else if (eat(p, 'NOT')) { expect(p, 'NULL'); plan.action = { op: 'nullable', value: true }; }
    else { expect(p, 'CONSTRAINT'); plan.action = { op: 'dropCheck', name: p.parseIdent() }; }
  } else if (eat(p, 'VALIDATE')) { expect(p, 'CONSTRAINT'); plan.action = { op:'validateCheck', name:p.parseIdent() }; }
  else if (eat(p, 'RENAME')) { expect(p, 'CONSTRAINT'); const name=p.parseIdent(); expect(p,'TO'); plan.action={op:'renameCheck',name,to:p.parseIdent()}; }
  else {
    expect(p, 'ADD'); const name = eat(p, 'CONSTRAINT') ? p.parseIdent() : `${coll}_check`; expect(p, 'CHECK'); plan.action = { op: 'check', check: check(p, name) };
    if(eat(p,'NOT')) { expect(p,'VALID'); plan.action.check.validated=false; }
  }
  return plan;
}
async function risolvi(database, schema, overrides = new Map(), options = {}) {
  async function resolve(column, path = []) {
    if (!column.domain) return column;
    const name = column.domain;
    if (path.includes(name)) throw new Error('Dipendenza ciclica fra domini SQL.');
    const doc = overrides.has(name) ? { definition: overrides.get(name) } : await database.collection(CATALOG).findOne({ _id: name }, options);
    if (!doc?.definition) throw new Error(`Dominio SQL inesistente: ${name}.`);
    const raw = doc.definition, base = await resolve({ ...raw }, [...path, name]);
    const declared = column.domainDeclared || { nullable: column.nullable, array: !!column.array, ...(column.default ? { default: column.default } : {}) };
    const elementDomain = declared.array && !base.array;
    const inherited = [...(base.domainChecks || []), ...(raw.checks || [])];
    const result = { ...column, type: base.type, args: base.args, unsigned: base.unsigned,
      array: !!base.array || declared.array, nullable: elementDomain ? declared.nullable : declared.nullable !== false && base.nullable !== false,
      domain: name, domainDeclared: declared, domainChain: [name, ...(base.domainChain || [])], domainChecks: inherited,
      elementDomain, elementDomainNotNull: elementDomain && base.nullable === false };
    delete result.default;
    if (declared.default || !elementDomain && base.default) result.default = declared.default || base.default;
    return result;
  }
  for (let i = 0; i < schema.columns.length; i++) schema.columns[i] = await resolve(schema.columns[i]);
  return schema;
}
async function esegui(client, db, plan, payload, env) {
  if (plan.op === 'dropDomain') return require('./sqlDropDominio').esegui(client, db, plan, payload, env);
  const database = client.db(db), catalog = database.collection(CATALOG), refs = require('./sqlVincoliReferenziali');
  await refs.inizializzaBlocco(database);
  try { await database.createCollection(CATALOG); } catch (error) { if (error.code !== 48) throw error; }
  const session = client.startSession();
  try {
    if (plan.op === 'alterDomain') {
      const doc = await catalog.findOne({ _id: plan.coll }); if (!doc) throw new Error(`Dominio SQL inesistente: ${plan.coll}.`);
      const definition = { ...doc.definition, checks: [...doc.definition.checks] }, a = plan.action;
      if (a.op === 'check') { if (definition.checks.some(c => c.name === a.check.name)) throw new Error('Vincolo di dominio duplicato.'); definition.checks.push(a.check); }
      if (a.op === 'dropCheck') { if (!definition.checks.some(c => c.name === a.name)) throw new Error('Vincolo di dominio inesistente.'); definition.checks = definition.checks.filter(c => c.name !== a.name); }
      if (['validateCheck','renameCheck'].includes(a.op)) {
        const at=definition.checks.findIndex(c=>c.name===a.name); if(at<0) throw new Error('Vincolo di dominio inesistente.');
        if(a.op==='renameCheck' && definition.checks.some(c=>c.name===a.to)) throw new Error('Vincolo di dominio duplicato.');
        definition.checks[at]={...definition.checks[at],...(a.op==='renameCheck'?{name:a.to}:{validated:true})};
      }
      if (a.op === 'nullable') definition.nullable = a.value;
      if (a.op === 'default') { delete definition.default; if (a.expr) definition.default = a.expr; }
      const change = { name: plan.coll, definition, previous: doc.definition };
      await require('./sqlCastDomini').aggiorna(database, plan.coll, definition);
      const infos = await database.listCollections().toArray();
      const depends = i => {
        const s = schemaApi.daInfo(i);
        return s && (s.columns.some(c => c.domainChain?.includes(plan.coll)) || require('./sqlDipendenzeTipi').espressione(s, new Set([plan.coll])));
      };
      const affected = infos.filter(depends).sort((a, b) => a.name.localeCompare(b.name));
      if (affected.length) {
        for (const i of affected) payload[ACCESS]('ddl', i.name);
        return require('./sqlAlterMongo').esegui(client, db, affected[0].name, { kind: 'ddl', op: 'alterTable', coll: affected[0].name, actions: [], domainChange: change }, payload, env);
      }
      let appeared;
      await session.withTransaction(async () => { await refs.blocca(database, { session });
        appeared = (await database.listCollections().toArray()).find(depends);
        if (appeared) return;
        const current = await catalog.findOne({ _id: plan.coll }, { session });
        if (JSON.stringify(current?.definition) !== JSON.stringify(change.previous)) throw new Error('Dominio modificato contemporaneamente: ripeti ALTER DOMAIN.');
        await catalog.updateOne({ _id: plan.coll }, { $set: { definition } }, { session });
      });
      if (appeared) return require('./sqlAlterMongo').esegui(client, db, appeared.name, { kind: 'ddl', op: 'alterTable', coll: appeared.name, actions: [], domainChange: change }, payload, env);
      return;
    }
    await session.withTransaction(async () => {
      await refs.blocca(database, { session });
      if (plan.op === 'createDomain') {
        const candidate = { columns: [{ ...plan.definition, domain: plan.definition.domain, name: 'value', domainChecks: plan.definition.checks }], constraints: [] };
        await risolvi(database, candidate, new Map(), { session });
        await schemaApi.verificaDefault(database, candidate);
        await catalog.insertOne({ _id: plan.coll, definition: plan.definition }, { session });
      }
    }, { writeConcern: { w: 'majority' } });
  } finally { await session.endSession(); }
}
module.exports = { parse, risolvi, esegui };

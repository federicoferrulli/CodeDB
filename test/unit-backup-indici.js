'use strict';

// Confini pubblici del backup: file temporanei e una strategia registrante,
// senza connessioni DB. I cataloghi del fake descrivono due tabelle vuote.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const artefatti = require('../db/artefatti');
const ripristino = caricaRipristino();
const { canonicalSqlForDb } = require('../db/schemaObjects');
const { descriviBackup, createBackupRestoreAdapter } = require('../db/backupRestoreAdapter');
const { createImportArtifactAdapter } = require('../db/importArtifactAdapter');

const origine = 'src';
const destinazione = 'staging_indici';
const tabelle = ['Ordini', 'Clienti'];
const ddlTabella = (db, nome) => `CREATE TABLE "${db}"."${nome}" ("id" integer, "cliente" integer, "totale" integer, "nota" text);`;
const indiceUno = 'CREATE INDEX "ix_cliente" ON "src"."Ordini" USING btree ("cliente")';
const indiceDue = 'CREATE UNIQUE INDEX "ix_totale" ON "src"."Ordini" USING btree ("totale" DESC) WHERE ("totale" > 0)';
const vincolo = 'ALTER TABLE "src"."Ordini" ADD CONSTRAINT "fk_cliente" FOREIGN KEY ("cliente") REFERENCES "src"."Clienti" ("id")';
const moderni = () => ({ indexes: [indiceUno, indiceDue], foreignKeys: [vincolo] });
const precedenti = () => ({ foreignKeys: [indiceUno, vincolo, indiceDue] });
const log = { info() {}, error() {}, warn() {} };
const copia = (value) => JSON.parse(JSON.stringify(value));
const originaleNormalizza = artefatti.normalizzaLayerBackup;
const originaleApplica = ripristino.restoreSchemaObjects;

function caricaRipristino() {
  if (!process.argv.includes('--mutant-definer')) return require('../backup/lib/restore');
  // Ricrea in un modulo isolato il comportamento precedente: rimuove DEFINER
  // anche da PostgreSQL. Non sostituisce file né la cache condivisa di require.
  const Module = require('module');
  const file = require.resolve('../backup/lib/restore');
  const source = fs.readFileSync(file, 'utf8');
  const guardia = "dbType === 'mysql' ? senzaDefiner(testo) : testo";
  assert(source.includes(guardia), '[PG-INDICI-MUTANTE] la guardia del dialetto deve essere presente');
  const isolato = new Module(file, module);
  isolato.filename = file;
  isolato.paths = Module._nodeModulePaths(path.dirname(file));
  isolato._compile(source.replace(guardia, 'senzaDefiner(testo)'), file);
  return isolato.exports;
}

// I mutanti alterano soltanto il confine esportato e sono rimossi alla fine.
// I numeri, il contenuto degli indici e tutti gli altri validatori restano reali.
if (process.argv.includes('--mutant-legacy')) {
  artefatti.normalizzaLayerBackup = (input, options) => {
    const out = originaleNormalizza(input, options);
    if (input.objects?.foreignKeys?.some((sql) => /^CREATE\b/i.test(sql))) {
      out.objects.indexes = copia(input.objects.indexes || []);
    }
    return out;
  };
}
if (process.argv.includes('--mutant')) {
  ripristino.restoreSchemaObjects = (args) => originaleApplica({
    ...args, oggetti: { ...args.oggetti, indexes: [] },
  });
}

function layer(objects) {
  return {
    dbType: 'postgresql', database: origine, collections: [...tabelle],
    schemas: tabelle.map((collection) => ({ collection, sql: ddlTabella(origine, collection) })),
    objects, integrity: { verifiedCount: 1, unverifiableCount: 0 },
  };
}

function congela(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) congela(child);
    Object.freeze(value);
  }
  return value;
}

function normalizza(input, marker) {
  try { return artefatti.normalizzaLayerBackup(input); }
  catch (err) { assert.fail(`${marker} un artefatto valido deve essere accettato: ${err.message}`); }
}

function creaBackup(root, nome, objects) {
  const id = '20261022-180000_full';
  const dir = path.join(root, nome, id);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const aggiungi = (rel, content, meta) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    const bytes = fs.readFileSync(file);
    files.push({ path: rel, bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...meta });
  };
  for (const nomeTabella of tabelle) {
    aggiungi(`schema/${nomeTabella}.sql`, ddlTabella(origine, nomeTabella),
      { kind: 'schema', collection: nomeTabella, schema: origine });
    aggiungi(`data/${nomeTabella}.ndjson`, '',
      { kind: 'data', collection: nomeTabella, schema: origine, count: 0, mode: 'full' });
  }
  aggiungi('objects/schema.json', JSON.stringify(objects), { kind: 'objects', collection: null });
  // La versione 1 rappresenta anche i backup esistenti: nessuna identità
  // inventata, destinazione dichiarata vuota e cardinalità attesa pari a zero.
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    tool: 'codedb-backup', version: 1, id, type: 'full', baseId: null,
    connection: 'unit-indici', db: origine, dbType: 'postgresql',
    startedAt: '2026-10-22T18:00:00.000Z', endedAt: '2026-10-22T18:00:01.000Z', files,
  }), 'utf8');
  return dir;
}

function strategiaRegistrante({ omettiSecondo = false, alteraSecondo = false } = {}) {
  const chiamate = [];
  const applicate = [];
  const strategy = {
    type: 'postgresql',
    pool: {
      async connect() { return { query: this.query.bind(this), release() {} }; },
      async query(sql) {
      chiamate.push({ via: 'pool', sql });
      if (/SELECT NOT EXISTS\(/.test(sql)) return { rows: [{ empty: true }] };
      if (/SELECT COUNT\(\*\) AS cardinality/.test(sql)) return { rows: [{ cardinality: '0', distinctIdentities: null }] };
      // Nessun altro oggetto di schema né colonna particolare nel catalogo.
      return { rows: [] };
    } },
    async collectionAggregate(db, collection, { pipeline }) {
      chiamate.push({ via: 'aggregate', db, collection, sql: pipeline });
      if (/^SELECT tablename FROM pg_catalog\.pg_tables/.test(pipeline)) return { docs: [] };
      // Il catalogo contiene DDL additive applicate, non i DROP preparatori
      // che un merge esegue prima di ricostruire gli ausiliari finali.
      if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b|^ALTER TABLE\b[\s\S]*\bADD CONSTRAINT\b/i.test(pipeline)) applicate.push(pipeline);
      return { docs: [] };
    },
    async listCollections() { return tabelle.map((name) => ({ name, type: 'table' })); },
    async tableDdl(db, table) { return ddlTabella(db, table); },
    async tableAuxDdl(_db, table) {
      const pertinenti = applicate.filter((sql) => sql.includes(`."${table}"`));
      return {
        indexes: pertinenti.filter((sql) => /^CREATE\b/.test(sql))
          .filter((sql) => !(omettiSecondo && sql.includes('"ix_totale"')))
          .map((sql) => alteraSecondo && sql.includes('"ix_totale"') ? sql.replace('> 0', '> 10') : sql),
        foreignKeys: pertinenti.filter((sql) => /^ALTER TABLE\b/.test(sql)
          && sql.startsWith(`ALTER TABLE "${destinazione}"."${table}"`)),
      };
    },
    async collectionImport() { assert.fail('il fixture contiene soltanto tabelle vuote'); },
  };
  return { strategy, chiamate, applicate };
}

async function verificaAdapter(root, nome, objects, opzioni = {}) {
  const backupDir = creaBackup(root, nome, objects);
  const source = descriviBackup(backupDir);
  const plan = { kind: 'restore-backup', dbType: 'postgresql', source,
    sourceDb: origine, targetDb: destinazione, collections: source.collections, drop: false };
  const fake = strategiaRegistrante(opzioni);
  const adapter = createBackupRestoreAdapter({ strategy: fake.strategy,
    dbType: 'postgresql', connName: 'unit-indici', log });
  await adapter.validatePlan(plan);
  await adapter.apply(plan, { db: destinazione });
  return { result: await adapter.verify(plan, 'staging', { db: destinazione }), ...fake };
}

const casi = [];
casi.push(['normalizzazione del formato precedente e nuovo senza perdere indici', async () => {
  for (const [nome, objects] of [['precedente', precedenti()], ['nuovo', moderni()]]) {
    const input = congela(layer(objects));
    const prima = JSON.stringify(input);
    const out = normalizza(input, '[PG-INDICI-LEGACY]');
    assert.deepStrictEqual(out.objects.indexes, [indiceUno, indiceDue],
      `[PG-INDICI-LEGACY] ${nome}: entrambi gli indici devono essere separati dai vincoli`);
    assert.deepStrictEqual(out.objects.foreignKeys, [vincolo], '[PG-INDICI-LEGACY] la FK deve restare una FK');
    assert.strictEqual(JSON.stringify(input), prima, 'la normalizzazione non modifica l’artefatto originale');
  }
}]);

casi.push(['applicazione e riqualificazione di tutti gli indici e della FK', async () => {
  for (const objects of [moderni(), precedenti()]) {
    const fake = strategiaRegistrante();
    const problems = [];
    const prima = copia(objects);
    await ripristino.restoreSchemaObjects({ strategy: fake.strategy, targetDb: destinazione,
      dbType: 'postgresql', oggetti: congela(objects), dbOrigine: origine, problems, log });
    assert.deepStrictEqual(problems, [], '[PG-INDICI-APPLICAZIONE] nessun errore deve essere nascosto');
    const indici = fake.applicate.filter((sql) => /^CREATE\b/.test(sql));
    assert.strictEqual(indici.length, 2, '[PG-INDICI-APPLICAZIONE] devono essere applicati entrambi gli indici distinti');
    assert.strictEqual(fake.applicate.length, 3, '[PG-INDICI-APPLICAZIONE] indici e FK vanno applicati una volta');
    assert(fake.applicate.slice(0, 2).every((sql) => /^CREATE\b/.test(sql)),
      '[PG-INDICI-ORDINE] gli indici devono esistere prima delle FK che possono referenziarli');
    assert(indici.some((sql) => sql.includes('"ix_cliente"')), 'il primo indice deve esistere');
    assert(indici.some((sql) => sql.includes('"ix_totale"') && sql.includes('UNIQUE') && sql.includes('DESC') && sql.includes('> 0')),
      'univocità, ordine e predicato del secondo indice devono restare presenti');
    for (const sql of fake.applicate) {
      assert(sql.includes(`"${destinazione}"."Ordini"`), 'il bersaglio deve usare lo schema di destinazione');
      assert(!sql.includes('"src".'), 'nessun identificatore deve restare nello schema di origine');
    }
    assert.deepStrictEqual(objects, prima, 'l’applicazione non modifica gli oggetti di partenza');
  }
}]);

casi.push(['collisioni: è riutilizzabile solo lo stesso indice sulla stessa tabella', async () => {
  const indiceAtteso = indiceDue.replace('"src"."Ordini"', `"${destinazione}"."Ordini"`);
  for (const [nome, esistente, compatibile] of [
    ['identico', indiceAtteso, true],
    ['predicato diverso', indiceAtteso.replace('> 0', '> 10'), false],
    ['tabella diversa', indiceAtteso.replace('."Ordini"', '."Clienti"'), false],
  ]) {
    const consultate = [];
    const problems = [];
    await ripristino.restoreSchemaObjects({
      strategy: {
        async collectionAggregate() { throw Object.assign(new Error('relation already exists'), { code: '42P07' }); },
        async tableAuxDdl(db, table) { consultate.push([db, table]); return { indexes: [esistente] }; },
      }, targetDb: destinazione, dbType: 'postgresql', oggetti: { indexes: [indiceDue] },
      dbOrigine: origine, problems, log,
    });
    assert.deepStrictEqual(consultate, [[destinazione, 'Ordini']], '[PG-INDICI-COLLISIONE] va interrogata la tabella bersaglio');
    assert.strictEqual(problems.length === 0, compatibile,
      `[PG-INDICI-COLLISIONE] indice ${nome}: il nome da solo non prova equivalenza`);
  }
  const problems = [];
  await ripristino.restoreSchemaObjects({ strategy: {
    async collectionAggregate() { throw Object.assign(new Error('permesso negato'), { code: '42501' }); },
  }, targetDb: destinazione, dbType: 'postgresql', oggetti: { indexes: [indiceUno] },
  dbOrigine: origine, problems, log });
  assert(problems.some((message) => /indice.*permesso negato/.test(message)),
    '[PG-INDICI-ERRORE] un indice non applicato deve rendere incompleto il ripristino');
}]);

casi.push(['espressioni, literal e operatore PostgreSQL # restano supportati', async () => {
  const esempi = [
    `CREATE INDEX "ix_testo" ON "src"."Ordini" ((lower("nota"))) WHERE "nota" = 'src.marker; # non SQL'`,
    'CREATE INDEX "ix_dollar" ON "src"."Ordini" ("nota") WHERE "nota" = $val$src.marker; # non SQL$val$',
    'CREATE INDEX "ix_xor" ON "src"."Ordini" (("totale" # 1))',
    `CREATE INDEX "ix_definer" ON "src"."Ordini" ("nota") WHERE "nota" = 'prefix DEFINER=root@local valore'`,
    'CREATE INDEX "ix_definer_dollar" ON "src"."Ordini" ("nota") WHERE "nota" = $val$prefix DEFINER=root@local valore$val$',
  ];
  for (const sql of esempi) {
    for (const objects of [{ indexes: [sql] }, { foreignKeys: [sql] }]) {
      const out = normalizza(layer(objects), '[PG-INDICI-SINTASSI]');
      assert.deepStrictEqual(out.objects.indexes, [sql]);
    }
    const attesa = sql.replace('"src"."Ordini"', `"${destinazione}"."Ordini"`);
    const riqualificata = ripristino.riqualificaDdl(sql, origine, destinazione, 'postgresql');
    assert.strictEqual(riqualificata, attesa, '[PG-INDICI-LITERAL] si devono riscrivere solo gli identificatori');
    const fake = strategiaRegistrante();
    const problems = [];
    await ripristino.restoreSchemaObjects({ strategy: fake.strategy, targetDb: destinazione,
      dbType: 'postgresql', oggetti: { indexes: [sql] }, dbOrigine: origine, problems, log });
    assert.deepStrictEqual(problems, [], '[PG-INDICI-LITERAL] un indice con literal valido deve essere applicato');
    assert.deepStrictEqual(fake.applicate, [attesa],
      '[PG-INDICI-LITERAL] la pipeline applicata deve conservare anche DEFINER nei literal PostgreSQL');
    assert.strictEqual(canonicalSqlForDb(sql, origine), canonicalSqlForDb(attesa, destinazione),
      '[PG-INDICI-CONFRONTO] schema sorgente e destinazione non alterano la definizione');
    if (sql.includes('src.marker')) {
      assert(canonicalSqlForDb(sql, origine).includes('src.marker'),
        '[PG-INDICI-LITERAL] la canonicalizzazione deve conservare il literal');
      const diversa = sql.replace('src.marker', 'marker');
      assert.notStrictEqual(canonicalSqlForDb(sql, origine), canonicalSqlForDb(diversa, origine),
        '[PG-INDICI-CONFRONTO] predicati con literal diversi non possono collassare');
    }
  }
  assert.strictEqual(
    canonicalSqlForDb('CREATE INDEX ix ON `src`.`t` (`c`)', 'src'),
    canonicalSqlForDb('CREATE INDEX ix ON `dst`.`t` (`c`)', 'dst'),
    '[PG-INDICI-MYSQL] il supporto PostgreSQL non deve rompere la qualificazione MySQL',
  );
}]);

const indiciOstili = [
  ['schema della tabella estraneo', 'CREATE INDEX ix ON altro."Ordini" ("cliente")'],
  ['schema del nome indice estraneo', 'CREATE INDEX altro.ix ON src."Ordini" ("cliente")'],
  ['tabella non dichiarata', 'CREATE INDEX ix ON src."Segreti" ("cliente")'],
  ['case quotato diverso', 'CREATE INDEX ix ON src."ordini" ("cliente")'],
  ['seconda CREATE', `${indiceUno}; ${indiceDue}`],
  ['seconda DROP', `${indiceUno}; DROP TABLE altro.segreti`],
  ['XOR seguito da DROP', 'CREATE INDEX ix ON src."Ordini" (("totale" # 1)); DROP TABLE altro.segreti;'],
  ['DROP al posto di indice', 'DROP TABLE src."Ordini"'],
];
const vincoliOstili = [
  ['FK e DROP COLUMN nella stessa statement', `${vincolo}, DROP COLUMN "totale"`],
  ['ALTER distruttivo', 'ALTER TABLE src."Ordini" DROP COLUMN "totale"'],
  ['FK seguita da DROP', `${vincolo}; DROP TABLE altro.segreti`],
  ['FK con riferimento esterno', vincolo.replace('"src"."Clienti"', '"altro"."Clienti"')],
];

casi.push(['rifiuto delle DDL fuori perimetro prima di qualsiasi applicazione', async (root) => {
  const negativi = indiciOstili.flatMap(([nome, sql]) => [
    [`indice nuovo: ${nome}`, { indexes: [indiceDue, sql] }],
    [`indice precedente: ${nome}`, { foreignKeys: [indiceDue, sql] }],
  ]).concat(vincoliOstili.map(([nome, sql]) => [nome, { indexes: [indiceDue], foreignKeys: [sql] }]));
  let n = 0;
  for (const [nome, objects] of negativi) {
    let erroreAtteso;
    assert.throws(() => artefatti.normalizzaLayerBackup(layer(objects)), (err) => {
      erroreAtteso = err;
      return err instanceof Error;
    },
      `[PG-INDICI-CONFINE] ${nome}: l’artefatto deve essere rifiutato senza allowUnsafeSchema`);
    const backupDir = creaBackup(root, `ostile-${++n}`, objects);
    const fake = strategiaRegistrante();
    await assert.rejects(ripristino.runRestore({ session: { strategy: fake.strategy, dbType: 'postgresql' },
      backupDir, targetDb: destinazione, drop: false, log }), (err) => err.message === erroreAtteso.message,
    `[PG-INDICI-CONFINE] ${nome}: il preflight deve rifiutare l’intero backup`);
    assert.strictEqual(fake.chiamate.length, 0,
      `[PG-INDICI-CONFINE] ${nome}: nessuna istruzione deve raggiungere la strategia`);
    // Il seam diretto non riceve l'inventario delle tabelle. Il controllo di
    // appartenenza alla lista resta quindi provato sul preflight del manifest.
    if (!/tabella non dichiarata|case quotato diverso/.test(nome)) {
      const diretto = strategiaRegistrante();
      await assert.rejects(ripristino.restoreSchemaObjects({ strategy: diretto.strategy,
        targetDb: destinazione, dbType: 'postgresql', oggetti: objects,
        dbOrigine: origine, problems: [], log }), (err) => err.message === erroreAtteso.message,
      `[PG-INDICI-CONFINE] ${nome}: anche il seam diretto deve validare prima di applicare`);
      assert.strictEqual(diretto.chiamate.length, 0, `[PG-INDICI-CONFINE] ${nome}: seam senza effetti`);
    }
  }
}]);

casi.push(['verifica import: ausiliari in postDdl e objects senza doppi conteggi', async () => {
  const varianti = [
    ['postDdl', [indiceUno, indiceDue, vincolo], {}],
    ['objects', [], moderni()],
    ['misto', [indiceUno], { indexes: [indiceDue], foreignKeys: [vincolo] }],
    ['duplicato identico', [indiceUno], moderni()],
  ];
  for (const [nome, postDdl, objects] of varianti) {
    for (const omettiSecondo of [false, true]) {
      const fake = strategiaRegistrante({ omettiSecondo });
      await ripristino.restoreSchemaObjects({ strategy: fake.strategy, targetDb: destinazione,
        dbType: 'postgresql', oggetti: moderni(), dbOrigine: origine, problems: [], log });
      const artifact = artefatti.normalizzaExportDatabase({
        formato: 'codedb-database', versione: 1, dbType: 'postgresql', db: origine,
        collections: tabelle.map((name) => ({ name, docs: [], ddl: ddlTabella(origine, name),
          postDdl: name === 'Ordini' ? postDdl : [] })), objects,
      });
      const plan = { dbType: 'postgresql', sourceDb: origine, targetDb: destinazione, drop: true,
        artifact, collections: tabelle.map((name) => ({ name, rows: 0 })) };
      const adapter = createImportArtifactAdapter({ strategy: fake.strategy,
        dbType: 'postgresql', connName: 'unit-indici', log });
      const result = await adapter.verify(plan, 'staging', { db: destinazione });
      assert.strictEqual(result.ok, !omettiSecondo,
        `[PG-INDICI-IMPORT] ${nome}, secondo omesso=${omettiSecondo}: ${JSON.stringify(result.objectMismatches)}`);
    }
  }
}]);

casi.push(['adapter pubblico confronta entrambi i formati con lo schema applicato', async (root) => {
  for (const [nome, objects] of [['precedente', precedenti()], ['nuovo', moderni()]]) {
    const { result, applicate } = await verificaAdapter(root, `adapter-${nome}`, objects);
    assert.strictEqual(result.ok, true,
      `[PG-INDICI-INVENTARIO] ${nome}: ${JSON.stringify(result.schemaDifferences)}`);
    assert.strictEqual(applicate.filter((sql) => /^CREATE\b/.test(sql)).length, 2,
      '[PG-INDICI-INVENTARIO] il risultato positivo deve contenere due indici realmente applicati');
    assert.strictEqual(result.snapshot.schema.indexes.__all.length, 3,
      '[PG-INDICI-INVENTARIO] due indici distinti e una FK non possono collassare');
  }
  for (const [nome, opzioni] of [['mancante', { omettiSecondo: true }], ['diverso', { alteraSecondo: true }]]) {
    const { result } = await verificaAdapter(root, `adapter-${nome}`, moderni(), opzioni);
    assert.strictEqual(result.ok, false, `[PG-INDICI-INVENTARIO] indice ${nome}: la verifica deve fallire`);
    assert(result.schemaDifferences.some((diff) => diff.field === 'indexes:__all' && diff.missing?.length),
      `[PG-INDICI-INVENTARIO] indice ${nome}: la differenza deve indicare il contenuto mancante`);
  }
}]);

casi.push(['restore selettivo applica soltanto gli ausiliari delle tabelle scelte', async (root) => {
  const escluso = 'CREATE INDEX "ix_escluso" ON "src"."Clienti" ("id")';
  for (const [nome, objects] of [
    ['nuovo', { indexes: [indiceUno, escluso, indiceDue], foreignKeys: [vincolo] }],
    ['precedente', { foreignKeys: [indiceUno, escluso, vincolo, indiceDue] }],
  ]) {
    const backupDir = creaBackup(root, `selettivo-${nome}`, objects);
    const fake = strategiaRegistrante();
    await ripristino.runRestore({ session: { strategy: fake.strategy, dbType: 'postgresql' },
      backupDir, targetDb: destinazione, onlyCollections: ['Ordini'], drop: false, log });
    assert.strictEqual(fake.applicate.filter((sql) => /^CREATE\b/.test(sql)).length, 2,
      `[PG-INDICI-SELETTIVO] ${nome}: entrambi gli indici della tabella scelta devono essere applicati`);
    assert(fake.applicate.some((sql) => sql.includes('"fk_cliente"')),
      '[PG-INDICI-SELETTIVO] la FK della tabella scelta deve restare nel ripristino');
    assert(!fake.chiamate.some(({ sql }) => sql.includes('"ix_escluso"')
      || /^CREATE TABLE\b/.test(sql) && sql.includes('."Clienti"')),
    '[PG-INDICI-SELETTIVO] gli oggetti della tabella esclusa non devono essere modificati');
  }
}]);

module.exports = (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-unit-indici-'));
  try {
    for (const [nome, esegui] of casi) {
      await esegui(root);
      console.log('  OK   Indici backup:', nome);
    }
  } finally {
    artefatti.normalizzaLayerBackup = originaleNormalizza;
    ripristino.restoreSchemaObjects = originaleApplica;
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

if (require.main === module) module.exports.catch((err) => { console.error(err); process.exitCode = 1; });

'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario dei generatori e lettori di schema
 * (public/js/schema-export.js). Nessun database, nessun browser.
 *
 * Sono le funzioni che producono ciò che l'utente PORTA VIA: uno script DDL da
 * eseguire su un altro database, un file DBML da aprire in dbdiagram.io, uno
 * snapshot da confrontare. Un difetto qui non si vede a schermo — si scopre
 * quando lo script viene rifiutato dal DBMS, o non si scopre affatto.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

let falliti = 0;
function prova(nome, fn) {
  try {
    fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err && err.message}`);
  }
}

console.log('--- Test Unitari Generatori di Schema ---');

(async () => {
  const url = require('url').pathToFileURL(
    require('path').join(__dirname, '..', 'public', 'js', 'schema-export.js')
  ).href;
  const E = await import(url);

  /* ------------------------------- DDL SQL ------------------------------- */

  prova('Chiave primaria COMPOSTA: una sola clausola PRIMARY KEY', () => {
    // Due colonne `pk` producevano due `NOT NULL PRIMARY KEY` nella stessa
    // CREATE TABLE: MySQL e PostgreSQL la rifiutano entrambi.
    const ddl = E.buildSqlDdl({
      collections: [{
        name: 'iscrizioni',
        fields: [
          { name: 'corso_id', types: ['INT'], pk: true },
          { name: 'studente_id', types: ['INT'], pk: true },
          { name: 'voto', types: ['INT'] },
        ],
      }],
      relations: [],
    });
    const quante = (ddl.match(/PRIMARY KEY/g) || []).length;
    assert.strictEqual(quante, 1, `Una sola PRIMARY KEY per tabella (trovate ${quante})`);
    assert.ok(/PRIMARY KEY \(`corso_id`, `studente_id`\)/.test(ddl),
      `La chiave composta deve elencare entrambe le colonne:\n${ddl}`);
    assert.ok(!/`voto` INT NOT NULL/.test(ddl), 'Una colonna non-chiave non diventa NOT NULL');
  });

  prova('DDL e DBML dichiarano la STESSA colonna bersaglio', () => {
    const schema = {
      collections: [
        { name: 'ordini', fields: [{ name: 'id', types: ['INT'], pk: true }, { name: 'cliente_id', types: ['INT'] }] },
        { name: 'clienti', fields: [{ name: 'codice', types: ['VARCHAR'], pk: true }, { name: 'nome', types: ['VARCHAR'] }] },
      ],
      relations: [{ from: 'ordini', field: 'cliente_id', to: 'clienti' }],
    };
    const ddl = E.buildSqlDdl(schema);
    const dbml = E.buildDbmlDiagram(schema);
    // La chiave primaria vera di `clienti` è `codice`: nessuno dei due export
    // deve inventare `id` o `_id`.
    assert.ok(/REFERENCES `clienti` \(`codice`\)/.test(ddl), `Il DDL deve referenziare la PK reale:\n${ddl}`);
    assert.ok(/> "clienti"\."codice"/.test(dbml), `Il DBML deve referenziare la stessa colonna:\n${dbml}`);
  });

  prova('Su MongoDB il bersaglio ripiega su _id', () => {
    const schema = {
      collections: [
        { name: 'ordini', fields: [{ name: '_id' }, { name: 'cliente_id' }] },
        { name: 'clienti', fields: [{ name: '_id' }, { name: 'nome' }] },
      ],
      relations: [{ from: 'ordini', field: 'cliente_id', to: 'clienti' }],
    };
    assert.strictEqual(E.colonnaBersaglio(schema.collections, 'clienti'), '_id');
    assert.ok(/REFERENCES `clienti` \(`_id`\)/.test(E.buildSqlDdl(schema)));
  });

  prova('Schema vuoto: stringa vuota, non uno script rotto', () => {
    assert.strictEqual(E.buildSqlDdl({ collections: [] }), '');
    assert.strictEqual(E.buildDbmlDiagram({ collections: [] }), '');
    assert.strictEqual(E.buildMermaidDiagram({ collections: [] }), '');
    assert.strictEqual(E.buildSqlDdl(null), '');
  });

  /* ------------------------------- Mermaid ------------------------------- */

  prova('Mermaid: nomi con caratteri speciali sanificati', () => {
    const m = E.buildMermaidDiagram({
      collections: [{ name: 'anagrafica-clienti', fields: [{ name: 'e mail', types: ['string'] }] }],
      relations: [],
    });
    assert.ok(m.includes('anagrafica_clienti'), 'Il trattino non è ammesso in un id Mermaid');
    assert.ok(m.includes('e_mail'), 'Lo spazio non è ammesso in un id Mermaid');
  });

  /* --------------------------- Lettura di schema ------------------------- */

  prova('Import SQL: le FK sono attribuite alla tabella GIUSTA', () => {
    // Prima venivano tutte assegnate a una tabella letterale "imported", che
    // non esiste: il grafo mostrava relazioni che partivano dal nulla.
    const sql = `
      CREATE TABLE \`clienti\` (
        \`id\` INT NOT NULL,
        \`nome\` VARCHAR(80),
        PRIMARY KEY (\`id\`)
      );
      CREATE TABLE \`ordini\` (
        \`id\` INT NOT NULL,
        \`cliente_id\` INT,
        PRIMARY KEY (\`id\`),
        FOREIGN KEY (\`cliente_id\`) REFERENCES \`clienti\` (\`id\`)
      );
    `;
    const r = E.parseSchemaInput(sql, 'sql');
    assert.deepStrictEqual(r.collections.map((c) => c.name), ['clienti', 'ordini']);
    assert.strictEqual(r.relations.length, 1);
    assert.strictEqual(r.relations[0].from, 'ordini', `L'origine è "ordini", non "${r.relations[0].from}"`);
    assert.strictEqual(r.relations[0].to, 'clienti');
    assert.strictEqual(r.relations[0].field, 'cliente_id');
    assert.ok(!r.relations.some((x) => x.from === 'imported'), 'Nessuna relazione deve venire da "imported"');
  });

  prova('Import SQL: anche le ALTER TABLE … ADD CONSTRAINT', () => {
    const sql = `
      CREATE TABLE \`a\` (\`id\` INT NOT NULL, PRIMARY KEY (\`id\`));
      CREATE TABLE \`b\` (\`id\` INT NOT NULL, \`a_id\` INT, PRIMARY KEY (\`id\`));
      ALTER TABLE \`b\` ADD CONSTRAINT \`fk_b_a\` FOREIGN KEY (\`a_id\`) REFERENCES \`a\` (\`id\`);
    `;
    const r = E.parseSchemaInput(sql, 'sql');
    assert.strictEqual(r.relations.length, 1);
    assert.strictEqual(r.relations[0].from, 'b');
    assert.strictEqual(r.relations[0].to, 'a');
  });

  prova('Import SQL: la PRIMARY KEY in coda marca i campi come chiave', () => {
    const r = E.parseSchemaInput(
      'CREATE TABLE `t` (`a` INT, `b` INT, `c` INT, PRIMARY KEY (`a`, `b`));',
      'sql'
    );
    const pk = r.collections[0].fields.filter((f) => f.pk).map((f) => f.name);
    assert.deepStrictEqual(pk, ['a', 'b'], 'Una chiave composta dichiarata in coda va riconosciuta');
    // …e il giro completo deve tornare: import → export → una sola PRIMARY KEY.
    const ddl = E.buildSqlDdl(r);
    assert.strictEqual((ddl.match(/PRIMARY KEY/g) || []).length, 1);
  });

  prova('Import DBML: tabelle, chiavi e Ref', () => {
    const dbml = `
      Table "clienti" {
        "id" int [pk]
        "nome" varchar
      }
      Table "ordini" {
        "id" int [pk]
        "cliente_id" int
      }
      Ref: "ordini"."cliente_id" > "clienti"."id"
    `;
    const r = E.parseSchemaInput(dbml, 'dbml');
    assert.deepStrictEqual(r.collections.map((c) => c.name), ['clienti', 'ordini']);
    assert.strictEqual(r.collections[0].fields[0].pk, true);
    assert.deepStrictEqual(r.relations, [{ from: 'ordini', field: 'cliente_id', to: 'clienti', many: true }]);
  });

  prova('Testo senza schema: nessuna tabella, nessun errore', () => {
    const r = E.parseSchemaInput('questo non e\' uno schema', 'sql');
    assert.deepStrictEqual(r.collections, []);
    assert.deepStrictEqual(r.relations, []);
  });

  if (falliti) {
    console.error(`\n${falliti} test falliti.`);
    process.exitCode = 1;
  } else {
    console.log('\nTutti i test dei generatori di schema superati!');
  }
})();

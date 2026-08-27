'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario delle euristiche di analisi dello schema
 * (public/js/schema-analisi.js). Nessun database, nessun browser.
 *
 * Il modulo esiste perché queste funzioni erano DUE copie — una in
 * public/js/graph3d.js e una in mcp/McpGateway.js — già divergenti fra loro.
 * Qui si provano le proprietà che le rendono utili, e soprattutto i
 * CONTROESEMPI: un ordinamento di popolamento sbagliato e un report GDPR pieno
 * di falsi positivi non sembrano rotti, sembrano risposte.
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

console.log('--- Test Unitari Analisi dello Schema ---');

(async () => {
  const url = require('url').pathToFileURL(
    require('path').join(__dirname, '..', 'public', 'js', 'schema-analisi.js')
  ).href;
  const A = await import(url);

  const tab = (name, fields = [], extra = {}) => ({
    name,
    fields: fields.map((f) => (typeof f === 'string' ? { name: f, types: ['string'], presence: 100 } : f)),
    ...extra,
  });

  /* ------------------------- Ordine di popolamento ----------------------- */

  prova('Il seeding rispetta le dipendenze: prima chi non dipende da nessuno', () => {
    // ordini → clienti → paesi. L'ordine corretto è paesi, clienti, ordini.
    const schema = {
      collections: [tab('ordini', ['id', 'cliente_id']), tab('clienti', ['id', 'paese_id']), tab('paesi', ['id'])],
      relations: [
        { from: 'ordini', field: 'cliente_id', to: 'clienti' },
        { from: 'clienti', field: 'paese_id', to: 'paesi' },
      ],
    };
    const d = A.analyzeDependencies(schema);
    const pos = (n) => d.seeding_order.indexOf(n);
    assert.ok(pos('paesi') < pos('clienti'), 'paesi deve precedere clienti');
    assert.ok(pos('clienti') < pos('ordini'), 'clienti deve precedere ordini');
    assert.deepStrictEqual(d.cyclic_tables, [], 'Nessun ciclo in questo schema');
    assert.deepStrictEqual(d.root_tables, ['paesi'], 'ROOT = senza FK uscenti');
  });

  prova('Con molte tabelle scollegate l\'ordine resta valido', () => {
    const collections = [tab('ordini', ['id', 'cliente_id']), tab('clienti', ['id'])];
    for (let i = 0; i < 40; i++) collections.push(tab(`altra${i}`, ['id']));
    const d = A.analyzeDependencies({
      collections,
      relations: [{ from: 'ordini', field: 'cliente_id', to: 'clienti' }],
    });
    assert.strictEqual(d.seeding_order.length, collections.length, 'Tutte le tabelle devono comparire');
    assert.ok(
      d.seeding_order.indexOf('clienti') < d.seeding_order.indexOf('ordini'),
      'La dipendenza deve valere anche in mezzo a decine di tabelle scollegate'
    );
  });

  prova('Un ciclo di FK viene DICHIARATO, non accodato in silenzio', () => {
    const d = A.analyzeDependencies({
      collections: [tab('a', ['id', 'b_ref']), tab('b', ['id', 'a_ref'])],
      relations: [
        { from: 'a', field: 'b_ref', to: 'b' },
        { from: 'b', field: 'a_ref', to: 'a' },
      ],
    });
    assert.deepStrictEqual(d.cyclic_tables.sort(), ['a', 'b'], 'Le tabelle in ciclo vanno dichiarate');
    assert.deepStrictEqual(d.seeding_order, [], 'Nessun ordine valido esiste per un ciclo');
  });

  prova('Un autoanello è una componente ciclica esplicita', () => {
    const d = A.analyzeDependencies({
      collections: [tab('categorie', ['id', 'parent_id'])],
      relations: [{ from: 'categorie', field: 'parent_id', to: 'categorie' }],
    });
    assert.deepStrictEqual(d.cyclic_tables, ['categorie']);
    assert.deepStrictEqual(d.strongly_connected_components, [['categorie']]);
    assert.deepStrictEqual(d.seeding_order, []);
  });

  prova('Diamante, dipendenza esterna e nodo a valle di un ciclo restano distinti', () => {
    const d = A.analyzeDependencies({
      collections: [tab('root'), tab('sinistra'), tab('destra'), tab('foglia'), tab('a'), tab('b'), tab('valle')],
      relations: [
        { from: 'sinistra', to: 'root' }, { from: 'destra', to: 'root' },
        { from: 'foglia', to: 'sinistra' }, { from: 'foglia', to: 'destra' },
        { from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'valle', to: 'a' },
        { from: 'root', to: 'tabella_fuori', toDb: 'altro', external: true },
        { from: 'root', to: 'sinistra', toDb: 'altro', external: true },
      ],
    });
    assert.deepStrictEqual(d.cyclic_tables.sort(), ['a', 'b']);
    assert(!d.cyclic_tables.includes('valle'), 'dipendere da un ciclo non rende il nodo ciclico');
    assert.deepStrictEqual(d.blocked_by_cycles, ['valle']);
    assert(!d.seeding_order.includes('valle'));
    assert.strictEqual(d.external_dependencies.length, 2);
    assert(d.seeding_order.includes('root'), 'una dipendenza esterna non blocca il nodo interno');
    assert(d.seeding_order.indexOf('root') < d.seeding_order.indexOf('sinistra'));
    assert(d.seeding_order.indexOf('root') < d.seeding_order.indexOf('destra'));
  });

  /* -------------------------------- PII ---------------------------------- */

  prova('PII: i termini si confrontano coi token, non con le sottostringhe', () => {
    // Controesempi: sono tutti nomi comunissimi su uno schema italiano, e con
    // la ricerca per sottostringa (`ip`, `pass`, `auth`) risultavano PII.
    const falsiPositivi = [
      'tipo', 'descrizione', 'zip', 'shipping', 'recipient', 'equipment',
      'participant', 'principale', 'script', 'multiplo',
      'passeggero', 'passo', 'bypass', 'author', 'authorized_at',
    ];
    for (const n of falsiPositivi) {
      assert.strictEqual(A.terminePii(n), null, `"${n}" NON è un dato personale (ha risposto "${A.terminePii(n)}")`);
    }
  });

  prova('PII: i campi davvero sensibili restano riconosciuti', () => {
    const veri = [
      'email', 'user_email', 'emailAddress', 'telefono', 'phone_number',
      'password', 'password_hash', 'passwd', 'api_key', 'apiKey',
      'iban', 'codice_fiscale', 'codicefiscale', 'partita_iva',
      'ip', 'ip_address', 'clientIp', 'indirizzo', 'data_nascita', 'birth_date',
    ];
    for (const n of veri) {
      assert.ok(A.terminePii(n), `"${n}" deve essere riconosciuto come dato personale`);
    }
  });

  prova('PII: il risultato dice QUALE termine ha prodotto la corrispondenza', () => {
    const r = A.analyzePii({
      collections: [tab('utenti', ['id', 'email', 'tipo', 'descrizione'])],
      relations: [],
    });
    assert.strictEqual(r.total_pii_fields, 1, 'Solo "email" è un dato personale');
    assert.strictEqual(r.pii_by_table.utenti[0].matched_term, 'email',
      'Senza il termine, un falso positivo va indovinato invece che valutato');
  });

  /* --------------------------- Salute schema ----------------------------- */

  prova('Il punteggio usa davvero tutto l\'intervallo 0-100', () => {
    // Schema completamente malato: nessuna relazione, nessuna PK.
    const collections = [];
    for (let i = 0; i < 10; i++) collections.push(tab(`t${i}`, ['colonna']));
    const a = A.auditSchema({ collections, relations: [] });
    assert.ok(a.health_score < 20,
      `Uno schema senza PK né relazioni deve scendere sotto 20 (ottenuto ${a.health_score})`);
    assert.ok(a.health_score >= 0, 'Il punteggio non può essere negativo');
  });

  prova('Le penalità sono proporzionali alla dimensione dello schema', () => {
    // Tre tabelle orfane su tre è il 100% del database; tre su trecento è l'1%.
    const piccolo = { collections: [tab('a', ['_id']), tab('b', ['_id']), tab('c', ['_id'])], relations: [] };
    const grandi = [];
    for (let i = 0; i < 300; i++) grandi.push(tab(`t${i}`, ['_id']));
    // Nel grande, tutte tranne tre sono collegate a coppie.
    const relations = [];
    for (let i = 3; i + 1 < 300; i += 2) relations.push({ from: `t${i}`, field: 'x', to: `t${i + 1}` });
    const grande = { collections: grandi, relations };

    const sPiccolo = A.auditSchema(piccolo).health_score;
    const sGrande = A.auditSchema(grande).health_score;
    assert.ok(sGrande > sPiccolo,
      `Tre tabelle orfane su 300 devono pesare meno che tre su tre (${sGrande} vs ${sPiccolo})`);
  });

  prova('Uno schema sano vale 100', () => {
    const a = A.auditSchema({
      collections: [tab('ordini', ['_id', 'cliente_id']), tab('clienti', ['_id'])],
      relations: [{ from: 'ordini', field: 'cliente_id', to: 'clienti' }],
    });
    assert.strictEqual(a.health_score, 100);
    assert.deepStrictEqual(a.issues, []);
  });

  /* ------------------------ Relazioni implicite -------------------------- */

  prova('Relazioni implicite dedotte dai campi *_id', () => {
    const impl = A.detectImplicitRelations(
      [tab('ordini', ['_id', 'cliente_id']), tab('cliente', ['_id'])],
      []
    );
    assert.strictEqual(impl.length, 1);
    assert.strictEqual(impl[0].to, 'cliente');
    assert.strictEqual(impl[0].implicit, true);

    // Limite dichiarato: il plurale riconosciuto è quello inglese. Su uno
    // schema italiano `clienti` non viene associata a `cliente_id`.
    const italiano = A.detectImplicitRelations(
      [tab('ordini', ['_id', 'cliente_id']), tab('clienti', ['_id'])],
      []
    );
    assert.strictEqual(italiano.length, 0, 'Il plurale italiano non è riconosciuto (limite noto)');

    // Una relazione già dichiarata non viene duplicata.
    const conEsistente = A.detectImplicitRelations(
      [tab('ordini', ['_id', 'cliente_id']), tab('cliente', ['_id'])],
      [{ from: 'ordini', field: 'cliente_id', to: 'cliente' }]
    );
    assert.strictEqual(conEsistente.length, 0);
  });

  prova('Cammino minimo fra due tabelle', () => {
    const schema = {
      collections: [tab('a', ['id']), tab('b', ['id']), tab('c', ['id'])],
      relations: [{ from: 'a', field: 'x', to: 'b' }, { from: 'b', field: 'y', to: 'c' }],
    };
    const r = A.computeShortestPath(schema, 'a', 'c', false);
    assert.strictEqual(r.found, true);
    assert.deepStrictEqual(r.path, ['a', 'b', 'c']);
    assert.strictEqual(r.distance, 2);
    assert.strictEqual(A.computeShortestPath(schema, 'a', 'inesistente', false), null);
  });

  if (falliti) {
    console.error(`\n${falliti} test falliti.`);
    process.exitCode = 1;
  } else {
    console.log('\nTutti i test di analisi dello schema superati!');
  }
})();

'use strict';

// I due eventi che collegano i moduli del piano al resto dell'applicazione,
// provati con il contesto finto e i moduli VERI: una strategia finta al posto
// del database, nient'altro di finto.
//
// Ciò che conta qui non è che rispondano, ma che rispondano passando dai
// moduli giusti: il catalogo dal catalogo reale (mai le euristiche UML), il
// piano firmato, il database di sistema rifiutato lato SERVER — dove prima il
// controllo viveva solo nel browser, quindi chi parlava direttamente col
// socket poteva chiedere `mysql` o `pg_catalog`.

const assert = require('assert');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');
const { verificaImpronta } = require('../db/exportPlan');

// Un pool MySQL finto che risponde alle query del catalogo e a nient'altro:
// una query non prevista fa fallire il test dicendo QUALE, invece di tornare
// una lista vuota che si leggerebbe come «il database non ha tabelle».
function poolMySqlFinto() {
  const risposte = [
    // L'ordine conta: `TABLE_TYPE` distingue le tabelle dalle view, e una regex
    // sulla sola `information_schema.TABLES` risponderebbe alle due domande con
    // la stessa lista — cioè il catalogo prenderebbe le tabelle per view.
    [/TABLE_TYPE = 'VIEW'/i, []],
    [/FROM information_schema\.TABLES/i, [
      { name: 'clienti', rows_approx: 10 },
      { name: 'ordini', rows_approx: 40 },
    ]],
    [/FROM information_schema\.KEY_COLUMN_USAGE/i, [
      { src: 'ordini', col: 'cliente_id', ref_schema: 'negozio', ref: 'clienti' },
    ]],
  ];
  return {
    async getConnection() {
      return {
        async query(sql) {
          for (const [re, righe] of risposte) if (re.test(sql)) return [righe];
          return [[]];
        },
        release() {},
      };
    },
  };
}

const strategiaFinta = {
  type: 'mysql',
  pool: poolMySqlFinto(),
};

module.exports = (async () => {
  const { registraEventi } = require('../server');

  const ctx = contestoFinto({
    sessioni: [['tab-1', sessioneFinta({ strategy: strategiaFinta, dbType: 'mysql', connName: 'locale' })]],
  });
  registraEventi(ctx);

  /* --- Il piano di export ---------------------------------------------------- */

  {
    const res = await ctx.socket.chiama('database:export:plan', { tabId: 'tab-1', db: 'negozio' });
    assert.strictEqual(res.ok, true, res.error);
    const plan = res.plan;
    assert.strictEqual(plan.kind, 'export-database');
    assert.strictEqual(plan.sourceDb, 'negozio');
    assert.strictEqual(plan.connection, 'locale', 'la connessione è quella della SESSIONE, non del payload');
    // Firmato: anteprima ed esecuzione guardano lo stesso oggetto o l'esecuzione
    // rifiuta. Senza impronta non è un contratto.
    assert(plan.fingerprint, 'il piano è firmato');
    verificaImpronta(plan);
    assert.deepStrictEqual(
      plan.oggetti.map((o) => o.id).sort(),
      ['tabella:clienti', 'tabella:ordini'],
    );
    // Il catalogo viaggia accanto al piano: il wizard deve poter mostrare anche
    // ciò che il piano esclude.
    assert.deepStrictEqual(res.catalogo.map((o) => o.id).sort(), ['tabella:clienti', 'tabella:ordini']);
    // Il backend si guarda, non si presume: qui i tool nativi non ci sono.
    assert(res.motore && res.motore.backend, 'il motore è dichiarato');
    console.log('  OK   piano di export firmato, dal catalogo reale, con la connessione della sessione');
  }

  /* --- Solo struttura -------------------------------------------------------- */

  {
    const res = await ctx.socket.chiama('database:export:plan', {
      tabId: 'tab-1', db: 'negozio', modalita: 'solo-struttura',
    });
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.plan.contaRighe, false, 'solo struttura non scorre i dati, e lo DICHIARA');
    assert(res.plan.oggetti.every((o) => !o.dati));
    console.log('  OK   la modalità cambia il piano, non solo l etichetta');
  }

  /* --- Database di sistema, lato server -------------------------------------- */

  {
    const res = await ctx.socket.chiama('database:export:plan', { tabId: 'tab-1', db: 'mysql' });
    assert.strictEqual(res.ok, false, 'un database di sistema non produce un piano');
    assert.match(res.error || '', /sistema/i);
    console.log('  OK   il database di sistema è rifiutato dal server, non dal browser');
  }

  /* --- La selezione di import ------------------------------------------------ */

  {
    const artifact = {
      formato: 'codedb-database', versione: 1, dbType: 'mysql', db: 'negozio',
      collections: [
        { name: 'clienti', ddl: 'CREATE TABLE clienti (id INT PRIMARY KEY)', docs: [{ id: 1 }], identity: { kind: 'primary-key', columns: ['id'] } },
        { name: 'ordini', ddl: 'CREATE TABLE ordini (id INT PRIMARY KEY)', docs: [], identity: null },
      ],
    };
    const res = await ctx.socket.chiama('database:import:selezione', {
      tabId: 'tab-1', artifact, targetDb: 'copia',
    });
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.selezione.kind, 'selezione-import');
    assert(res.selezione.fingerprint, 'anche la selezione è un contratto firmato');
    assert.strictEqual(res.selezione.targetDb, 'copia');
    const ordini = res.selezione.voci.find((v) => v.nome === 'ordini');
    assert.strictEqual(ordini.dati, false, 'una collection senza documenti non dichiara dati');

    // Fondere senza identità stabile non è un merge: è un accoda che non lo
    // dice, con duplicati a ogni riesecuzione. Va rifiutato PRIMA di scrivere.
    const rifiutata = await ctx.socket.chiama('database:import:selezione', {
      tabId: 'tab-1', artifact, targetDb: 'copia',
      selezione: { 'tabella:ordini': { struttura: true, politica: 'fondi' } },
    });
    assert.strictEqual(rifiutata.ok, false);
    assert.match(rifiutata.error || '', /identit/i);

    // Un nome scritto male non si salta in silenzio: sarebbe un import
    // incompleto che si dichiara completo.
    const inventata = await ctx.socket.chiama('database:import:selezione', {
      tabId: 'tab-1', artifact, targetDb: 'copia',
      selezione: { 'tabella:inesistente': { struttura: true } },
    });
    assert.strictEqual(inventata.ok, false);
    console.log('  OK   selezione di import firmata, politiche impossibili rifiutate prima di scrivere');
  }

  console.log('  OK   Eventi del piano di export e della selezione di import passed');
})().catch((err) => {
  console.error('  FAIL Eventi del piano di export:', err.stack || err);
  process.exitCode = 1;
});

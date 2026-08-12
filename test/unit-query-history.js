'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari dello storico della tab ⚡ Query & Aggregate
 * (public/js/query-history-store.js). Nessun browser: il modulo è puro e lo
 * storage è iniettato, proprio per poter essere provato qui.
 *
 * Cosa vale la pena verificare, perché sbagliato NON si vede subito:
 *   1. la dedup è GLOBALE — senza, la stessa query rilanciata dieci volte
 *      consuma da sola l'elenco e butta fuori quella di un'ora fa, che è
 *      esattamente quella che si stava cercando;
 *   2. il tetto è rispettato e si pota dalla CODA (la voce più vecchia, non
 *      una a caso);
 *   3. i blocchi del chunker di file SQL non vengono registrati: pesano
 *      megabyte l'uno e riempirebbero la quota del localStorage, facendo
 *      sparire tutta la cronologia vera;
 *   4. uno storage rotto o pieno non deve mai propagare un'eccezione: la
 *      cronologia è un comodo, non deve poter impedire di eseguire una query.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

let falliti = 0;
function prova(nome, fn) {
  try {
    fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err.message}`);
  }
}

/** localStorage finto: la stessa API di quello vero, in memoria. */
function storageFinto(iniziale) {
  const dati = new Map(iniziale ? Object.entries(iniziale) : []);
  return {
    dati,
    getItem: (k) => (dati.has(k) ? dati.get(k) : null),
    setItem: (k, v) => { dati.set(k, String(v)); },
    removeItem: (k) => { dati.delete(k); },
  };
}

(async () => {
  const {
    CHIAVE_QE, MAX_VOCI, MAX_CODE,
    leggiVoci, registra, aggiornaEsito, filtra, connessioniPresenti, svuota,
  } = await import('../public/js/query-history-store.js');

  console.log('\n--- Storico query della tab Query & Aggregate ---');

  prova('registra e rilegge una voce', () => {
    const s = storageFinto();
    const id = registra(s, { code: 'SELECT 1', engine: 'sql', conn: 'locale', db: 'test' });
    assert.ok(id, 'deve restituire un id');
    const voci = leggiVoci(s);
    assert.strictEqual(voci.length, 1);
    assert.strictEqual(voci[0].code, 'SELECT 1');
    assert.strictEqual(voci[0].esito, null, 'al lancio l\'esito non è ancora noto');
  });

  prova('codice vuoto o solo spazi non viene registrato', () => {
    const s = storageFinto();
    assert.strictEqual(registra(s, { code: '   \n ' }), null);
    assert.strictEqual(leggiVoci(s).length, 0);
  });

  prova('dedup globale: la stessa query risale in testa senza duplicarsi', () => {
    const s = storageFinto();
    registra(s, { code: 'SELECT 1', engine: 'sql', conn: 'a', db: 'd' });
    registra(s, { code: 'SELECT 2', engine: 'sql', conn: 'a', db: 'd' });
    registra(s, { code: 'SELECT 3', engine: 'sql', conn: 'a', db: 'd' });
    // Rilancio della prima: NON è consecutiva, e deve comunque risalire.
    registra(s, { code: 'SELECT 1', engine: 'sql', conn: 'a', db: 'd' });
    const voci = leggiVoci(s);
    assert.strictEqual(voci.length, 3, 'nessuna voce duplicata');
    assert.strictEqual(voci[0].code, 'SELECT 1', 'la riesecuzione va in testa');
  });

  prova('la dedup normalizza gli spazi ma distingue bersaglio e motore', () => {
    const s = storageFinto();
    registra(s, { code: 'SELECT  1', engine: 'sql', conn: 'a', db: 'd' });
    registra(s, { code: 'SELECT\n1', engine: 'sql', conn: 'a', db: 'd' });
    assert.strictEqual(leggiVoci(s).length, 1, 'stesso testo a meno di spazi');
    registra(s, { code: 'SELECT 1', engine: 'sql', conn: 'a', db: 'ALTRO' });
    registra(s, { code: 'SELECT 1', engine: 'sql', conn: 'ALTRA', db: 'd' });
    assert.strictEqual(leggiVoci(s).length, 3, 'db e connessione diversi = voci diverse');
  });

  prova('tetto MAX_VOCI rispettato, si pota dalla coda', () => {
    const s = storageFinto();
    for (let i = 0; i < MAX_VOCI + 20; i++) registra(s, { code: `SELECT ${i}`, conn: 'a' });
    const voci = leggiVoci(s);
    assert.strictEqual(voci.length, MAX_VOCI);
    assert.strictEqual(voci[0].code, `SELECT ${MAX_VOCI + 19}`, 'la più recente è in testa');
    // Le prime 20 (le più vecchie) devono essere sparite, non altre.
    assert.ok(!voci.some((v) => v.code === 'SELECT 0'));
    assert.ok(voci.some((v) => v.code === `SELECT ${MAX_VOCI + 19}`));
  });

  prova('codice oltre MAX_CODE non viene registrato (blocchi del chunker SQL)', () => {
    const s = storageFinto();
    assert.strictEqual(registra(s, { code: 'x'.repeat(MAX_CODE + 1), conn: 'a' }), null);
    assert.strictEqual(leggiVoci(s).length, 0);
    assert.ok(registra(s, { code: 'x'.repeat(MAX_CODE), conn: 'a' }), 'al limite si registra');
  });

  prova('aggiornaEsito completa la voce; su id ignoto è un no-op', () => {
    const s = storageFinto();
    const id = registra(s, { code: 'SELECT 1', conn: 'a' });
    assert.strictEqual(aggiornaEsito(s, id, { esito: 'ok', ms: 42, righe: 7 }), true);
    const v = leggiVoci(s)[0];
    assert.strictEqual(v.esito, 'ok');
    assert.strictEqual(v.ms, 42);
    assert.strictEqual(v.righe, 7);
    assert.strictEqual(aggiornaEsito(s, 'inesistente', { esito: 'ok' }), false);
    assert.strictEqual(aggiornaEsito(s, null, { esito: 'ok' }), false);
    assert.strictEqual(leggiVoci(s).length, 1, 'nessuna voce creata da un id ignoto');
  });

  prova('filtra per testo, per connessione e per entrambi', () => {
    const voci = [
      { code: 'SELECT * FROM ordini', conn: 'prod', db: 'shop', coll: 'ordini' },
      { code: 'SELECT * FROM utenti', conn: 'prod', db: 'shop', coll: 'utenti' },
      { code: 'db.ordini.find({})', conn: 'locale', db: 'test', coll: 'ordini' },
    ];
    assert.strictEqual(filtra(voci, { testo: 'ordini' }).length, 2);
    assert.strictEqual(filtra(voci, { conn: 'prod' }).length, 2);
    assert.strictEqual(filtra(voci, { testo: 'ordini', conn: 'locale' }).length, 1);
    assert.strictEqual(filtra(voci, {}).length, 3, 'nessun filtro = tutte');
    // La ricerca non distingue maiuscole e guarda anche database e tabella.
    assert.strictEqual(filtra(voci, { testo: 'SHOP' }).length, 2);
  });

  prova('connessioniPresenti elenca le connessioni distinte, ordinate', () => {
    const voci = [{ conn: 'prod' }, { conn: 'locale' }, { conn: 'prod' }, { conn: '' }];
    assert.deepStrictEqual(connessioniPresenti(voci), ['locale', 'prod']);
  });

  prova('storage manomesso: nessuna eccezione, cronologia vuota', () => {
    assert.deepStrictEqual(leggiVoci(storageFinto({ [CHIAVE_QE]: '{{{ non json' })), []);
    assert.deepStrictEqual(leggiVoci(storageFinto({ [CHIAVE_QE]: '{"non":"un array"}' })), []);
    // Voci senza `code` (formato di una versione futura o file toccato a mano).
    const s = storageFinto({ [CHIAVE_QE]: JSON.stringify([{ ts: 1 }, { code: 'ok', ts: 2 }]) });
    assert.strictEqual(leggiVoci(s).length, 1);
  });

  prova('storage che rifiuta la scrittura (quota): registra non lancia', () => {
    const s = storageFinto();
    s.setItem = () => { throw new Error('QuotaExceededError'); };
    assert.doesNotThrow(() => registra(s, { code: 'SELECT 1', conn: 'a' }));
    assert.doesNotThrow(() => aggiornaEsito(s, 'x', { esito: 'ok' }));
  });

  prova('storage assente del tutto: nessuna eccezione', () => {
    const rotto = {
      getItem: () => { throw new Error('storage disabilitato'); },
      setItem: () => { throw new Error('storage disabilitato'); },
      removeItem: () => { throw new Error('storage disabilitato'); },
    };
    assert.deepStrictEqual(leggiVoci(rotto), []);
    assert.doesNotThrow(() => registra(rotto, { code: 'SELECT 1' }));
    assert.doesNotThrow(() => svuota(rotto));
  });

  prova('svuota cancella la chiave', () => {
    const s = storageFinto();
    registra(s, { code: 'SELECT 1', conn: 'a' });
    svuota(s);
    assert.strictEqual(s.getItem(CHIAVE_QE), null);
    assert.deepStrictEqual(leggiVoci(s), []);
  });

  prova('la chiave segue il prefisso codedb: (ripulita al logout)', () => {
    assert.ok(CHIAVE_QE.startsWith('codedb:'), `chiave fuori convenzione: ${CHIAVE_QE}`);
  });

  if (falliti) {
    console.error(`\n${falliti} test dello storico query FALLITI`);
    process.exitCode = 1;
  }
})();

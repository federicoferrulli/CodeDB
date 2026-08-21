'use strict';

/* ---------------------------------------------------------------------------
 * Il filtro strutturato e lo scope: la difesa è la FORMA del dato.
 *
 * Con il filtro testuale, un sottoutente con uno scope viene protetto da
 * `auth/sqlClause.js`: circa 460 righe di analisi sintattica difensiva che
 * esistono solo perché quel testo attraversa l'interfaccia della strategia. È
 * un firewall, e un firewall si valuta da ciò che lascia passare.
 *
 * Con il filtro strutturato quel firewall non serve, e la ragione non è che ci
 * si fida di più: è che uscire dallo scope non è **esprimibile**. Ogni `campo`
 * diventa un identificatore quotato INTERO — `altra_tabella.colonna` diventa
 * `` `altra_tabella.colonna` ``, cioè il nome di una colonna che non esiste, non
 * un riferimento a un'altra tabella. Non c'è sintassi da neutralizzare perché
 * non c'è sintassi.
 *
 * Questi test provano quella proprietà, che è la sola cosa che autorizza il
 * ticket 24 a cancellare il firewall.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { assertScopedClauses } = require('../auth/sqlClause');
const { normalizzaFiltro, rendiSql } = require('../db/filtro');
const DbFactory = require('../db/DbFactory');

const MYSQL = { qid: (n) => `\`${String(n).split('`').join('``')}\``, segnaposto: () => '?' };

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

module.exports = (() => {
  console.log('  --- Filtro strutturato e scope (auth/sqlClause.js) ---');

  /* --- La verifica legge i campi, non il testo -------------------------- */

  prova('un filtro strutturato ben formato passa la verifica di scope', () => {
    assert.doesNotThrow(() => assertScopedClauses({
      filtro: { condizioni: [{ campo: 'nome', operatore: 'uguale', valore: 'anna' }] },
    }));
  });

  prova('un filtro malformato viene rifiutato leggendone i campi', () => {
    // Non è un'analisi del testo: è la struttura che non torna.
    assert.throws(
      () => assertScopedClauses({ filtro: { condizioni: [{ operatore: 'uguale', valore: 1 }] } }),
      /non indica il campo/
    );
    assert.throws(
      () => assertScopedClauses({ filtro: { condizioni: [{ campo: 'a', operatore: 'oppure' }] } }),
      /operatore sconosciuto/
    );
    assert.throws(
      () => assertScopedClauses({ filtro: '{non json' }),
      /Filtro non valido/
    );
  });

  /* --- Uscire dallo scope NON è esprimibile ----------------------------- */

  const FUGHE = [
    // Ciò che con un frammento di testo avrebbe funzionato.
    'altra_tabella.colonna',
    'x FROM segreti WHERE 1=1 --',
    "x' UNION SELECT password FROM utenti --",
    'x) OR (SELECT 1 FROM utenti',
    '*',
  ];

  prova('un campo che prova a nominare un\'altra tabella resta UN nome di colonna', () => {
    // È la proprietà che rende superfluo il firewall sintattico.
    for (const fuga of FUGHE) {
      const f = normalizzaFiltro({ condizioni: [{ campo: fuga, operatore: 'vuoto' }] });
      const reso = rendiSql(f, MYSQL);
      // Un solo identificatore quotato, e nient'altro: nessun FROM, nessuna
      // parentesi che chiuda la condizione, nessuna UNION.
      assert.ok(
        /^`[^`]*(``[^`]*)*` IS NULL$/.test(reso.sql),
        `la fuga "${fuga}" ha prodotto SQL con struttura propria: ${reso.sql}`
      );
      assert.ok(!/\bFROM\b|\bUNION\b|--/.test(reso.sql.replace(/`[^`]*`/g, '')),
        `fuori dall'identificatore è comparsa sintassi: ${reso.sql}`);
    }
  });

  prova('un VALORE ostile non aggiunge struttura, su nessuno dei due motori', () => {
    for (const ostile of ["' OR 1=1 --", '1); DROP TABLE utenti; --']) {
      for (const tipo of ['mysql', 'postgresql']) {
        const { whereSql, whereParams } = DbFactory.getStrategy(tipo).buildSelect('d', 't', {
          filtro: { condizioni: [{ campo: 'nome', operatore: 'uguale', valore: ostile }] },
        });
        const segnaposto = tipo === 'mysql' ? '?' : '$1';
        assert.strictEqual(whereSql, ` WHERE ${tipo === 'mysql' ? '`nome`' : '"nome"'} = ${segnaposto}`);
        assert.deepStrictEqual(whereParams, [ostile], 'il valore resta un parametro');
      }
    }
  });

  prova('caratteri di controllo nel campo: rifiutati prima di arrivare al motore', () => {
    // Un a capo dentro un nome non è un nome, e lasciarlo passare rimetterebbe
    // in circolo il testo grezzo dalla porta di servizio.
    for (const cattivo of ['a\nDROP TABLE x', 'a\rb', 'a\0b']) {
      assert.throws(
        () => assertScopedClauses({ filtro: { condizioni: [{ campo: cattivo, operatore: 'vuoto' }] } }),
        /caratteri di controllo/,
        `doveva rifiutare ${JSON.stringify(cattivo)}`
      );
    }
  });

  /* --- Il filtro testuale resta protetto come prima --------------------- */

  prova('il filtro TESTUALE conserva il suo firewall', () => {
    // Il ticket 23 non tocca la vecchia via: sparirà con il 24, e fino ad
    // allora deve difendere esattamente come prima.
    assert.throws(
      () => assertScopedClauses({ filter: 'x UNION SELECT 1' }),
      /non consentito/i
    );
    assert.doesNotThrow(() => assertScopedClauses({ filter: 'eta > 30' }));
  });

  prova('i due filtri si verificano entrambi quando arrivano insieme', () => {
    // Finché convivono, nessuno dei due può fare da porta di servizio all'altro.
    assert.throws(
      () => assertScopedClauses({
        filter: 'x UNION SELECT 1',
        filtro: { condizioni: [{ campo: 'nome', operatore: 'vuoto' }] },
      }),
      /non consentito/i
    );
    assert.throws(
      () => assertScopedClauses({
        filter: 'eta > 30',
        filtro: { condizioni: [{ campo: 'a', operatore: 'boh' }] },
      }),
      /operatore sconosciuto/
    );
  });

  if (falliti) throw new Error(`${falliti} test del filtro e scope falliti`);
  console.log('  Filtro strutturato: uscire dallo scope non è esprimibile.');
})();

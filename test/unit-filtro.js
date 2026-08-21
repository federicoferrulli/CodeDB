'use strict';

/* ---------------------------------------------------------------------------
 * Il filtro come DATO (db/filtro.js).
 *
 * Fino a qui lo stesso parametro `filter` significava tre cose diverse a
 * seconda del motore: un frammento di clausola SQL grezzo sui due motori SQL,
 * un documento MQL sul motore documentale. La firma era piccola e l'invariante
 * enorme — ogni chiamante doveva sapere in anticipo quale motore avrebbe
 * risposto.
 *
 * Quello che conta di più in questi test non è che la resa sia «giusta»: è che
 * il VALORE non attraversi mai il testo della query. È questa, e non un elenco
 * di caratteri vietati, la ragione per cui un valore ostile non può cambiare la
 * struttura di ciò che viene eseguito — e ogni prova qui sotto sui valori
 * ostili verifica proprio la separazione, non la sanificazione.
 *
 * Nessun database: il modulo è puro, e i dialetti sono quelli VERI presi dagli
 * adattatori attraverso `buildSelect`.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { normalizzaFiltro, rendiSql, rendiMongo, NOMI_OPERATORI } = require('../db/filtro');
const DbFactory = require('../db/DbFactory');

const MYSQL = { qid: (n) => `\`${n}\``, segnaposto: () => '?' };
const PG = { qid: (n) => `"${n}"`, segnaposto: (i) => `$${i}` };

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

const filtro = (condizioni, unione) => normalizzaFiltro({ condizioni, unione });

module.exports = (() => {
  console.log('  --- Il filtro strutturato (db/filtro.js) ---');

  /* --- Normalizzazione: rifiuta, non indovina --------------------------- */

  prova('nessun filtro è null, e null non è un filtro vuoto', () => {
    // Sono due cose diverse: `null` significa «nessuna condizione», e chi lo
    // riceve non deve scrivere alcun WHERE.
    assert.strictEqual(normalizzaFiltro(null), null);
    assert.strictEqual(normalizzaFiltro(undefined), null);
    assert.strictEqual(normalizzaFiltro(''), null);
    assert.strictEqual(normalizzaFiltro({ condizioni: [] }), null);
  });

  prova('un operatore sconosciuto è un errore che elenca quelli previsti', () => {
    assert.throws(
      () => filtro([{ campo: 'a', operatore: 'quasiUguale', valore: 1 }]),
      (err) => {
        assert.ok(/operatore sconosciuto "quasiUguale"/.test(err.message), err.message);
        assert.ok(NOMI_OPERATORI.every((o) => err.message.includes(o)), 'deve elencarli tutti');
        return true;
      }
    );
  });

  prova('un campo assente o con caratteri di controllo è un errore', () => {
    assert.throws(() => filtro([{ operatore: 'uguale', valore: 1 }]), /non indica il campo/);
    assert.throws(() => filtro([{ campo: '  ', operatore: 'uguale', valore: 1 }]), /non indica il campo/);
    // Un nome con un a capo non è un nome: lasciarlo passare rimetterebbe in
    // circolo il testo grezzo dalla porta di servizio.
    assert.throws(
      () => filtro([{ campo: 'a\nDROP TABLE x', operatore: 'uguale', valore: 1 }]),
      /caratteri di controllo/
    );
  });

  prova('il numero dei valori è verificato per operatore', () => {
    assert.throws(() => filtro([{ campo: 'a', operatore: 'uguale' }]), /vuole un valore/);
    assert.throws(() => filtro([{ campo: 'a', operatore: 'dentro', valore: 1 }]), /elenco di valori/);
    assert.throws(() => filtro([{ campo: 'a', operatore: 'dentro', valore: [] }]), /elenco di valori/);
    // `vuoto` non vuole valori, e passarne uno non è un errore: viene ignorato.
    assert.strictEqual(filtro([{ campo: 'a', operatore: 'vuoto' }]).condizioni[0].valore, undefined);
  });

  prova("l'unione è «e» oppure «o», e nient'altro", () => {
    assert.strictEqual(filtro([{ campo: 'a', operatore: 'vuoto' }], 'o').unione, 'o');
    assert.throws(() => filtro([{ campo: 'a', operatore: 'vuoto' }], 'forse'), /Unione del filtro non valida/);
  });

  prova('un filtro può arrivare come testo JSON', () => {
    const f = normalizzaFiltro('{"condizioni":[{"campo":"a","operatore":"uguale","valore":1}]}');
    assert.strictEqual(f.condizioni.length, 1);
    assert.throws(() => normalizzaFiltro('{non json'), /Filtro non valido/);
  });

  /* --- La resa SQL: il valore resta fuori dal testo --------------------- */

  prova('ogni valore diventa un parametro, mai testo', () => {
    const f = filtro([
      { campo: 'nome', operatore: 'uguale', valore: 'Anna' },
      { campo: 'eta', operatore: 'maggioreUguale', valore: 18 },
    ]);
    const my = rendiSql(f, MYSQL);
    assert.strictEqual(my.sql, '`nome` = ? AND `eta` >= ?');
    assert.deepStrictEqual(my.params, ['Anna', 18]);
    // Nessun valore nel testo: è la proprietà, non un dettaglio.
    assert.ok(!my.sql.includes('Anna'), 'il valore non deve comparire nella clausola');
  });

  prova('PostgreSQL numera i segnaposto, e il numero è la posizione reale', () => {
    const f = filtro([
      { campo: 'a', operatore: 'uguale', valore: 1 },
      { campo: 'b', operatore: 'uguale', valore: 2 },
    ]);
    assert.strictEqual(rendiSql(f, PG).sql, '"a" = $1 AND "b" = $2');
    // Quando la clausola non è la prima cosa parametrizzata della query, il
    // primo numero non è 1. Sbagliarlo farebbe leggere il limite al posto del
    // filtro — in silenzio, con un risultato plausibile.
    assert.strictEqual(rendiSql(f, PG, 5).sql, '"a" = $5 AND "b" = $6');
  });

  prova('IN produce un segnaposto per valore, non una lista interpolata', () => {
    const f = filtro([{ campo: 'stato', operatore: 'dentro', valore: ['a', 'b', 'c'] }]);
    const my = rendiSql(f, MYSQL);
    assert.strictEqual(my.sql, '`stato` IN (?, ?, ?)');
    assert.deepStrictEqual(my.params, ['a', 'b', 'c']);
    assert.strictEqual(rendiSql(f, PG).sql, '"stato" IN ($1, $2, $3)');
  });

  prova('vuoto e nonVuoto non hanno parametri: NULL non è un valore', () => {
    // `= NULL` non è mai vero: dev'essere `IS NULL`, e non c'è nulla da
    // parametrizzare.
    const f = filtro([{ campo: 'a', operatore: 'vuoto' }, { campo: 'b', operatore: 'nonVuoto' }]);
    const my = rendiSql(f, MYSQL);
    assert.strictEqual(my.sql, '`a` IS NULL AND `b` IS NOT NULL');
    assert.deepStrictEqual(my.params, []);
  });

  prova('la ricerca testuale neutralizza i metacaratteri di LIKE', () => {
    // Chi cerca "50%" cerca la stringa "50%", non "tutto ciò che inizia per 50".
    const f = filtro([{ campo: 'a', operatore: 'contiene', valore: '50%_x' }]);
    const my = rendiSql(f, MYSQL);
    // Nessuna clausola ESCAPE: la barra rovesciata è già il carattere di escape
    // predefinito su entrambi i motori, e su MySQL scriverla darebbe una
    // stringa non terminata.
    assert.strictEqual(my.sql, '`a` LIKE ?');
    assert.deepStrictEqual(my.params, ['%50\\%\\_x%']);
  });

  prova('iniziaCon e finisceCon mettono il jolly da una parte sola', () => {
    const inizia = rendiSql(filtro([{ campo: 'a', operatore: 'iniziaCon', valore: 'ab' }]), MYSQL);
    const finisce = rendiSql(filtro([{ campo: 'a', operatore: 'finisceCon', valore: 'ab' }]), MYSQL);
    assert.deepStrictEqual(inizia.params, ['ab%']);
    assert.deepStrictEqual(finisce.params, ['%ab']);
  });

  prova("l'unione «o» si vede nella clausola", () => {
    const f = filtro([
      { campo: 'a', operatore: 'uguale', valore: 1 },
      { campo: 'b', operatore: 'uguale', valore: 2 },
    ], 'o');
    assert.strictEqual(rendiSql(f, MYSQL).sql, '`a` = ? OR `b` = ?');
  });

  prova('un dialetto incompleto è un errore subito', () => {
    const f = filtro([{ campo: 'a', operatore: 'uguale', valore: 1 }]);
    assert.throws(() => rendiSql(f, { qid: MYSQL.qid }), /Dialetto del filtro incompleto/);
  });

  /* --- La resa MongoDB --------------------------------------------------- */

  prova('MongoDB: il valore resta in posizione di VALORE, mai di operatore', () => {
    // Un valore che somigli a `{ $ne: null }` deve restare un oggetto
    // confrontato per uguaglianza, non diventare un operatore. È l'equivalente
    // documentale del parametro.
    const f = filtro([{ campo: 'a', operatore: 'uguale', valore: { $ne: null } }]);
    const reso = rendiMongo(f);
    assert.deepStrictEqual(reso, { a: { $eq: { $ne: null } } });
  });

  prova('MongoDB: una condizione sola non si avvolge in $and', () => {
    assert.deepStrictEqual(
      rendiMongo(filtro([{ campo: 'a', operatore: 'maggiore', valore: 3 }])),
      { a: { $gt: 3 } }
    );
  });

  prova('MongoDB: più condizioni diventano $and, l\'unione «o» diventa $or', () => {
    const c = [{ campo: 'a', operatore: 'uguale', valore: 1 }, { campo: 'b', operatore: 'uguale', valore: 2 }];
    assert.deepStrictEqual(rendiMongo(filtro(c)), { $and: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }] });
    assert.deepStrictEqual(rendiMongo(filtro(c, 'o')), { $or: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }] });
  });

  prova('MongoDB: vuoto e nonVuoto, dentro, e la ricerca testuale', () => {
    assert.deepStrictEqual(rendiMongo(filtro([{ campo: 'a', operatore: 'vuoto' }])), { a: null });
    assert.deepStrictEqual(rendiMongo(filtro([{ campo: 'a', operatore: 'nonVuoto' }])), { a: { $ne: null } });
    assert.deepStrictEqual(
      rendiMongo(filtro([{ campo: 'a', operatore: 'dentro', valore: [1, 2] }])),
      { a: { $in: [1, 2] } }
    );
  });

  prova('MongoDB: la ricerca testuale neutralizza i metacaratteri di regex', () => {
    // Senza, chi cerca "S.p.A." otterrebbe un'espressione in cui il punto vale
    // "qualsiasi carattere", e una parentesi aperta farebbe FALLIRE la query
    // invece di cercare una parentesi.
    const reso = rendiMongo(filtro([{ campo: 'a', operatore: 'contiene', valore: 'S.p.A. (x)' }]));
    assert.strictEqual(reso.a.$regex, 'S\\.p\\.A\\. \\(x\\)');
  });

  prova('MongoDB: nessun filtro è il documento vuoto', () => {
    assert.deepStrictEqual(rendiMongo(null), {});
  });

  /* --- Il valore ostile non altera la struttura ------------------------- */

  const OSTILI = [
    "a' OR 1=1 --",
    "'; DROP TABLE utenti; --",
    '1 UNION SELECT password FROM utenti',
    '\\',
    '%',
    "') OR ('1'='1",
  ];

  prova('SQL: nessun valore ostile cambia la struttura della clausola', () => {
    // La clausola prodotta è SEMPRE la stessa, qualunque sia il valore: cambia
    // solo il parametro. È la proprietà che rende inutile un elenco di
    // caratteri vietati.
    const attesaMy = '`nome` = ?';
    const attesaPg = '"nome" = $1';
    for (const ostile of OSTILI) {
      const f = filtro([{ campo: 'nome', operatore: 'uguale', valore: ostile }]);
      const my = rendiSql(f, MYSQL);
      const pg = rendiSql(f, PG);
      assert.strictEqual(my.sql, attesaMy, `MySQL alterato da: ${ostile}`);
      assert.strictEqual(pg.sql, attesaPg, `PostgreSQL alterato da: ${ostile}`);
      assert.deepStrictEqual(my.params, [ostile], 'il valore deve arrivare intatto come parametro');
      assert.deepStrictEqual(pg.params, [ostile]);
    }
  });

  prova('MongoDB: nessun valore ostile diventa un operatore', () => {
    for (const ostile of [{ $where: 'sleep(1)' }, { $ne: null }, ['$gt', 0]]) {
      const reso = rendiMongo(filtro([{ campo: 'nome', operatore: 'uguale', valore: ostile }]));
      assert.deepStrictEqual(Object.keys(reso), ['nome'], 'la struttura deve restare { campo: … }');
      assert.deepStrictEqual(reso.nome, { $eq: ostile }, 'il valore resta un valore');
    }
  });

  prova('un nome di campo ostile viene QUOTATO, non interpolato', () => {
    // Il campo non è parametrizzabile in SQL: è un identificatore. La difesa è
    // la quotatura, la stessa regola unica del repo — più il rifiuto dei
    // caratteri di controllo, verificato sopra.
    const f = filtro([{ campo: 'a` OR 1=1 --', operatore: 'vuoto' }]);
    const my = rendiSql(f, { qid: (n) => `\`${String(n).split('`').join('``')}\``, segnaposto: () => '?' });
    assert.strictEqual(my.sql, '`a`` OR 1=1 --` IS NULL');
  });

  /* --- I dialetti VERI degli adattatori --------------------------------- */

  prova('gli adattatori veri rendono il filtro con il proprio dialetto', () => {
    // Non due dialetti finti scritti qui: quelli che i due motori dichiarano.
    const f = { condizioni: [{ campo: 'nome', operatore: 'contiene', valore: "a' OR 1=1" }] };
    const my = DbFactory.getStrategy('mysql').buildSelect('d', 't', { filtro: f });
    const pg = DbFactory.getStrategy('postgresql').buildSelect('d', 't', { filtro: f });
    // Su PostgreSQL la colonna viene confrontata COME TESTO: `intero LIKE
    // testo` non esiste come operatore e la query fallirebbe invece di non
    // trovare nulla, il che renderebbe inutilizzabile la ricerca rapida su una
    // colonna qualunque. Su MySQL la conversione è implicita e un CAST
    // esplicito sposterebbe la collation del confronto.
    assert.strictEqual(my.whereSql, ' WHERE `nome` LIKE ?');
    assert.strictEqual(pg.whereSql, ' WHERE "nome"::text LIKE $1');
    assert.deepStrictEqual(my.whereParams, ["%a' OR 1=1%"]);
    assert.deepStrictEqual(pg.whereParams, ["%a' OR 1=1%"]);
  });

  prova('il filtro TESTUALE continua a funzionare come prima', () => {
    // Il ticket espande soltanto: nessun chiamante è migrato, e chi manda il
    // frammento grezzo deve vedere esattamente ciò che vedeva.
    const my = DbFactory.getStrategy('mysql').buildSelect('d', 't', { filter: 'q > 1' });
    assert.strictEqual(my.whereSql, ' WHERE q > 1', 'il frammento resta scritto com\'è');
    assert.deepStrictEqual(my.whereParams, []);
  });

  prova('i due filtri convivono, uniti da AND e con le parentesi', () => {
    // È la condizione che permette di migrare un chiamante per volta.
    const my = DbFactory.getStrategy('mysql').buildSelect('d', 't', {
      filter: 'q > 1',
      filtro: { condizioni: [{ campo: 'nome', operatore: 'uguale', valore: 'Anna' }] },
    });
    assert.strictEqual(my.whereSql, ' WHERE (q > 1) AND (`nome` = ?)');
    assert.deepStrictEqual(my.whereParams, ['Anna']);
  });

  if (falliti) throw new Error(`${falliti} test del filtro strutturato falliti`);
  console.log('  Filtro strutturato: il valore non attraversa mai il testo della query.');
})();

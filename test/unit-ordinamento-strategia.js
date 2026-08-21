'use strict';

/* ---------------------------------------------------------------------------
 * L'ordinamento passa dalla strategia, su TUTTI i percorsi.
 *
 * L'idioma di questo strato è: la classe base propone, il motore corregge —
 * lo fanno già la rinomina nativa, il DDL ausiliario, l'osservazione dei
 * cambiamenti. Per l'ordinamento il punto di estensione c'era ma veniva
 * **saltato**: `componiSelezione` chiamava la funzione comune direttamente,
 * quindi sovrascrivere `buildOrderBy` si faceva sentire dalla tab ⚡ e veniva
 * ignorato in silenzio dalla griglia. Due ordinamenti diversi nello stesso
 * motore a seconda della strada, senza alcun errore: è la divergenza
 * silenziosa che il modulo comune doveva eliminare, riapparsa fra due funzioni
 * invece che fra due file.
 *
 * Un test di comportamento «l'ordinamento è giusto» non se ne accorgerebbe: i
 * due percorsi danno lo stesso risultato finché nessuno sovrascrive niente. Il
 * modo di vederlo è **sovrascrivere davvero** e controllare che tutti i
 * percorsi cambino.
 *
 * Nessun database: al posto del pool si mette un oggetto che registra la query
 * ricevuta, come in `unit-sql-metadati.js`.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');

let falliti = 0;
async function prova(nome, fn) {
  try {
    await fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err.message}`);
  }
}

/**
 * Pool finto: registra ogni query e risponde con righe decise dal test.
 *
 * PostgreSQL prende una connessione dedicata quando c'e' un tetto di tempo (e
 * ce n'e' sempre uno), quindi il finto deve saper fare anche `connect()`.
 */
function pooleFinto(strategia, risposta) {
  const viste = [];
  const esegui = async (sql, params) => {
    const testo = typeof sql === 'string' ? sql : sql.sql;
    viste.push({ sql: testo, params });
    // Il conteggio destruttura `[[{ total }]]`: senza una riga il find morirebbe
    // su un errore che non c'entra con cio' che si sta provando.
    if (/COUNT\(\*\)/i.test(testo)) return [{ total: 0 }];
    return risposta(testo, params) || [];
  };
  if (strategia.type === 'mysql') {
    strategia.pool = { query: async (sql, params) => [await esegui(sql, params), []] };
  } else {
    const client = {
      query: async (sql, params) => ({ rows: await esegui(sql, params), fields: [] }),
      release: () => {},
    };
    strategia.pool = {
      query: async (sql, params) => ({ rows: await esegui(sql, params), fields: [] }),
      connect: async () => client,
    };
  }
  return viste;
}

/** Le righe di catalogo che i due motori restituiscono per le colonne. */
function catalogoColonne(motore) {
  return motore === 'mysql'
    ? [
      { name: 'id', type: 'int', srid: null, extra: '', nullable: 'NO' },
      { name: 'nome', type: 'varchar', srid: null, extra: '', nullable: 'YES' },
    ]
    : [
      { name: 'id', type: 'int4', nullable: 'NO' },
      { name: 'nome', type: 'varchar', nullable: 'YES' },
    ];
}

module.exports = (async () => {
  console.log('  --- Ordinamento: il punto di estensione della strategia ---');

  /* --- Il punto di estensione è efficace su tutti i percorsi ------------ */

  await prova('sovrascrivere buildOrderBy si sente anche in buildSelect', () => {
    // È il difetto: `buildSelect` chiamava la funzione comune, non il metodo.
    for (const Classe of [MySqlStrategy, PostgreSqlStrategy]) {
      class MotoreParticolare extends Classe {
        buildOrderBy(text) { return ' ORDER BY qualcosa_di_mio'; }
      }
      const s = new MotoreParticolare();
      assert.strictEqual(
        s.buildSelect('d', 't', { sort: '{"nome":1}' }).orderSql,
        ' ORDER BY qualcosa_di_mio',
        `${Classe.name}: la griglia deve ascoltare la sovrascrittura`
      );
      // E il metodo diretto, che era l'unico percorso già corretto.
      assert.strictEqual(s.buildOrderBy('{"nome":1}'), ' ORDER BY qualcosa_di_mio');
    }
  });

  await prova('senza sovrascrittura la SQL prodotta è quella di prima', () => {
    const my = new MySqlStrategy();
    const pg = new PostgreSqlStrategy();
    assert.strictEqual(my.buildSelect('d', 't', { sort: '{"a":1}' }).orderSql, ' ORDER BY `a` ASC');
    // Su PostgreSQL il suffisso che allinea i nulli fa parte di «quella di
    // prima» a partire dal ticket 27: la regola è provata più sotto.
    assert.strictEqual(
      pg.buildSelect('d', 't', { sort: '{"a":-1}' }).orderSql, ' ORDER BY "a" DESC NULLS LAST'
    );
    assert.strictEqual(my.buildSelect('d', 't', { sort: 'a ASC' }).orderSql, ' ORDER BY a ASC');
    assert.strictEqual(my.buildSelect('d', 't', {}).orderSql, '', 'senza sort nessun ORDER BY');
    assert.strictEqual(my.buildSelect('d', 't', { sort: '{}' }).orderSql, '', 'JSON vuoto: nessuna clausola');
  });

  /* --- La griglia: la query VERA porta l'ordinamento sovrascritto ------- */

  for (const [nome, Classe, motore] of [
    ['MySQL', MySqlStrategy, 'mysql'],
    ['PostgreSQL', PostgreSqlStrategy, 'postgresql'],
  ]) {
    await prova(`${nome}: collectionFind manda al server l'ordinamento della STRATEGIA`, async () => {
      const visti = [];
      class MotoreParticolare extends Classe {
        buildOrderBy(text, opzioni) {
          visti.push(opzioni);
          return ' ORDER BY marcatore_del_test';
        }
      }
      const s = new MotoreParticolare();
      const viste = pooleFinto(s, (sql) => {
        if (/information_schema\.?columns/i.test(sql) || /information_schema\.COLUMNS/.test(sql)) {
          return catalogoColonne(motore);
        }
        return [];
      });

      await s.collectionFind('appdb', 'utenti', { sort: '{"nome":1}', limit: 10 });

      const query = viste.map((v) => v.sql).find((sql) => /SELECT .* FROM /i.test(sql) && /ORDER BY/i.test(sql));
      assert.ok(query, `nessuna SELECT con ORDER BY fra le query viste:\n${viste.map((v) => v.sql).join('\n')}`);
      assert.ok(
        query.includes('ORDER BY marcatore_del_test'),
        `la griglia ha ignorato la sovrascrittura:\n${query}`
      );
    });

    await prova(`${nome}: chi compone l'ordinamento riceve le colonne, con la nullabilità`, async () => {
      // Il ticket 27 ha bisogno esattamente di questo, e l'ordinamento veniva
      // composto PRIMA che la lettura dei metadati fosse partita.
      let ricevute = null;
      class MotoreCurioso extends Classe {
        buildOrderBy(text, opzioni) {
          ricevute = opzioni && opzioni.colonne;
          return super.buildOrderBy(text, opzioni);
        }
      }
      const s = new MotoreCurioso();
      pooleFinto(s, (sql) => (/information_schema/i.test(sql) ? catalogoColonne(motore) : []));

      await s.collectionFind('appdb', 'utenti', { sort: '{"nome":1}' });

      assert.ok(Array.isArray(ricevute), 'le colonne devono arrivare a buildOrderBy');
      const nome_ = ricevute.find((c) => c.name === 'nome');
      const id = ricevute.find((c) => c.name === 'id');
      assert.strictEqual(nome_.nullable, true, '`nome` ammette NULL');
      assert.strictEqual(id.nullable, false, '`id` non lo ammette');
    });

    await prova(`${nome}: la nullabilità non costa una lettura di catalogo in più`, async () => {
      const s = new Classe();
      const viste = pooleFinto(s, (sql) => (/information_schema/i.test(sql) ? catalogoColonne(motore) : []));
      await s.collectionFind('appdb', 'utenti', { sort: '{"nome":1}' });
      const letture = viste.filter((v) => /information_schema/i.test(v.sql));
      // Una sola lettura del catalogo delle COLONNE. La chiave primaria è
      // un'altra query, su un'altra vista (KEY_COLUMN_USAGE), e non c'entra.
      const colonne = letture.filter((v) => /information_schema\.columns/i.test(v.sql));
      assert.strictEqual(colonne.length, 1,
        `attesa una sola lettura delle colonne, viste ${colonne.length}:\n${colonne.map((v) => v.sql).join('\n---\n')}`);
    });
  }

  /* --- La regola dei valori nulli --------------------------------------- */

  const colonne = [
    { name: 'nome', type: 'varchar', nullable: true },
    { name: 'id', type: 'int', nullable: false },
  ];

  await prova("PostgreSQL scrive il suffisso: il nullo è il più piccolo", () => {
    const pg = new PostgreSqlStrategy();
    // In salita i nulli in cima, in discesa in fondo: e' la stessa regola letta
    // nei due versi, non due regole.
    assert.strictEqual(pg.buildOrderBy('{"nome":1}', { colonne }), ' ORDER BY "nome" ASC NULLS FIRST');
    assert.strictEqual(pg.buildOrderBy('{"nome":-1}', { colonne }), ' ORDER BY "nome" DESC NULLS LAST');
  });

  await prova("MySQL non scrive niente: il suo predefinito già coincide", () => {
    // E non ha nemmeno la sintassi NULLS FIRST/LAST. Che la coincidenza regga
    // va provato contro un MySQL vero: test/e2e-nulli-ordinati.js.
    const my = new MySqlStrategy();
    assert.strictEqual(my.buildOrderBy('{"nome":1}', { colonne }), ' ORDER BY `nome` ASC');
    assert.strictEqual(my.buildOrderBy('{"nome":-1}', { colonne }), ' ORDER BY `nome` DESC');
  });

  await prova("colonna NOT NULL: nessun suffisso, l'indice resta utilizzabile", () => {
    // Non e' solo inutile: su PostgreSQL un NULLS FIRST esplicito su una
    // colonna NOT NULL con indice produce comunque Seq Scan + Sort, perché il
    // planner non riconosce che e' un'operazione nulla. L'omissione deve farla
    // CodeDB. Ed e' dove si recupera quasi tutto, perche' si ordina soprattutto
    // per chiavi e identificatori.
    const pg = new PostgreSqlStrategy();
    assert.strictEqual(pg.buildOrderBy('{"id":1}', { colonne }), ' ORDER BY "id" ASC');
    assert.strictEqual(pg.buildOrderBy('{"id":-1}', { colonne }), ' ORDER BY "id" DESC');
  });

  await prova("nullabilità sconosciuta: il suffisso si mette", () => {
    // Sbagliare l'ordine e' un difetto visibile su tutte le righe vuote;
    // sbagliare il piano e' lento. Nel dubbio si sceglie il difetto che non c'e'.
    const pg = new PostgreSqlStrategy();
    assert.strictEqual(pg.buildOrderBy('{"boh":1}', { colonne }), ' ORDER BY "boh" ASC NULLS FIRST');
    assert.strictEqual(pg.buildOrderBy('{"boh":1}'), ' ORDER BY "boh" ASC NULLS FIRST');
  });

  await prova("più colonne: la regola vale per ognuna, secondo la SUA nullabilità", () => {
    const pg = new PostgreSqlStrategy();
    assert.strictEqual(
      pg.buildOrderBy('{"id":1,"nome":-1}', { colonne }),
      ' ORDER BY "id" ASC, "nome" DESC NULLS LAST'
    );
  });

  await prova("l'SQL scritto a mano non viene MAI riscritto", () => {
    // Confine dichiarato: se l'utente ordina a mano, comanda lui — suffisso
    // compreso, anche quando e' l'opposto della regola di CodeDB.
    const pg = new PostgreSqlStrategy();
    assert.strictEqual(pg.buildOrderBy('nome ASC', { colonne }), ' ORDER BY nome ASC');
    assert.strictEqual(
      pg.buildOrderBy('nome ASC NULLS LAST', { colonne }), ' ORDER BY nome ASC NULLS LAST'
    );
    assert.strictEqual(pg.buildOrderBy('nome DESC, id ASC', { colonne }), ' ORDER BY nome DESC, id ASC');
  });

  await prova('la regola arriva fino alla query VERA della griglia', async () => {
    const s = new PostgreSqlStrategy();
    const viste = pooleFinto(s, (sql) => (/information_schema/i.test(sql) ? catalogoColonne('postgresql') : []));
    await s.collectionFind('appdb', 'utenti', { sort: '{"nome":1}' });
    const query = viste.map((v) => v.sql).find((sql) => /SELECT .* FROM /i.test(sql) && /ORDER BY/i.test(sql));
    assert.ok(query, 'nessuna SELECT con ORDER BY');
    assert.ok(query.includes('NULLS FIRST'), `il suffisso non e' arrivato al server:
${query}`);
  });

  await prova('sulla chiave primaria la griglia non paga niente', async () => {
    // `id` e' NOT NULL: nessun suffisso, quindi l'indice resta utilizzabile
    // proprio nel caso piu' frequente.
    const s = new PostgreSqlStrategy();
    const viste = pooleFinto(s, (sql) => (/information_schema/i.test(sql) ? catalogoColonne('postgresql') : []));
    await s.collectionFind('appdb', 'utenti', { sort: '{"id":1}' });
    const query = viste.map((v) => v.sql).find((sql) => /SELECT .* FROM /i.test(sql) && /ORDER BY/i.test(sql));
    assert.ok(query && !/NULLS/i.test(query), `suffisso di troppo su una colonna NOT NULL:
${query}`);
  });

  /* --- Il ripiego su OFFSET e la paginazione a chiave -------------------- */

  await prova('keyset: con ordinamento di default si pagina per chiave, non per salto', () => {
    for (const Classe of [MySqlStrategy, PostgreSqlStrategy]) {
      const s = new Classe();
      const ks = s.buildKeyset({ keyset: { after: '10' }, sort: '' }, '`t`', '', 50, ['id'], '*');
      assert.ok(ks && ks.sql, `${Classe.name}: la pagina a chiave deve essere possibile`);
      assert.ok(/ORDER BY/i.test(ks.sql), 'la pagina a chiave ordina per la chiave');
    }
  });

  await prova('keyset: con un ordinamento scelto dall\'utente si ripiega su OFFSET', () => {
    for (const Classe of [MySqlStrategy, PostgreSqlStrategy]) {
      const s = new Classe();
      assert.strictEqual(
        s.buildKeyset({ keyset: { after: '10' }, sort: '{"nome":1}' }, '`t`', '', 50, ['id'], '*'),
        null,
        `${Classe.name}: ordinamento non di default → nessun keyset`
      );
    }
  });

  if (falliti) throw new Error(`${falliti} test dell'ordinamento falliti`);
  console.log('  Ordinamento: punto di estensione efficace su tutti i percorsi.');
})();

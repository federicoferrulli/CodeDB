'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario di public/js/identificatori.mjs — la regola unica per scrivere
 * il nome di una tabella o di una colonna.
 *
 * Quello che si verifica qui non è "le virgolette compaiono", ma che compaiano
 * **quando servono e solo allora**, e che il carattere di quotatura dentro il
 * nome venga raddoppiato. Sono i due modi di rompere una query con un nome
 * legittimo: su PostgreSQL un nome con maiuscole scritto nudo viene abbassato
 * dal motore e la tabella non si trova; un apice non raddoppiato chiude
 * l'identificatore a metà e ciò che segue diventa sintassi.
 *
 * Il modulo si raggiunge da tutte e due le parti, e il test le prova entrambe:
 * come modulo ES (la via del browser) e attraverso il ponte CommonJS
 * `db/identificatori.js` (la via del server).
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let falliti = 0;
async function provaAsync(nome, fn) {
  try {
    await fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err.message}`);
  }
}

function prova(nome, fn) {
  try {
    fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err.message}`);
  }
}

module.exports = (async () => {
  const ponte = require('../db/identificatori');
  const {
    quotaIdentificatore, quotaSempre, quotaQualificato, serveQuoting,
    dialettoDi, smarca, ultimoSegmento, APICE,
  } = ponte;

  console.log('--- Test unitari: regola unica degli identificatori ---');

  /* --- Le tre famiglie di motore ---------------------------------------- */

  prova('le tre famiglie e i loro alias', () => {
    assert.strictEqual(dialettoDi('mysql'), 'mysql');
    assert.strictEqual(dialettoDi('mariadb'), 'mysql');
    assert.strictEqual(dialettoDi('postgres'), 'postgresql');
    assert.strictEqual(dialettoDi('pg'), 'postgresql');
    assert.strictEqual(dialettoDi('PostgreSQL'), 'postgresql');
    assert.strictEqual(dialettoDi('mongo'), 'mongodb');
    assert.strictEqual(dialettoDi('oracle'), '', 'un motore che CodeDB non conosce non ha dialetto');
  });

  prova('su MongoDB il delimitatore è il backtick, non il doppio apice', () => {
    // In SQL→MQL le "…" sono una STRINGA: quotare così darebbe un testo, non
    // una collezione.
    assert.strictEqual(APICE.mongodb, '`');
  });

  /* --- Se quotare: il caso che rompe le query --------------------------- */

  prova('PostgreSQL: una sola maiuscola basta a richiedere le virgolette', () => {
    assert.strictEqual(serveQuoting('Prova', 'postgresql'), true);
    assert.strictEqual(serveQuoting('prova', 'postgresql'), false);
    assert.strictEqual(quotaIdentificatore('Prova', 'postgresql'), '"Prova"');
    assert.strictEqual(quotaIdentificatore('prova', 'postgresql'), 'prova');
  });

  prova('MySQL e MongoDB non abbassano niente: le maiuscole passano nude', () => {
    assert.strictEqual(quotaIdentificatore('Prova', 'mysql'), 'Prova');
    assert.strictEqual(quotaIdentificatore('Prova', 'mongodb'), 'Prova');
  });

  prova('spazi, trattini e parole chiave richiedono le virgolette ovunque', () => {
    assert.strictEqual(quotaIdentificatore('due parole', 'mysql'), '`due parole`');
    assert.strictEqual(quotaIdentificatore('due parole', 'postgresql'), '"due parole"');
    assert.strictEqual(quotaIdentificatore('mia-collezione', 'mongodb'), '`mia-collezione`');
    assert.strictEqual(quotaIdentificatore('order', 'mysql'), '`order`', 'parola riservata');
    assert.strictEqual(quotaIdentificatore('order', 'postgresql'), '"order"', 'parola riservata');
  });

  prova('motore sconosciuto: non si tocca niente', () => {
    // Inventare virgolette per un motore che non si conosce romperebbe una
    // query che funzionava.
    assert.strictEqual(quotaIdentificatore('Prova', 'oracle'), 'Prova');
    assert.strictEqual(quotaIdentificatore('Prova', ''), 'Prova');
  });

  /* --- Come quotare: il raddoppio --------------------------------------- */

  prova('il carattere di quotatura dentro il nome viene raddoppiato', () => {
    assert.strictEqual(quotaSempre('vir"gola', 'postgresql'), '"vir""gola"');
    assert.strictEqual(quotaSempre('back`tick', 'mysql'), '`back``tick`');
    assert.strictEqual(quotaSempre('back`tick', 'mongodb'), '`back``tick`');
    // Il delimitatore dell'ALTRO motore non è speciale: non va toccato.
    assert.strictEqual(quotaSempre('vir"gola', 'mysql'), '`vir"gola`');
    assert.strictEqual(quotaSempre('back`tick', 'postgresql'), '"back`tick"');
  });

  prova('due caratteri di quotatura di fila si raddoppiano entrambi', () => {
    assert.strictEqual(quotaSempre('a""b', 'postgresql'), '"a""""b"');
  });

  prova('anche la via che quota solo se serve raddoppia', () => {
    assert.strictEqual(quotaIdentificatore('vir"gola', 'postgresql'), '"vir""gola"');
    assert.strictEqual(quotaIdentificatore('back`tick', 'mysql'), '`back``tick`');
  });

  /* --- Quota sempre: chi compone SQL che l'utente non legge ------------- */

  prova('quotaSempre non chiede se serve', () => {
    assert.strictEqual(quotaSempre('prova', 'postgresql'), '"prova"');
    assert.strictEqual(quotaSempre('prova', 'mysql'), '`prova`');
  });

  prova('quotaSempre su un motore sconosciuto è un errore, non un tiro a caso', () => {
    // Scegliere un apice a caso darebbe una query valida per il motore
    // sbagliato: è esattamente il difetto silenzioso da togliere.
    assert.throws(() => quotaSempre('prova', 'oracle'), /Motore sconosciuto/);
    assert.throws(() => quotaSempre('prova', ''), /Motore sconosciuto/);
  });

  /* --- Nomi qualificati da uno schema ----------------------------------- */

  prova('nome qualificato: ogni pezzo quotato per conto suo', () => {
    assert.strictEqual(quotaQualificato(['diego', 'Prova'], 'postgresql'), '"diego"."Prova"');
    assert.strictEqual(quotaQualificato(['app', 'utenti'], 'mysql'), '`app`.`utenti`');
  });

  prova('nome qualificato: il pezzo mancante si salta, non lascia un punto', () => {
    assert.strictEqual(quotaQualificato([null, 'Prova'], 'postgresql'), '"Prova"');
    assert.strictEqual(quotaQualificato(['', 'utenti'], 'mysql'), '`utenti`');
    assert.strictEqual(quotaQualificato('utenti', 'mysql'), '`utenti`');
  });

  prova('nome qualificato: un punto DENTRO un pezzo resta dentro il pezzo', () => {
    // Altrimenti `mia.tabella` diventerebbe due oggetti invece di uno.
    assert.strictEqual(quotaQualificato(['mia.tabella'], 'mysql'), '`mia.tabella`');
  });

  prova('nome qualificato: la via che quota solo se serve si può chiedere', () => {
    assert.strictEqual(
      quotaQualificato(['diego', 'Prova'], 'postgresql', { sempre: false }),
      'diego."Prova"'
    );
  });

  /* --- Riconoscere le virgolette già messe ------------------------------ */

  prova('smarca e ultimoSegmento leggono le tre forme di quotatura', () => {
    assert.strictEqual(smarca('`prova`'), 'prova');
    assert.strictEqual(smarca('"Prova"'), 'Prova');
    assert.strictEqual(smarca('[prova]'), 'prova');
    assert.strictEqual(ultimoSegmento('schema."Prova"'), 'Prova');
    assert.strictEqual(ultimoSegmento('utenti'), 'utenti');
  });

  /* --- Le due vie portano allo stesso modulo ---------------------------- */

  const viaBrowser = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'identificatori.mjs')).href
  );

  prova('il ponte CommonJS e la via ES danno lo stesso modulo', () => {
    assert.strictEqual(viaBrowser.quotaIdentificatore, ponte.quotaIdentificatore);
    assert.strictEqual(viaBrowser.quotaSempre, ponte.quotaSempre);
  });

  const viaDialetti = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'sql-dialetti.js')).href
  );

  prova('il vocabolario dei dialetti ri-esporta la stessa funzione, non una copia', () => {
    assert.strictEqual(viaDialetti.quotaIdentificatore, ponte.quotaIdentificatore);
    assert.strictEqual(viaDialetti.serveQuoting, ponte.serveQuoting);
  });

  /* --- I chiamanti, non solo il modulo ---------------------------------
   *
   * Il nome con maiuscole su PostgreSQL è il caso che rompe le query, e va
   * visto arrivare fino in fondo attraverso chiamanti diversi: che il modulo
   * risponda bene non dice ancora che qualcuno lo stia usando.
   * -------------------------------------------------------------------- */

  const MySqlStrategy = require('../db/MySqlStrategy');
  const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
  const pgDdl = require('../db/pg-ddl');
  const VirtualJoinEngine = require('../db/VirtualJoinEngine');

  prova('chiamante 1 — l\'adattatore PostgreSQL qualifica e quota `Prova`', () => {
    const s = new PostgreSqlStrategy();
    const { table } = s.buildSelect('diego', 'Prova', {});
    assert.strictEqual(table, '"diego"."Prova"');
  });

  prova('chiamante 2 — il DDL di PostgreSQL scrive lo stesso nome', () => {
    assert.strictEqual(pgDdl.qid('Prova'), '"Prova"');
    assert.strictEqual(pgDdl.qid('vir"gola'), '"vir""gola"');
  });

  await provaAsync('chiamante 3 — i JOIN virtuali leggono da "Prova", non da prova', async () => {
    const viste = [];
    const finta = (type) => ({
      type,
      collectionAggregate: async (db, coll, { pipeline }) => {
        viste.push(String(pipeline));
        return { docs: [] };
      },
    });
    await VirtualJoinEngine.execute(
      {
        virtualJoin: {
          sourceA: { db: 'diego', table: 'Prova', dbType: 'postgresql' },
          sourceB: { db: 'diego', table: 'Altra', dbType: 'postgresql' },
          on: { leftKey: 'id', rightKey: 'Prova_id' },
        },
      },
      finta('postgresql'), finta('postgresql')
    );
    assert.ok(viste.length, 'nessuna query composta');
    assert.ok(viste[0].includes('"Prova"'), `atteso "Prova" quotato, trovato: ${viste[0]}`);
  });

  prova('chiamante 4 — l\'adattatore MySQL usa il backtick, non il doppio apice', () => {
    const s = new MySqlStrategy();
    const { table } = s.buildSelect('app', 'Prova', {});
    assert.strictEqual(table, '`app`.`Prova`');
  });

  /* --- Che nessuna copia risorga ----------------------------------------
   *
   * Le sette copie sono sparite migrandole; questo controllo esiste perché non
   * ne ricompaia un'ottava. Legge il repo come TESTO: nessun controllo di tipo
   * vedrebbe un `'"' + nome + '"'` scritto a mano dentro una funzione nuova.
   *
   * Che cosa NON garantisce, dichiarato: riconosce le forme che le copie
   * avevano davvero (raddoppio del backtick, `escapeId` del driver, il
   * `split(apice).join(apice+apice)` della selezione di celle). Una copia
   * scritta in una forma nuova — `nome.replaceAll`, una concatenazione in due
   * passi — gli sfugge. È un argine, non una dimostrazione.
   * -------------------------------------------------------------------- */

  const fs = require('fs');
  const radice = path.join(__dirname, '..');

  function fileDaLeggere(dir) {
    const fuori = new Set(['node_modules', 'lib', 'dist', 'build', '.git', 'test-reports']);
    const out = [];
    (function scendi(d) {
      for (const voce of fs.readdirSync(d, { withFileTypes: true })) {
        if (voce.isDirectory()) {
          if (!fuori.has(voce.name)) scendi(path.join(d, voce.name));
        } else if (voce.name.endsWith('.js') || voce.name.endsWith('.mjs')) {
          out.push(path.join(d, voce.name));
        }
      }
    })(dir);
    return out;
  }

  // Il raddoppio del doppio apice serve anche al CSV, dove la regola è un'altra
  // (RFC 4180) e non c'entra con gli identificatori. Queste sono le tre
  // occorrenze CSV note: se ne compare una quarta, va guardata prima di essere
  // aggiunta qui.
  const CSV_NOTI = [
    "/[\",\\r\\n]/.test(s) ? `\"${s.replace(/\"/g, '\"\"')}\"` : s",
    "/[\",\\n]/.test(s) ? '\"' + s.replace(/\"/g, '\"\"') + '\"' : s",
    "return `\"${strVal.replace(/\"/g, '\"\"')}\"`;",
  ];

  prova('nessuna copia della regola sopravvive nel repo', () => {
    const forme = [
      ['raddoppio del backtick a mano', /replace\(\/`\/g, *'``'\)/],
      ['escapeId del driver MySQL', /mysql\.escapeId\(/],
      ['split/join sul carattere di quotatura', /\.split\(quote\)\.join\(/],
    ];
    const colpevoli = [];
    const file = ['db', 'backup', 'mcp', 'auth', 'public/js']
      .flatMap((d) => fileDaLeggere(path.join(radice, d)))
      .concat([path.join(radice, 'server.js')]);

    for (const f of file) {
      if (path.basename(f) === 'identificatori.mjs') continue; // è la regola
      const testo = fs.readFileSync(f, 'utf8');
      for (const [nome, re] of forme) {
        if (re.test(testo)) colpevoli.push(`${path.relative(radice, f)}: ${nome}`);
      }
      // Raddoppio del doppio apice: colpevole solo se non è una delle forme CSV note.
      let residuo = testo;
      for (const noto of CSV_NOTI) residuo = residuo.split(noto).join('');
      if (/replace\(\/"\/g, *'""'\)/.test(residuo)) {
        colpevoli.push(`${path.relative(radice, f)}: raddoppio del doppio apice a mano`);
      }
    }
    assert.deepStrictEqual(colpevoli, [], `copie della regola trovate:\n  ${colpevoli.join('\n  ')}`);
  });

  prova('i sette chiamanti passano dal modulo condiviso', () => {
    const chiamanti = [
      'db/MySqlStrategy.js', 'db/PostgreSqlStrategy.js', 'db/pg-ddl.js',
      'db/VirtualJoinEngine.js', 'backup/lib/engine.js', 'backup/lib/restore.js',
      'public/js/cellselect.js', 'public/js/sql-dialetti.js', 'public/js/query-tab.js',
    ];
    const senza = chiamanti.filter(
      (f) => !/quotaSempre|quotaQualificato|quotaIdentificatore/.test(
        fs.readFileSync(path.join(radice, f), 'utf8')
      )
    );
    assert.deepStrictEqual(senza, [], `chiamanti che non importano la regola: ${senza.join(', ')}`);
  });

  if (falliti) {
    throw new Error(`${falliti} test degli identificatori falliti`);
  }
  console.log('--- Identificatori: tutti i test superati ---');
})();

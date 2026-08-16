'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario di public/js/intellisense.js — completamento consapevole dello
 * schema.
 *
 * Quello che si verifica qui non è "compaiono dei suggerimenti", ma che
 * compaiano **quelli giusti per il punto in cui sta il cursore**: dopo `FROM`
 * tabelle e non colonne, dopo `u.` le colonne di ciò a cui `u` fa da alias e
 * non di un'altra tabella, dopo `db.` collezioni. Un elenco sbagliato è
 * peggio di nessun elenco, perché fa scrivere query che non esistono.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

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

// Il cursore si scrive nel testo di prova come `|`: è molto più leggibile di
// un indice numerico calcolato a mano.
function conCursore(sorgente) {
  const cursore = sorgente.indexOf('|');
  assert.notStrictEqual(cursore, -1, 'il testo di prova deve contenere il segnaposto |');
  return { testo: sorgente.replace('|', ''), cursore };
}

(async () => {
  const url = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'intellisense.js')).href;
  const urlDialetti = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'sql-dialetti.js')).href;
  const {
    dialettoDi, vocabolarioSql, quotaIdentificatore, serveQuoting, ID_SQL, smarca, ultimoSegmento,
  } = await import(urlDialetti);
  const {
    suggerisci, contestoQuery, tabelleCitate, tokenAlCursore, filtraCandidati,
    collezioneAlCursore, applicaSuggerimento, PAROLE_SQL_WHERE, motoreDalTesto,
  } = await import(url);

  console.log('--- Test unitari IntelliSense schema-aware ---');

  const schema = {
    tabelle: [
      { nome: 'utenti', campi: [{ nome: 'id', tipo: 'int' }, { nome: 'nome', tipo: 'varchar' }, { nome: 'email', tipo: 'varchar' }] },
      { nome: 'ordini', campi: [{ nome: 'id', tipo: 'int' }, { nome: 'utente_id', tipo: 'int' }, { nome: 'totale', tipo: 'decimal' }] },
      { nome: 'prodotti', campi: [{ nome: 'id', tipo: 'int' }, { nome: 'titolo', tipo: 'varchar' }] },
    ],
  };
  const testi = (voci) => voci.map((v) => v.testo);

  /* --- Lettura del token ------------------------------------------------ */

  prova('Il token al cursore separa prefisso e qualificatore', () => {
    const { testo, cursore } = conCursore('SELECT u.no| FROM utenti u');
    assert.deepStrictEqual(tokenAlCursore(testo, cursore), {
      prefisso: 'no', qualificatore: 'u', inizio: 9, pos: 11,
    });
  });

  prova('Senza punto non c\'è qualificatore', () => {
    const { testo, cursore } = conCursore('SELECT no|');
    assert.strictEqual(tokenAlCursore(testo, cursore).qualificatore, '');
  });

  /* --- Tabelle citate --------------------------------------------------- */

  prova('Le tabelle citate arrivano con i loro alias', () => {
    const t = tabelleCitate('SELECT * FROM ordini o INNER JOIN utenti AS u ON u.id = o.utente_id');
    assert.deepStrictEqual(t, [{ nome: 'ordini', alias: 'o' }, { nome: 'utenti', alias: 'u' }]);
  });

  prova('Una parola chiave non viene scambiata per un alias', () => {
    assert.deepStrictEqual(tabelleCitate('SELECT * FROM utenti WHERE id = 1'), [{ nome: 'utenti', alias: '' }]);
  });

  prova('Il nome qualificato dallo schema perde il prefisso', () => {
    assert.deepStrictEqual(tabelleCitate('SELECT * FROM public.utenti'), [{ nome: 'utenti', alias: '' }]);
  });

  prova('Un nome quotato e qualificato viene riconosciuto (PostgreSQL)', () => {
    // Prima questa forma non veniva vista affatto: la tabella spariva
    // dall'elenco delle citate e l'alias `p` non portava a nessuna colonna.
    assert.deepStrictEqual(tabelleCitate('SELECT * FROM diego."Prova" p'), [{ nome: 'Prova', alias: 'p' }]);
    assert.deepStrictEqual(tabelleCitate('SELECT * FROM `db`.`Tab` AS t'), [{ nome: 'Tab', alias: 't' }]);
  });

  prova('Le colonne di una tabella quotata si trovano dall\'alias', () => {
    const schemaPg = { tabelle: [{ nome: 'Prova', campi: [{ nome: 'id' }, { nome: 'Valore' }] }] };
    const { testo, cursore } = conCursore('SELECT p.Val| FROM diego."Prova" p');
    const s = suggerisci({ testo, cursore, motore: 'sql', schema: schemaPg, database: 'diego' });
    assert.deepStrictEqual(testi(s), ['Valore']);
  });

  /* --- SQL: contesto ----------------------------------------------------- */

  prova('Dopo FROM servono tabelle', () => {
    const { testo, cursore } = conCursore('SELECT * FROM ute|');
    const ctx = contestoQuery({ testo, cursore, motore: 'sql' });
    assert.strictEqual(ctx.tipo, 'tabella');
    const s = suggerisci({ testo, cursore, motore: 'sql', schema });
    assert.deepStrictEqual(testi(s), ['utenti']);
  });

  prova('Dopo JOIN servono tabelle', () => {
    const { testo, cursore } = conCursore('SELECT * FROM ordini JOIN pro|');
    assert.deepStrictEqual(testi(suggerisci({ testo, cursore, motore: 'sql', schema })), ['prodotti']);
  });

  prova('Dopo un alias servono SOLO le colonne di quella tabella', () => {
    const { testo, cursore } = conCursore('SELECT o.| FROM ordini o JOIN utenti u ON u.id = o.utente_id');
    const s = suggerisci({ testo, cursore, motore: 'sql', schema });
    assert.deepStrictEqual(testi(s), ['id', 'utente_id', 'totale']);
    assert.ok(!testi(s).includes('email'), 'non devono comparire colonne di utenti');
  });

  prova('Il qualificatore può essere il nome della tabella, non solo l\'alias', () => {
    const { testo, cursore } = conCursore('SELECT utenti.em| FROM utenti');
    assert.deepStrictEqual(testi(suggerisci({ testo, cursore, motore: 'sql', schema })), ['email']);
  });

  prova('Un alias sconosciuto non propone le colonne di qualcun altro', () => {
    const { testo, cursore } = conCursore('SELECT x.| FROM utenti u');
    assert.deepStrictEqual(suggerisci({ testo, cursore, motore: 'sql', schema }), []);
  });

  prova('Nella SELECT compaiono le colonne delle tabelle citate', () => {
    const { testo, cursore } = conCursore('SELECT tot| FROM ordini');
    const s = suggerisci({ testo, cursore, motore: 'sql', schema });
    assert.strictEqual(s[0].testo, 'totale');
    assert.strictEqual(s[0].tipo, 'campo');
  });

  prova('Le colonne vengono prima delle parole chiave', () => {
    const { testo, cursore } = conCursore('SELECT * FROM utenti WHERE n|');
    const s = testi(suggerisci({ testo, cursore, motore: 'sql', schema }));
    assert.strictEqual(s[0], 'nome');
    assert.ok(s.includes('NOT'), 'le parole chiave restano disponibili');
    assert.ok(s.indexOf('nome') < s.indexOf('NOT'), s.join(', '));
  });

  prova('Chi comincia col prefisso batte chi lo contiene soltanto', () => {
    const s = testi(filtraCandidati(['utente_id', 'id'], 'i'));
    assert.deepStrictEqual(s, ['id', 'utente_id']);
  });

  prova('Quello che si è già scritto per intero non viene riproposto', () => {
    assert.deepStrictEqual(testi(filtraCandidati(['id', 'utente_id'], 'id')), ['utente_id']);
  });

  prova('Senza schema si ripiega sulle colonne della tabella aperta', () => {
    const { testo, cursore } = conCursore('SELECT * FROM t WHERE cit|');
    const s = suggerisci({ testo, cursore, motore: 'sql', schema: null, colonne: ['citta', 'cap'] });
    assert.strictEqual(s[0].testo, 'citta');
  });

  prova('Il vocabolario ristretto della griglia non propone SELECT', () => {
    const { testo, cursore } = conCursore('s|');
    const s = testi(suggerisci({
      testo, cursore, motore: 'sql', schema: null, colonne: ['stato'], vocabolario: PAROLE_SQL_WHERE,
    }));
    assert.ok(s.includes('stato'), s.join(', '));
    assert.ok(!s.includes('SELECT'), s.join(', '));
  });

  /* --- Mongo ------------------------------------------------------------- */

  prova('Dopo db. servono le collezioni', () => {
    const { testo, cursore } = conCursore('db.ord|');
    const ctx = contestoQuery({ testo, cursore, motore: 'mongo' });
    assert.strictEqual(ctx.tipo, 'collezione');
    assert.deepStrictEqual(testi(suggerisci({ testo, cursore, motore: 'mongo', schema })), ['ordini']);
  });

  prova('Dopo db.collezione. servono i metodi', () => {
    const { testo, cursore } = conCursore('db.utenti.fin|');
    const s = testi(suggerisci({ testo, cursore, motore: 'mongo', schema }));
    assert.deepStrictEqual(s, ['find', 'findOne']);
  });

  prova('Dentro find() servono i campi di QUELLA collezione', () => {
    const { testo, cursore } = conCursore('db.ordini.find({ tot| })');
    const s = suggerisci({ testo, cursore, motore: 'mongo', schema });
    assert.strictEqual(s[0].testo, 'totale');
  });

  prova('In uno script vale l\'ultima collezione prima del cursore', () => {
    const { testo, cursore } = conCursore('db.utenti.find({});\ndb.prodotti.find({ tit| });');
    assert.strictEqual(collezioneAlCursore(testo, cursore), 'prodotti');
    assert.strictEqual(suggerisci({ testo, cursore, motore: 'mongo', schema })[0].testo, 'titolo');
  });

  prova('Il $ apre gli operatori', () => {
    const { testo, cursore } = conCursore('db.ordini.find({ totale: { $g| } })');
    const ctx = contestoQuery({ testo, cursore, motore: 'mongo' });
    assert.strictEqual(ctx.tipo, 'operatore');
    const s = testi(suggerisci({ testo, cursore, motore: 'mongo', schema }));
    assert.ok(s.includes('$gt') && s.includes('$gte'), s.join(', '));
    assert.ok(!s.includes('$lt'), 'il prefisso deve filtrare');
  });

  prova('db.getCollection("x") viene riconosciuto', () => {
    const { testo, cursore } = conCursore('db.getCollection("utenti").find({ em| })');
    assert.strictEqual(suggerisci({ testo, cursore, motore: 'mongo', schema })[0].testo, 'email');
  });

  /* --- SQL su MongoDB (la lingua la dice il testo, non il DBMS) --------- */

  prova('motoreDalTesto riconosce SQL, MQL e sintassi shell', () => {
    const l = (s) => motoreDalTesto(s, s.length);
    assert.strictEqual(l('SELECT * FROM u'), 'sql');
    assert.strictEqual(l('  -- commento\n  select 1'), 'sql');
    assert.strictEqual(l('SELECT * FROM db.utenti'), 'sql', 'un `db.` dentro una SELECT non la rende MQL');
    assert.strictEqual(l('{ "stato": "attivo" }'), 'mongo');
    assert.strictEqual(l('db.utenti.find({'), 'mongo');
    assert.strictEqual(l('ute'), '', 'una parola sola non decide niente');
  });

  prova('Su MongoDB una SELECT propone le COLLEZIONI dopo FROM', () => {
    // È il caso che prima non funzionava: la lingua veniva dedotta dal tipo di
    // connessione, quindi su Mongo il completamento restava in modalità MQL e
    // dopo `FROM` non aiutava affatto.
    const { testo, cursore } = conCursore('SELECT * FROM ute|');
    const s = suggerisci({ testo, cursore, motore: 'auto', ripiego: 'mongo', schema });
    assert.deepStrictEqual(testi(s), ['utenti']);
    assert.strictEqual(s[0].tipo, 'tabella');
  });

  prova('Su MongoDB una SELECT propone i campi delle collezioni citate', () => {
    const { testo, cursore } = conCursore('SELECT em| FROM utenti');
    const s = suggerisci({ testo, cursore, motore: 'auto', ripiego: 'mongo', schema });
    assert.strictEqual(s[0].testo, 'email');
  });

  prova('Su MySQL un filtro MQL resta trattato come MQL', () => {
    const { testo, cursore } = conCursore('{ "eta": { $g| } }');
    const s = testi(suggerisci({ testo, cursore, motore: 'auto', ripiego: 'sql', schema }));
    assert.ok(s.includes('$gt'), s.join(','));
  });

  prova('In uno script ogni istruzione ha la sua lingua', () => {
    const { testo, cursore } = conCursore('SELECT * FROM utenti;\ndb.ordini.find({ tot| })');
    const s = suggerisci({ testo, cursore, motore: 'auto', ripiego: 'sql', schema });
    assert.strictEqual(s[0].testo, 'totale');
  });

  prova('Finché il testo tace, su MongoDB si propongono anche gli inizi SQL', () => {
    const { testo, cursore } = conCursore('sel|');
    const s = testi(suggerisci({ testo, cursore, motore: 'auto', ripiego: 'mongo', schema }));
    assert.ok(s.includes('SELECT'), `atteso SELECT fra i suggerimenti: ${s.join(',')}`);
  });

  prova('Nel dubbio, su MongoDB compaiono anche le collezioni', () => {
    const { testo, cursore } = conCursore('ute|');
    const s = testi(suggerisci({ testo, cursore, motore: 'auto', ripiego: 'mongo', schema }));
    assert.ok(s.includes('utenti'), s.join(','));
  });

  prova('Il motore esplicito continua a comandare (nessuna rilevazione)', () => {
    const { testo, cursore } = conCursore('SELECT * FROM ute|');
    // Con motore 'mongo' imposto a mano il testo NON deve cambiare la lingua:
    // è il comportamento su cui si appoggiano le caselle della griglia.
    const ctx = contestoQuery({ testo, cursore, motore: 'mongo' });
    assert.strictEqual(ctx.motore, 'mongo');
    assert.strictEqual(ctx.tipo, 'campo');
  });

  /* --- Dialetti: funzioni, clausole e tipi del motore in uso ------------ */

  prova('dialettoDi normalizza i nomi dei motori', () => {
    assert.strictEqual(dialettoDi('mariadb'), 'mysql');
    assert.strictEqual(dialettoDi('postgres'), 'postgresql');
    assert.strictEqual(dialettoDi('mongo'), 'mongodb');
    assert.strictEqual(dialettoDi('oracle'), '');
  });

  prova('Su MySQL compaiono le funzioni MySQL', () => {
    const { testo, cursore } = conCursore('SELECT GROUP_C| FROM utenti');
    const s = suggerisci({ testo, cursore, motore: 'sql', schema, dbms: 'mysql' });
    assert.strictEqual(s[0].testo, 'GROUP_CONCAT');
    assert.strictEqual(s[0].dettaglio, 'MySQL', 'il suggerimento dice da quale motore viene');
  });

  prova('Le funzioni di un altro motore non compaiono', () => {
    const { testo, cursore } = conCursore('SELECT STRING_A| FROM utenti');
    assert.deepStrictEqual(suggerisci({ testo, cursore, motore: 'sql', schema, dbms: 'mysql' }), [],
      'STRING_AGG è PostgreSQL, su MySQL non deve comparire');
    const s = suggerisci({ testo, cursore, motore: 'sql', schema, dbms: 'postgresql' });
    assert.strictEqual(s[0].testo, 'STRING_AGG');
  });

  prova('Le clausole proprie del motore sono suggerite', () => {
    const pg = conCursore('INSERT INTO utenti VALUES (1) RETURN|');
    assert.ok(testi(suggerisci({ ...pg, motore: 'sql', schema, dbms: 'postgresql' })).includes('RETURNING'));
    const my = conCursore('INSERT INTO utenti VALUES (1) ON DUP|');
    assert.ok(testi(suggerisci({ ...my, motore: 'sql', schema, dbms: 'mysql' })).includes('ON DUPLICATE KEY UPDATE'));
  });

  prova('Le funzioni comuni restano per tutti i motori SQL', () => {
    for (const dbms of ['mysql', 'postgresql', '']) {
      const { testo, cursore } = conCursore('SELECT COAL| FROM utenti');
      const s = testi(suggerisci({ testo, cursore, motore: 'sql', schema, dbms }));
      assert.ok(s.includes('COALESCE'), `COALESCE manca con dbms="${dbms}": ${s.join(',')}`);
    }
  });

  prova('Senza DBMS il completamento è quello di prima (nessun dialetto)', () => {
    const { testo, cursore } = conCursore('SELECT GROUP_C| FROM utenti');
    assert.deepStrictEqual(suggerisci({ testo, cursore, motore: 'sql', schema }), []);
  });

  prova('SQL su MongoDB: solo gli aggregati che SqlToMql sa tradurre', () => {
    // `UPPER` non arriva a destinazione su MongoDB: proporla farebbe scrivere
    // una query che fallisce solo dopo aver premuto Esegui.
    const su = conCursore('SELECT UPP| FROM utenti');
    assert.deepStrictEqual(suggerisci({ ...su, motore: 'auto', ripiego: 'mongo', schema, dbms: 'mongodb' }), []);
    const agg = conCursore('SELECT COU| FROM utenti');
    const s = suggerisci({ ...agg, motore: 'auto', ripiego: 'mongo', schema, dbms: 'mongodb' });
    assert.strictEqual(s[0].testo, 'COUNT');
  });

  prova('I tipi di colonna si propongono nella CREATE TABLE', () => {
    const { testo, cursore } = conCursore('CREATE TABLE clienti (id INT, nome VARC|');
    const ctx = contestoQuery({ testo, cursore, motore: 'sql' });
    assert.strictEqual(ctx.tipo, 'tipo');
    const s = suggerisci({ testo, cursore, motore: 'sql', schema, dbms: 'mysql' });
    assert.strictEqual(s[0].testo, 'VARCHAR(255)');
  });

  prova('I tipi si propongono anche dopo ALTER TABLE … ADD', () => {
    const { testo, cursore } = conCursore('ALTER TABLE utenti ADD COLUMN nato TIMEST|');
    const s = testi(suggerisci({ testo, cursore, motore: 'sql', schema, dbms: 'postgresql' }));
    assert.ok(s.includes('timestamp') || s.includes('timestamptz'), s.join(','));
  });

  prova('L\'identificatore SQL riconosce le tre forme di virgolette', () => {
    // `ID_SQL` è una stringa che diventa una regex: un livello di escape in
    // meno e diventa silenziosamente più permissiva. Qui si fissa il contratto.
    const re = new RegExp(`^${ID_SQL}$`);
    for (const buono of ['tabella', '"Con Spazi"', '`altro`', '[quadre]', '_x$1']) {
      assert.ok(re.test(buono), `doveva riconoscere ${buono}`);
    }
    assert.ok(!re.test('due parole'), 'un nome nudo con uno spazio non è un identificatore');
    assert.strictEqual(smarca('"Prova"'), 'Prova');
    assert.strictEqual(ultimoSegmento('diego."Prova"'), 'Prova');
    assert.strictEqual(ultimoSegmento('`db`.`Tab`'), 'Tab');
    assert.strictEqual(ultimoSegmento('utenti'), 'utenti');
  });

  prova('Le parentesi dentro le stringhe non contano nel DDL', () => {
    // Una `)` dentro un commento chiudeva, nel conteggio, l'elenco delle
    // colonne: da lì in poi i tipi non venivano più proposti proprio mentre si
    // scriveva la tabella. E una `(` dentro una stringa faceva l'errore
    // opposto, proponendoli dove non servono.
    const dentro = conCursore("CREATE TABLE t (id INT COMMENT 'chiave)', nome VARC|");
    const s = testi(suggerisci({ ...dentro, motore: 'sql', schema, dbms: 'mysql' }));
    assert.ok(s.includes('VARCHAR(255)'), `nell'elenco colonne servono i tipi: ${s.join(',')}`);

    const fuori = conCursore("ALTER TABLE t ADD c TEXT DEFAULT '( nota VARC|");
    const s2 = testi(suggerisci({ ...fuori, motore: 'sql', schema, dbms: 'mysql' }));
    assert.ok(!s2.some((v) => /^VARCHAR/.test(v)), `qui i tipi non c'entrano: ${s2.join(',')}`);
  });

  prova('Fuori dal DDL i tipi NON compaiono', () => {
    const { testo, cursore } = conCursore('SELECT * FROM utenti WHERE nome = TEX|');
    const s = testi(suggerisci({ testo, cursore, motore: 'sql', schema, dbms: 'mysql' }));
    assert.ok(!s.includes('TEXT'), s.join(','));
  });

  prova('Dopo `db.` compaiono anche i metodi dell\'oggetto db', () => {
    const { testo, cursore } = conCursore('db.getColl|');
    const s = testi(suggerisci({ testo, cursore, motore: 'mongo', schema }));
    assert.ok(s.includes('getCollection'), s.join(','));
  });

  prova('Le collezioni restano prima dei metodi di db', () => {
    const { testo, cursore } = conCursore('db.|');
    const s = testi(suggerisci({ testo, cursore, motore: 'mongo', schema, limite: 20 }));
    assert.strictEqual(s[0], 'utenti');
    assert.ok(s.indexOf('utenti') < s.indexOf('getCollection'), s.join(','));
  });

  prova('Gli stadi di aggregazione meno comuni ci sono', () => {
    const { testo, cursore } = conCursore('db.ordini.aggregate([{ $graph|');
    const s = testi(suggerisci({ testo, cursore, motore: 'mongo', schema }));
    assert.ok(s.includes('$graphLookup'), s.join(','));
  });

  /* --- Nomi qualificati dallo schema ------------------------------------ */

  prova('Dopo FROM il punto separa lo SCHEMA dalla tabella', () => {
    // Il caso segnalato: `FROM diego.Pro` chiedeva le colonne di una tabella
    // "diego", non le tabelle dello schema — quindi non suggeriva nulla.
    const { testo, cursore } = conCursore('SELECT * FROM diego.ute|');
    const ctx = contestoQuery({ testo, cursore, motore: 'sql' });
    assert.strictEqual(ctx.tipo, 'tabella');
    assert.strictEqual(ctx.qualificatore, 'diego');
    const s = suggerisci({ testo, cursore, motore: 'sql', schema, database: 'diego' });
    assert.deepStrictEqual(testi(s), ['utenti']);
  });

  prova('Uno schema diverso da quello aperto non propone nomi altrui', () => {
    const { testo, cursore } = conCursore('SELECT * FROM altro_schema.ute|');
    assert.deepStrictEqual(suggerisci({ testo, cursore, motore: 'sql', schema, database: 'diego' }), []);
  });

  prova('Il JOIN qualificato si comporta allo stesso modo', () => {
    const { testo, cursore } = conCursore('SELECT * FROM a JOIN diego.ord|');
    assert.deepStrictEqual(testi(suggerisci({ testo, cursore, motore: 'sql', schema, database: 'diego' })), ['ordini']);
  });

  prova('L\'alias dopo il FROM resta un alias (non diventa uno schema)', () => {
    const { testo, cursore } = conCursore('SELECT u.no| FROM utenti u');
    assert.strictEqual(contestoQuery({ testo, cursore, motore: 'sql' }).tipo, 'colonna');
  });

  /* --- Quoting degli identificatori ------------------------------------- */

  prova('PostgreSQL: un nome con una maiuscola va quotato', () => {
    // Il caso visto sul campo: `FROM diego.Prova` cerca `diego.prova`, perché
    // PostgreSQL abbassa gli identificatori non quotati, e la query fallisce
    // con "relation does not exist".
    assert.strictEqual(quotaIdentificatore('Prova', 'postgresql'), '"Prova"');
    assert.strictEqual(quotaIdentificatore('prova', 'postgresql'), 'prova');
    assert.strictEqual(quotaIdentificatore('due parole', 'postgresql'), '"due parole"');
    assert.strictEqual(quotaIdentificatore('vir"gola', 'postgresql'), '"vir""gola"');
  });

  prova('MySQL non abbassa i nomi: si quota solo se serve davvero', () => {
    assert.strictEqual(quotaIdentificatore('Prova', 'mysql'), 'Prova');
    assert.strictEqual(quotaIdentificatore('due parole', 'mysql'), '`due parole`');
    assert.strictEqual(quotaIdentificatore('order', 'mysql'), '`order`', 'parola chiave');
  });

  prova('Su MongoDB si usa il backtick, non il doppio apice', () => {
    // SqlToMql legge "…" come STRINGA: `"Prova"` non sarebbe una collezione.
    assert.strictEqual(quotaIdentificatore('mia-collezione', 'mongodb'), '`mia-collezione`');
    assert.strictEqual(quotaIdentificatore('Prova', 'mongodb'), 'Prova');
  });

  prova('Motore sconosciuto: nessuna virgoletta inventata', () => {
    assert.strictEqual(quotaIdentificatore('Prova', ''), 'Prova');
    assert.strictEqual(quotaIdentificatore('Prova', 'oracle'), 'Prova');
  });

  prova('Accettando la tabella su PostgreSQL il nome esce quotato', () => {
    const { testo, cursore } = conCursore('SELECT * FROM diego.Pro|');
    const r = applicaSuggerimento(testo, cursore, 'Prova', { tipo: 'tabella', dbms: 'postgresql', lingua: 'sql' });
    assert.strictEqual(r.testo, 'SELECT * FROM diego."Prova"');
  });

  prova('Le virgolette già aperte dall\'utente non si raddoppiano', () => {
    const { testo, cursore } = conCursore('SELECT * FROM "Pro|"');
    const r = applicaSuggerimento(testo, cursore, 'Prova', { tipo: 'tabella', dbms: 'postgresql', lingua: 'sql' });
    assert.strictEqual(r.testo, 'SELECT * FROM "Prova"');
  });

  prova('Anche le colonne escono quotate quando serve', () => {
    const { testo, cursore } = conCursore('SELECT p.Val| FROM "Prova" p');
    const r = applicaSuggerimento(testo, cursore, 'Valore', { tipo: 'campo', dbms: 'postgresql', lingua: 'sql' });
    assert.strictEqual(r.testo, 'SELECT p."Valore" FROM "Prova" p');
  });

  prova('In MQL i nomi NON si quotano (la chiave è già una stringa JSON)', () => {
    const { testo, cursore } = conCursore('db.Prova.find({ Val| })');
    const r = applicaSuggerimento(testo, cursore, 'Valore', { tipo: 'campo', dbms: 'mongodb', lingua: 'mongo' });
    assert.strictEqual(r.testo, 'db.Prova.find({ Valore })');
  });

  prova('Parole chiave e funzioni non vengono mai quotate', () => {
    const { testo, cursore } = conCursore('SELECT COU|');
    const r = applicaSuggerimento(testo, cursore, 'COUNT', { tipo: 'funzione', dbms: 'postgresql', lingua: 'sql' });
    assert.strictEqual(r.testo, 'SELECT COUNT');
  });

  /* --- Applicazione del suggerimento ------------------------------------ */

  prova('Accettare un suggerimento sostituisce solo il token in scrittura', () => {
    const { testo, cursore } = conCursore('SELECT no| FROM utenti');
    assert.deepStrictEqual(applicaSuggerimento(testo, cursore, 'nome'), {
      testo: 'SELECT nome FROM utenti', cursore: 11,
    });
  });

  prova('Accettare un operatore non raddoppia il $', () => {
    const { testo, cursore } = conCursore('{ a: { $g| } }');
    const r = applicaSuggerimento(testo, cursore, '$gt');
    assert.strictEqual(r.testo, '{ a: { $gt } }');
  });

  prova('Il testo dopo il cursore non viene mangiato', () => {
    const { testo, cursore } = conCursore('SELECT no| FROM utenti WHERE id = 1');
    assert.ok(applicaSuggerimento(testo, cursore, 'nome').testo.endsWith('WHERE id = 1'));
  });

  console.log(falliti === 0
    ? '  Tutti i test IntelliSense superati.'
    : `  ${falliti} test IntelliSense FALLITI.`);
  if (falliti > 0) process.exitCode = 1;
})();

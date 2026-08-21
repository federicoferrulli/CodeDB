'use strict';

/* ---------------------------------------------------------------------------
 * Ogni evento socket sta in UNA famiglia, e la famiglia è quella giusta.
 *
 * È il terzo gradino del criterio di chiusura di questo lotto: non basta che la
 * situazione sia sistemata, dev'essere difficile riformarla. ADR-0001 riconosce
 * tre famiglie, ognuna con la propria giuntura:
 *
 *   delegate()          evento sui DATI          — delega a una strategia
 *   amministrativo()    evento AMMINISTRATIVO    — non tocca alcuna strategia
 *   operazioneLunga()   OPERAZIONE LUNGA         — usa punti di estensione propri
 *
 * più `safeOn()`, la via generica, che resta per le eccezioni **dichiarate** in
 * `ECCEZIONI_VIA_GENERICA`. Registrare un evento fuori da questo schema — o
 * dichiararlo in due famiglie — fa fallire questo test.
 *
 * Perché è un controllo sul TESTO: la registrazione avviene dentro
 * `registraEventi`, e nessun controllo di tipo può dire con quale funzione un
 * evento è stato registrato. È lo stesso modello di `unit-handler-scope.js`, e
 * come quello dichiara i propri limiti: legge nomi di funzione, non semantica.
 * Vede chi registra dove; non vedrebbe una giuntura chiamata con un nome
 * costruito a runtime — che però in questo file non esiste, e questo test
 * fallirebbe se l'elenco crollasse (vedi «troppo pochi» più sotto).
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SORGENTE = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SORGENTE, 'utf8');

const GIUNTURE = {
  delegate: 'evento sui dati',
  amministrativo: 'evento amministrativo',
  operazioneLunga: 'operazione lunga',
  safeOn: 'via generica (eccezione dichiarata)',
};

/** Gli eventi registrati con una certa giuntura, con la riga. */
function registratiCon(giuntura) {
  const re = new RegExp(`\\b${giuntura}\\(\\s*['"]([^'"]+)['"]\\s*,`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ evento: m[1], riga: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** Il corpo di un handler, dalla registrazione alla successiva. */
function corpoDi(evento) {
  const i = src.search(new RegExp(`\\b(?:${Object.keys(GIUNTURE).join('|')})\\(\\s*['"]${evento.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`));
  if (i < 0) return '';
  const dopo = src.slice(i + evento.length + 20);
  const j = dopo.search(new RegExp(`\\n  (?:${Object.keys(GIUNTURE).join('|')})\\(`));
  return dopo.slice(0, j > 0 ? j : 4000);
}

/** L'oggetto letterale dichiarato in server.js, come testo. */
function tabella(nome, fine) {
  const i = src.indexOf(`const ${nome} = {`);
  assert.ok(i >= 0, `tabella ${nome} non trovata`);
  const j = src.indexOf(fine, i);
  return src.slice(i, j > 0 ? j : src.length);
}

/** I nomi di primo livello dichiarati in una tabella evento → qualcosa. */
function chiaviDi(testo) {
  return [...testo.matchAll(/^ {2}'([^']+)':/gm)].map((m) => m[1]);
}

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

console.log('  --- Registrazione degli eventi socket: una famiglia sola, quella giusta ---');

const perGiuntura = {};
for (const g of Object.keys(GIUNTURE)) perGiuntura[g] = registratiCon(g);
const tutti = Object.entries(perGiuntura)
  .flatMap(([g, lista]) => lista.map((v) => ({ ...v, giuntura: g })));

/* --- Il riconoscimento non deve marcire ------------------------------------ */

prova('l\'elenco degli eventi è completo', () => {
  // Se il riconoscimento si rompe, il test deve fallire rumorosamente invece di
  // passare per non aver trovato nulla da controllare. È la guardia che, in
  // questo stesso lotto, ha salvato due volte `unit-handler-scope.js`.
  assert.ok(tutti.length >= 70,
    `Eventi riconosciuti: ${tutti.length}. Troppo pochi: il riconoscimento è da aggiornare.`);
  for (const g of Object.keys(GIUNTURE)) {
    assert.ok(perGiuntura[g].length > 0,
      `nessun evento registrato con ${g}(): o la giuntura è sparita, o il riconoscimento è rotto`);
  }
});

/* --- Una famiglia sola ----------------------------------------------------- */

prova('nessun evento è dichiarato in due famiglie', () => {
  const visti = new Map();
  const doppi = [];
  for (const v of tutti) {
    if (visti.has(v.evento)) {
      const primo = visti.get(v.evento);
      doppi.push(
        `"${v.evento}" registrato due volte: ${primo.giuntura}() a server.js:${primo.riga} `
        + `e ${v.giuntura}() a server.js:${v.riga}. `
        + 'Cosa fare: tienine una sola — la famiglia si decide da ciò che l\'handler fa, '
        + 'non da quale registrazione è stata scritta per prima.'
      );
    }
    visti.set(v.evento, v);
  }
  assert.deepStrictEqual(doppi, [], doppi.join('\n       '));
});

/* --- La via generica è solo per le eccezioni DICHIARATE -------------------- */

prova('ogni evento sulla via generica è un\'eccezione dichiarata, col suo motivo', () => {
  const dichiarate = chiaviDi(tabella('ECCEZIONI_VIA_GENERICA', '\n/* ---'));
  const nonDichiarati = perGiuntura.safeOn
    .filter((v) => !dichiarate.includes(v.evento))
    .map((v) => (
      `"${v.evento}" (server.js:${v.riga}) è registrato con safeOn() ma non è dichiarato.\n`
      + '       Cosa fare: scegli la sua famiglia (ADR-0001) e usane la giuntura —\n'
      + '         delegate()        se delega a una strategia;\n'
      + '         amministrativo()  se non tocca alcuna strategia;\n'
      + '         operazioneLunga() se usa i punti di estensione delle operazioni lunghe.\n'
      + '       Se è davvero un\'eccezione, aggiungila a ECCEZIONI_VIA_GENERICA con il motivo.'
    ));
  assert.deepStrictEqual(nonDichiarati, [], nonDichiarati.join('\n       '));
});

prova('nessuna eccezione dichiarata è rimasta senza handler', () => {
  // Il difetto opposto: si crede di aver motivato un'eccezione che nel
  // frattempo è stata migrata o rimossa, e il motivo resta lì a mentire.
  const dichiarate = chiaviDi(tabella('ECCEZIONI_VIA_GENERICA', '\n/* ---'));
  const sulla = new Set(perGiuntura.safeOn.map((v) => v.evento));
  const orfane = dichiarate.filter((e) => !sulla.has(e)).map((e) => (
    `"${e}" è dichiarata eccezione della via generica, ma nessun handler la registra così.\n`
    + '       Cosa fare: togli la voce da ECCEZIONI_VIA_GENERICA.'
  ));
  assert.deepStrictEqual(orfane, [], orfane.join('\n       '));
});

/* --- La famiglia dichiarata corrisponde a ciò che l'handler fa ------------- */

prova('un evento amministrativo non tocca alcuna strategia', () => {
  // È il criterio osservabile che il ticket chiede. Non si prova che un evento
  // sui dati deleghi davvero — quello lo dice la giuntura stessa, che gli passa
  // la strategia — ma il verso opposto sì: chi è dichiarato amministrativo non
  // può leggere una strategia, perché sarebbe nella famiglia sbagliata e la
  // capability per database non verrebbe mai verificata.
  const colpevoli = [];
  for (const v of perGiuntura.amministrativo) {
    const corpo = corpoDi(v.evento);
    if (/\.strategy\b/.test(corpo) || /\bsessions\.get\(/.test(corpo)) {
      colpevoli.push(
        `"${v.evento}" (server.js:${v.riga}) è dichiarato amministrativo ma tocca una strategia.\n`
        + '       Cosa fare: registralo con delegate(), che verifica la capability sul\n'
        + '       database bersaglio — nella famiglia amministrativa quella verifica non avviene.'
      );
    }
  }
  assert.deepStrictEqual(colpevoli, [], colpevoli.join('\n       '));
});

prova('le tre tabelle delle famiglie non si sovrappongono', () => {
  const amministrativi = chiaviDi(tabella('EVENTI_AMMINISTRATIVI', 'const AUDIT_WRITES'));
  const lunghe = chiaviDi(tabella('OPERAZIONI_LUNGHE', '\n/* ---'));
  const eccezioni = chiaviDi(tabella('ECCEZIONI_VIA_GENERICA', '\n/* ---'));
  const conflitti = [];
  const coppie = [
    ['EVENTI_AMMINISTRATIVI', amministrativi, 'OPERAZIONI_LUNGHE', lunghe],
    ['EVENTI_AMMINISTRATIVI', amministrativi, 'ECCEZIONI_VIA_GENERICA', eccezioni],
    ['OPERAZIONI_LUNGHE', lunghe, 'ECCEZIONI_VIA_GENERICA', eccezioni],
  ];
  for (const [nomeA, a, nomeB, b] of coppie) {
    for (const e of a.filter((x) => b.includes(x))) {
      conflitti.push(`"${e}" è dichiarato sia in ${nomeA} sia in ${nomeB}: scegline uno.`);
    }
  }
  assert.deepStrictEqual(conflitti, [], conflitti.join('\n       '));
});

/* --- Il quadro, stampato: serve a chi legge l'esito ------------------------ */

{
  const conteggio = Object.entries(perGiuntura)
    .map(([g, lista]) => `${GIUNTURE[g]}: ${lista.length}`)
    .join(' · ');
  console.log(`  ${tutti.length} eventi — ${conteggio}`);
}

if (falliti) throw new Error(`${falliti} test sulla registrazione degli eventi falliti`);
console.log('  Registrazione eventi: ogni evento in una famiglia sola, dichiarata.');

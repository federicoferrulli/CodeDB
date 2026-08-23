'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari della ricerca della palette (public/js/palette-ricerca.js).
 *
 * PERCHÉ ESISTE. Da quando la palette elenca anche le TABELLE di tutti i
 * database, l'elenco passa da una decina di voci a qualche migliaio: quale
 * riga sopravvive al termine scritto, e in che ordine, smette di essere un
 * dettaglio di disegno e diventa la funzione. Stava dentro `innerHTML`, quindi
 * non era provabile senza un browser.
 *
 * Gira senza server e senza DOM.
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

module.exports = (async () => {
  const { punteggio, testoDiVoce, filtra, interpreta, RICHIAMI } = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'palette-ricerca.js')).href
  );

  console.log('  --- Ricerca della palette (public/js/palette-ricerca.js) ---');

  /* --- Il punteggio ------------------------------------------------------ */

  prova('comincia per batte contiene, che batte la sottosequenza', () => {
    assert.strictEqual(punteggio('use', 'users'), 0);
    assert.strictEqual(punteggio('ser', 'users'), 1);
    assert.strictEqual(punteggio('urs', 'users'), 2); // u-r-s in ordine, non adiacenti
    assert.strictEqual(punteggio('zzz', 'users'), null);
  });

  prova('la ricerca non distingue maiuscole e minuscole', () => {
    assert.strictEqual(punteggio('USE', 'users'), 0);
    assert.strictEqual(punteggio('use', 'USERS'), 0);
  });

  prova('senza termine tutto resta, nell\'ordine di arrivo', () => {
    assert.strictEqual(punteggio('', 'qualunque'), 3);
  });

  /* --- Il testo cercato -------------------------------------------------- */

  prova('una voce si cerca per nome, per database e per tipo', () => {
    const voce = { tipo: 'Tabella', etichetta: 'users', nota: 'dropchecker' };
    const testo = testoDiVoce(voce);
    assert.ok(punteggio('users', testo) !== null, 'per nome');
    assert.ok(punteggio('dropchecker', testo) !== null, 'per database');
    assert.ok(punteggio('tabella', testo) !== null, 'per tipo');
  });

  /* --- L'ordine ---------------------------------------------------------- */

  const voci = [
    { tipo: 'Comando', etichetta: 'Nuova connessione' },
    { tipo: 'Database', etichetta: 'dropchecker' },
    { tipo: 'Tabella', etichetta: 'users', nota: 'dropchecker' },
    { tipo: 'Tabella', etichetta: 'userprofiles', nota: 'dropchecker' },
    { tipo: 'Tabella', etichetta: 'tenantusers', nota: 'altro' },
  ];

  prova('chi comincia col termine viene prima di chi lo contiene', () => {
    const out = filtra(voci, 'users').map((v) => v.etichetta);
    assert.deepStrictEqual(out.slice(0, 2), ['users', 'tenantusers']);
  });

  prova('a parità di punteggio decide l\'ordine di arrivo, non la sort del motore', () => {
    const out = filtra(voci, 'user').map((v) => v.etichetta);
    // 'users' e 'userprofiles' cominciano entrambe per 'user': resta l'ordine
    // in cui sono state raccolte.
    assert.deepStrictEqual(out.slice(0, 2), ['users', 'userprofiles']);
  });

  prova('cercare il database restringe alle sue tabelle', () => {
    const out = filtra(voci, 'dropchecker').map((v) => v.etichetta);
    assert.ok(out.includes('dropchecker'), 'il database stesso');
    assert.ok(out.includes('users') && out.includes('userprofiles'), 'le sue tabelle');
    assert.ok(!out.includes('tenantusers'), 'non le tabelle di un altro database');
  });

  prova('senza termine restano tutte, nell\'ordine originale', () => {
    assert.deepStrictEqual(filtra(voci, '').map((v) => v.etichetta), voci.map((v) => v.etichetta));
    assert.deepStrictEqual(filtra(voci, '   ').map((v) => v.etichetta), voci.map((v) => v.etichetta));
  });

  prova('nessun tetto sul numero di risultati: la lista è virtualizzata', () => {
    const molte = Array.from({ length: 5000 }, (_, i) => ({ tipo: 'Tabella', etichetta: `tab_${i}` }));
    assert.strictEqual(filtra(molte, 'tab').length, 5000);
  });

  prova('un termine che non corrisponde a nulla non lascia nulla', () => {
    assert.deepStrictEqual(filtra(voci, 'qwertyx'), []);
  });

  /* --- I richiami -------------------------------------------------------- */

  prova('un richiamo dice che cosa si sta cercando e sparisce dal termine', () => {
    assert.deepStrictEqual(interpreta('>nuova'), { richiamo: '>', tipo: 'Comando', termine: 'nuova' });
    assert.deepStrictEqual(interpreta('#drop'), { richiamo: '#', tipo: 'Database', termine: 'drop' });
    assert.deepStrictEqual(interpreta('@users'), { richiamo: '@', tipo: 'Tabella', termine: 'users' });
  });

  prova('lo spazio dopo il richiamo non fa parte del termine', () => {
    assert.deepStrictEqual(interpreta('@  users '), { richiamo: '@', tipo: 'Tabella', termine: 'users' });
    assert.deepStrictEqual(interpreta('  #drop'), { richiamo: '#', tipo: 'Database', termine: 'drop' });
  });

  prova('un richiamo da solo non cerca nulla: mostra tutto il suo tipo', () => {
    assert.deepStrictEqual(interpreta('#'), { richiamo: '#', tipo: 'Database', termine: '' });
    assert.strictEqual(filtra(voci, '#').length, 1); // il solo database dell'elenco
    assert.strictEqual(filtra(voci, '@').length, 3); // le tre tabelle
    assert.strictEqual(filtra(voci, '>').length, 1); // il solo comando
  });

  prova('un carattere che non e\' un richiamo resta parte del termine', () => {
    assert.deepStrictEqual(interpreta('users'), { richiamo: '', tipo: null, termine: 'users' });
    // Un nome puo' contenere qualunque cosa: mangiarsi il primo carattere di una
    // ricerca legittima sarebbe peggio del richiamo mancato.
    assert.deepStrictEqual(interpreta('_users'), { richiamo: '', tipo: null, termine: '_users' });
    assert.deepStrictEqual(interpreta('$log'), { richiamo: '', tipo: null, termine: '$log' });
  });

  prova('il richiamo restringe DAVVERO al tipo, non solo riordina', () => {
    const soloTabelle = filtra(voci, '@dropchecker');
    assert.ok(soloTabelle.every((v) => v.tipo === 'Tabella'), 'solo tabelle');
    assert.deepStrictEqual(soloTabelle.map((v) => v.etichetta), ['users', 'userprofiles']);
    // Senza richiamo lo stesso termine porta su anche il database omonimo.
    assert.ok(filtra(voci, 'dropchecker').some((v) => v.tipo === 'Database'));
  });

  prova('con un richiamo il tipo esce dal testo cercato: il filtro filtra', () => {
    // 'base' e' dentro «Database»: se il tipo restasse nel testo cercato,
    // '#base' corrisponderebbe a OGNI database.
    assert.deepStrictEqual(filtra(voci, '#base'), []);
    // E senza richiamo il tipo si cerca ancora (e' la via per «tutte le tabelle»).
    assert.strictEqual(filtra(voci, 'tabella').length, 3);
  });

  prova('un richiamo con un termine che non corrisponde non lascia nulla', () => {
    assert.deepStrictEqual(filtra(voci, '>zzz'), []);
    assert.deepStrictEqual(filtra(voci, '@zzz'), []);
  });

  prova('il catalogo dei richiami e\' chiuso e dichiarato', () => {
    assert.deepStrictEqual(Object.keys(RICHIAMI), ['>', '#', '@']);
    assert.ok(Object.isFrozen(RICHIAMI));
  });

  if (falliti) throw new Error(`${falliti} test della ricerca della palette falliti`);
  console.log('  Tutti i test della ricerca della palette superati.');
})();

'use strict';

/* ---------------------------------------------------------------------------
 * Il filtro rapido del frontend (public/js/filtro-rapido.js).
 *
 * La casella del filtro chiedeva all'utente di sapere quale motore aveva
 * davanti: su MongoDB un documento MQL, sui due motori SQL un frammento di
 * clausola `WHERE`. Due linguaggi nella stessa casella, e nessuno dei due è ciò
 * che si vuole nel caso più frequente — cercare una parola e vedere dove
 * compare.
 *
 * Modulo puro, provato senza browser: è ciò che il ticket 11 ha reso possibile.
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
  const { filtroRapido, payloadFiltro, modoSuccessivo, MODI } = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'filtro-rapido.js')).href
  );

  console.log('  --- Il filtro rapido della griglia ---');

  const COLONNE = ['_id', 'nome', 'citta', 'eta'];

  /* --- La composizione --------------------------------------------------- */

  prova('invia una sola intenzione server-side, senza enumerare colonne', () => {
    const f = filtroRapido('ann', COLONNE);
    assert.deepStrictEqual(f, { operatore: 'contieneOvunque', valore: 'ann' });
  });

  prova('testo vuoto o solo spazi: nessun filtro', () => {
    // `null` significa «nessuna condizione», non «filtro vuoto».
    assert.strictEqual(filtroRapido('', COLONNE), null);
    assert.strictEqual(filtroRapido('   ', COLONNE), null);
    assert.strictEqual(filtroRapido(null, COLONNE), null);
  });

  prova('il testo viene ripulito ai bordi ma non dentro', () => {
    assert.strictEqual(filtroRapido('  due parole  ', COLONNE).valore, 'due parole');
  });

  prova('trova anche una corrispondenza presente soltanto nella settima colonna', () => {
    const colonne = ['_id', 'a', 'b', 'c', 'd', 'e', 'f', 'label'];
    const p = payloadFiltro('rapido', 'Membro', colonne);
    assert.deepStrictEqual(p.cercaOvunque, { operatore: 'contieneOvunque', valore: 'Membro' });
    assert.strictEqual(p.filtro, undefined, 'il browser non deve comporre un OR limitato alle colonne correnti');
  });

  /* --- Che cosa si manda al server -------------------------------------- */

  prova('modalità rapida: si manda `cercaOvunque`, mai `filter`', () => {
    const p = payloadFiltro('rapido', 'ann', COLONNE);
    assert.ok(p.cercaOvunque, 'deve esserci la ricerca strutturata');
    assert.strictEqual(p.filter, undefined, 'il testo grezzo non deve partire');
  });

  prova('modalità condizione: si manda `filter`, mai `filtro`', () => {
    const p = payloadFiltro('condizione', 'eta > 30', COLONNE);
    assert.strictEqual(p.filter, 'eta > 30');
    assert.strictEqual(p.filtro, undefined);
  });

  prova('le due chiavi non partono MAI insieme', () => {
    // Mandarle entrambe le fa valere entrambe (unite da AND): la casella è una
    // sola, e il suo contenuto significa una cosa alla volta.
    for (const modo of ['rapido', 'condizione']) {
      const p = payloadFiltro(modo, 'qualcosa', COLONNE);
      assert.ok(!(p.filter && p.cercaOvunque), `${modo}: non devono esserci entrambe`);
    }
  });

  prova('casella vuota: payload vuoto in entrambe le modalità', () => {
    assert.deepStrictEqual(payloadFiltro('rapido', '', COLONNE), {});
    assert.deepStrictEqual(payloadFiltro('condizione', '   ', COLONNE), {});
  });

  /* --- Le due modalità --------------------------------------------------- */

  prova('il pulsante alterna fra due modalità, e solo quelle', () => {
    assert.strictEqual(modoSuccessivo('rapido'), 'condizione');
    assert.strictEqual(modoSuccessivo('condizione'), 'rapido');
    assert.deepStrictEqual(Object.keys(MODI).sort(), ['condizione', 'rapido']);
  });

  prova('ogni modalità dice cosa fa: icona, titolo, segnaposto', () => {
    for (const [nome, spec] of Object.entries(MODI)) {
      for (const chiave of ['icona', 'etichetta', 'titolo', 'segnaposto']) {
        assert.ok(spec[chiave] && typeof spec[chiave] === 'string', `${nome} non dichiara ${chiave}`);
      }
    }
    assert.strictEqual(MODI.rapido.icona, 'search', 'la ricerca usa la lente, non l\'occhio ambiguo');
  });

  if (falliti) throw new Error(`${falliti} test del filtro rapido falliti`);
  console.log('  Filtro rapido: una parola, tutte le colonne, nessun motore da conoscere.');
})();

'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari dello stato della guida introduttiva
 * (public/js/onboarding-stato.js). Nessun browser: il modulo è foglia e puro
 * proprio per essere provabile qui.
 *
 * Cosa vale la pena verificare, perché sbagliato NON si vede subito:
 *   1. il benvenuto si apre UNA volta sola — una guida che ricompare a ogni
 *      avvio è la prima cosa che fa disinstallare un programma;
 *   2. le novità compaiono solo DOPO un aggiornamento vero, e solo se c'è
 *      qualcosa da raccontare: una modale vuota a ogni versione è rumore;
 *   3. uno storage illeggibile o manomesso non deve impedire l'avvio;
 *   4. il confronto di versioni non deve divergere dal gemello CommonJS di
 *      `electron-aggiornamenti.js` (stessa ragione dei due splitter SQL: due
 *      copie che rispondono diversamente sono peggio di una sola sbagliata).
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { confrontaVersioni: versioniElectron } = require('../electron-aggiornamenti');

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

/** localStorage finto: la stessa API minima usata dal modulo. */
function storageFinto(iniziale) {
  const dati = new Map(Object.entries(iniziale || {}));
  return {
    getItem: (k) => (dati.has(k) ? dati.get(k) : null),
    setItem: (k, v) => dati.set(k, String(v)),
    removeItem: (k) => dati.delete(k),
    _dati: dati,
  };
}

(async () => {
  const {
    CHIAVE, TRAGUARDI, NOVITA, leggiStato, scriviStato, aggiornaStato, segnaTraguardo,
    completati, tuttoFatto, decidiAvvio, novitaDaMostrare, confrontaVersioni,
  } = await import('../public/js/onboarding-stato.js');

  console.log('--- Test Unitari Guida Introduttiva ---');

  prova('Stato assente: si parte dal benvenuto', () => {
    const st = leggiStato(storageFinto());
    assert.strictEqual(st.visto, false);
    assert.deepStrictEqual(st.traguardi, {});
    assert.strictEqual(decidiAvvio({ stato: st, versione: '1.0.0' }).azione, 'benvenuto');
  });

  prova('Contenuto illeggibile o di forma sbagliata non blocca l\'avvio', () => {
    for (const raw of ['{non json', 'null', '"stringa"', '42', '{"traguardi":"boh"}']) {
      const st = leggiStato(storageFinto({ [CHIAVE]: raw }));
      assert.strictEqual(st.visto, false, `raw=${raw}`);
      assert.deepStrictEqual(st.traguardi, {}, `raw=${raw}`);
    }
  });

  prova('Vista la guida, al riavvio non si riapre nulla', () => {
    const store = storageFinto();
    scriviStato({ visto: true, versioneVista: '1.0.0', traguardi: {}, checklistChiusa: false }, store);
    const st = leggiStato(store);
    assert.strictEqual(decidiAvvio({ stato: st, versione: '1.0.0' }).azione, null);
  });

  prova('Dopo un aggiornamento si mostrano SOLO le novità più recenti', () => {
    const elenco = [
      { versione: '1.2.0', punti: ['due'] },
      { versione: '1.1.0', punti: ['uno'] },
      { versione: '0.9.0', punti: ['vecchia'] },
    ];
    const stato = { visto: true, versioneVista: '1.0.0', traguardi: {}, checklistChiusa: false };
    const res = decidiAvvio({ stato, versione: '1.2.0', elenco });
    assert.strictEqual(res.azione, 'novita');
    assert.deepStrictEqual(res.novita.map((v) => v.versione), ['1.2.0', '1.1.0'], 'dalla più recente, esclusa quella già vista');
  });

  prova('Aggiornamento senza novità da raccontare: nessuna modale', () => {
    const stato = { visto: true, versioneVista: '1.0.0', traguardi: {}, checklistChiusa: false };
    assert.strictEqual(decidiAvvio({ stato, versione: '2.0.0', elenco: [] }).azione, null);
  });

  prova('Novità di una versione non ancora installata non vengono anticipate', () => {
    const elenco = [{ versione: '3.0.0', punti: ['futura'] }];
    assert.strictEqual(novitaDaMostrare('1.5.0', '1.0.0', elenco).length, 0);
  });

  prova('Primo avvio in assoluto: benvenuto, non elenco di novità', () => {
    assert.strictEqual(novitaDaMostrare('1.0.0', null, NOVITA).length, 0);
  });

  prova('Traguardo segnato una volta sola', () => {
    const store = storageFinto();
    assert.strictEqual(segnaTraguardo('connessione', store), true, 'la prima volta è nuova');
    assert.strictEqual(segnaTraguardo('connessione', store), false, 'la seconda no');
    assert.strictEqual(segnaTraguardo('inventato', store), false, 'un id sconosciuto non entra nello stato');
    const st = leggiStato(store);
    assert.strictEqual(completati(st), 1);
    assert.strictEqual(tuttoFatto(st), false);
    assert.ok(!('inventato' in st.traguardi));
  });

  prova('Tutti i traguardi: la checklist si considera finita', () => {
    const store = storageFinto();
    for (const t of TRAGUARDI) segnaTraguardo(t.id, store);
    assert.strictEqual(tuttoFatto(leggiStato(store)), true);
  });

  prova('aggiornaStato conserva il resto dello stato', () => {
    const store = storageFinto();
    segnaTraguardo('query', store);
    aggiornaStato({ checklistChiusa: true }, store);
    const st = leggiStato(store);
    assert.strictEqual(st.checklistChiusa, true);
    assert.ok(st.traguardi.query, 'il traguardo già raggiunto non deve sparire');
  });

  prova('Storage che rifiuta la scrittura (quota piena): nessuna eccezione', () => {
    const rotto = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    assert.doesNotThrow(() => segnaTraguardo('backup', rotto));
  });

  prova('Ogni traguardo ha etichetta e aiuto (la checklist li mostra entrambi)', () => {
    for (const t of TRAGUARDI) {
      assert.ok(t.id && t.etichetta && t.aiuto, `traguardo incompleto: ${JSON.stringify(t)}`);
    }
    assert.strictEqual(new Set(TRAGUARDI.map((t) => t.id)).size, TRAGUARDI.length, 'id duplicati');
  });

  prova('Le novità dichiarate sono ben formate', () => {
    for (const v of NOVITA) {
      assert.ok(/^\d+\.\d+\.\d+/.test(v.versione), `versione non valida: ${v.versione}`);
      assert.ok(Array.isArray(v.punti) && v.punti.length, `novità senza punti: ${v.versione}`);
    }
  });

  // I traguardi si segnano da moduli sparsi, dentro percorsi che i test non
  // esercitano (aprire una collection richiede un database). Una chiamata senza
  // il relativo import non fallisce al caricamento del modulo: esplode al primo
  // clic dell'utente, con un ReferenceError che porta via l'azione richiesta.
  // È esattamente com'è sfuggita la prima volta, in `colltabs.js`.
  prova('Ogni modulo che segna un traguardo importa segnaTraguardo', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'public', 'js');
    const mancanti = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      if (!/\bsegnaTraguardo\s*\(/.test(src)) continue;
      const definito = /export function segnaTraguardo/.test(src);
      const importato = /import\s*\{[^}]*\bsegnaTraguardo\b[^}]*\}\s*from\s*['"]\.\/onboarding-stato\.js['"]/.test(src);
      if (!definito && !importato) mancanti.push(f);
    }
    assert.deepStrictEqual(mancanti, [], `moduli che usano segnaTraguardo senza importarlo: ${mancanti.join(', ')}`);
  });

  prova('Confronto versioni coerente col gemello di electron-aggiornamenti.js', () => {
    const casi = [
      ['1.2.0', '1.1.9'], ['1.10.0', '1.9.0'], ['v1.0.0', '1.0.0'], ['1.0.0', '1.0.0'],
      ['1.2.0-beta.1', '1.2.0'], ['1.2.0', '1.2.0-beta.1'], ['2.0.0', '1.99.99'],
      ['1.0.1', '1.0.0'], ['0.9.0', '1.0.0'], ['1.0.0-alpha', '1.0.0-beta'],
    ];
    for (const [a, b] of casi) {
      assert.strictEqual(
        Math.sign(confrontaVersioni(a, b)), Math.sign(versioniElectron(a, b)),
        `i due confronti divergono su ${a} vs ${b}`
      );
    }
  });

  console.log(falliti ? `\n${falliti} test della guida FALLITI` : '\nTutti i test della guida introduttiva superati!');
  if (falliti) process.exitCode = 1;
})();

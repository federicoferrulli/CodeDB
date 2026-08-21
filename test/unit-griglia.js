'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari del modulo unico della griglia (public/js/griglia.js).
 *
 * Girano senza server e senza browser: è quello che il ticket 11 ha reso
 * possibile chiudendo gli effetti al caricamento dei moduli del frontend.
 *
 * Che cosa vale la pena provare qui:
 *
 *  1. l'aritmetica della finestra virtuale, che stava scritta **due volte** —
 *    in `grid.js` e in `query-tab.js`, stesse operazioni e nomi di variabile
 *    diversi — e che nessuno dei due posti provava;
 *  2. che le capacità siano opzioni **dichiarate**: un nome sbagliato deve
 *    essere un errore, non una capacità che resta spenta per sempre in
 *    silenzio;
 *  3. che il corpo della tabella venga scritto con gli spaziatori giusti, così
 *    che la barra di scorrimento rifletta il totale e non le sole righe
 *    disegnate.
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

/**
 * Un documento minimo: `disegnaCorpo` crea elementi e li appende, non li
 * misura. Bastano quindi oggetti che sappiano fare da nodo — provare il DOM
 * vero è compito dei test in Chromium, qui si prova chi lo usa.
 */
function documentoFinto() {
  const crea = (tag) => ({
    tag,
    figli: [],
    attributi: {},
    style: {},
    className: '',
    colSpan: 0,
    innerHTML: '',
    ownerDocument: null,
    setAttribute(k, v) { this.attributi[k] = v; },
    appendChild(n) { this.figli.push(n); return n; },
  });
  const doc = {
    createElement: crea,
    createDocumentFragment: () => crea('#fragment'),
  };
  return doc;
}

function tbodyFinto(doc) {
  const el = doc.createElement('tbody');
  el.ownerDocument = doc;
  // `innerHTML = ''` sul tbody vero svuota; qui si simula lo stesso effetto.
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set() { el.figli.length = 0; },
  });
  return el;
}

module.exports = (async () => {
  const griglia = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'griglia.js')).href
  );
  const {
    capacita, CAPACITA, finestraVirtuale, vaVirtualizzata, disegnaCorpo,
    spaziatore, scorrimentoPerRiga, SOGLIA_VIRTUALE,
  } = griglia;

  console.log('  --- Modulo unico della griglia (public/js/griglia.js) ---');

  /* --- Le capacità sono dichiarate -------------------------------------- */

  prova('le capacità non richieste restano spente', () => {
    const cap = capacita({ virtualizzazione: true });
    assert.strictEqual(cap.virtualizzazione, true);
    assert.strictEqual(cap.selezioneCelle, false);
    // Tutte presenti: chi legge l'oggetto vede l'inventario completo, non solo
    // ciò che è stato chiesto.
    assert.deepStrictEqual(Object.keys(cap).sort(), [...CAPACITA].sort());
  });

  prova('una capacità scritta male è un errore, non un silenzio', () => {
    // È il modo in cui una capacità resta spenta per sempre senza che nulla lo
    // dica: `selezioneCelleAttiva: true` non accende `selezioneCelle`.
    assert.throws(
      () => capacita({ selezioneCelleAttiva: true }),
      /Capacità della griglia sconosciute: selezioneCelleAttiva/
    );
  });

  prova('le capacità sono immutabili una volta dichiarate', () => {
    const cap = capacita({ virtualizzazione: true });
    assert.throws(() => { 'use strict'; cap.selezioneCelle = true; }, TypeError);
  });

  /* --- La finestra virtuale --------------------------------------------- */

  prova('in cima: si parte da zero, mai da un indice negativo', () => {
    const f = finestraVirtuale({
      scrollTop: 0, altezzaViewport: 400, altezzaRiga: 40, righeTotali: 1000, overscan: 8,
    });
    assert.strictEqual(f.inizio, 0);
    assert.strictEqual(f.fine, 0 + 10 + 16); // visibili + overscan sopra e sotto
    assert.strictEqual(f.spazioSopra, 0);
    assert.strictEqual(f.spazioSotto, (1000 - 26) * 40);
  });

  prova('a metà: la finestra segue lo scorrimento con il suo margine', () => {
    const f = finestraVirtuale({
      scrollTop: 4000, altezzaViewport: 400, altezzaRiga: 40, righeTotali: 1000, overscan: 8,
    });
    assert.strictEqual(f.inizio, 100 - 8);
    assert.strictEqual(f.fine, 92 + 10 + 16);
    assert.strictEqual(f.spazioSopra, 92 * 40);
    assert.strictEqual(f.spazioSotto, (1000 - 118) * 40);
  });

  prova('in fondo: la finestra non supera il numero di righe', () => {
    const f = finestraVirtuale({
      scrollTop: 39600, altezzaViewport: 400, altezzaRiga: 40, righeTotali: 1000, overscan: 8,
    });
    assert.strictEqual(f.fine, 1000, 'non si disegnano righe che non esistono');
    assert.strictEqual(f.spazioSotto, 0);
  });

  prova('gli spazi sopra e sotto coprono sempre le righe non disegnate', () => {
    // È la proprietà che tiene onesta la barra di scorrimento: se non torna,
    // la barra dice una lunghezza e il contenuto ne ha un'altra.
    for (const scrollTop of [0, 137, 4000, 19999, 39600, 999999]) {
      const f = finestraVirtuale({
        scrollTop, altezzaViewport: 437, altezzaRiga: 36, righeTotali: 733, overscan: 6,
      });
      const totale = f.spazioSopra + (f.fine - f.inizio) * 36 + f.spazioSotto;
      assert.strictEqual(totale, 733 * 36, `scrollTop=${scrollTop}`);
      assert.ok(f.inizio >= 0 && f.fine >= f.inizio && f.fine <= 733, `scrollTop=${scrollTop}`);
    }
  });

  prova('nessuna riga: finestra vuota, non una divisione per zero', () => {
    const f = finestraVirtuale({
      scrollTop: 0, altezzaViewport: 400, altezzaRiga: 0, righeTotali: 0,
    });
    assert.deepStrictEqual(f, { inizio: 0, fine: 0, spazioSopra: 0, spazioSotto: 0 });
  });

  prova('sotto la soglia non si virtualizza, e senza la capacità mai', () => {
    const conVirt = capacita({ virtualizzazione: true });
    const senzaVirt = capacita({});
    assert.strictEqual(vaVirtualizzata(SOGLIA_VIRTUALE, conVirt), false, 'esattamente la soglia');
    assert.strictEqual(vaVirtualizzata(SOGLIA_VIRTUALE + 1, conVirt), true);
    assert.strictEqual(vaVirtualizzata(100000, senzaVirt), false,
      'la Split-View di oggi: nessuna virtualizzazione perché non la dichiara');
  });

  /* --- Il corpo della tabella ------------------------------------------- */

  prova('virtualizzata: uno spaziatore, le righe, l\'altro spaziatore', () => {
    const doc = documentoFinto();
    const tbody = tbodyFinto(doc);
    const righe = Array.from({ length: 1000 }, (_, i) => ({ i }));
    const finestra = finestraVirtuale({
      scrollTop: 4000, altezzaViewport: 400, altezzaRiga: 40, righeTotali: 1000, overscan: 8,
    });
    const disegnate = [];
    const esito = disegnaCorpo({
      tbody,
      righe,
      disegnaRiga: (r, i) => { disegnate.push(i); const tr = doc.createElement('tr'); tr.dato = r; return tr; },
      finestra,
      colonneTotali: 5,
    });

    assert.strictEqual(esito.disegnate, finestra.fine - finestra.inizio);
    assert.strictEqual(disegnate[0], finestra.inizio, 'si comincia dall\'inizio della finestra');
    assert.strictEqual(disegnate[disegnate.length - 1], finestra.fine - 1);

    const [frammento] = tbody.figli;
    const nodi = frammento.figli;
    assert.strictEqual(nodi[0].className, 'v-spacer');
    assert.strictEqual(nodi[nodi.length - 1].className, 'v-spacer');
    assert.strictEqual(nodi.length, esito.disegnate + 2);
    assert.strictEqual(nodi[0].figli[0].style.height, `${finestra.spazioSopra}px`);
    assert.strictEqual(nodi[0].figli[0].colSpan, 5);
  });

  prova('non virtualizzata: tutte le righe e nessuno spaziatore', () => {
    const doc = documentoFinto();
    const tbody = tbodyFinto(doc);
    const righe = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const esito = disegnaCorpo({
      tbody, righe, disegnaRiga: () => doc.createElement('tr'),
      finestra: null, colonneTotali: 3,
    });
    assert.strictEqual(esito.disegnate, 3);
    const nodi = tbody.figli[0].figli;
    assert.strictEqual(nodi.length, 3);
    assert.ok(nodi.every((n) => n.className !== 'v-spacer'));
  });

  prova('in cima e in fondo non si scrive uno spaziatore da zero pixel', () => {
    const doc = documentoFinto();
    const tbody = tbodyFinto(doc);
    const righe = Array.from({ length: 30 }, (_, i) => i);
    const finestra = { inizio: 0, fine: 30, spazioSopra: 0, spazioSotto: 0 };
    disegnaCorpo({ tbody, righe, disegnaRiga: () => doc.createElement('tr'), finestra, colonneTotali: 2 });
    assert.strictEqual(tbody.figli[0].figli.length, 30);
  });

  prova('lo spaziatore è invisibile ai lettori di schermo', () => {
    const doc = documentoFinto();
    const sp = spaziatore(120, 4, doc);
    assert.strictEqual(sp.attributi['aria-hidden'], 'true');
    assert.strictEqual(sp.figli[0].style.height, '120px');
  });

  prova('il corpo viene sostituito, non accodato', () => {
    // Due disegni di seguito devono lasciare un solo insieme di righe: prima
    // ogni copia lo faceva a modo suo, e sbagliarlo raddoppia la tabella.
    const doc = documentoFinto();
    const tbody = tbodyFinto(doc);
    const righe = [1, 2];
    const disegna = () => disegnaCorpo({
      tbody, righe, disegnaRiga: () => doc.createElement('tr'), finestra: null, colonneTotali: 1,
    });
    disegna();
    disegna();
    assert.strictEqual(tbody.figli.length, 1, 'un solo frammento attaccato');
    assert.strictEqual(tbody.figli[0].figli.length, 2);
  });

  /* --- Portare una riga sotto gli occhi --------------------------------- */

  prova('riga già visibile: non si tocca lo scorrimento', () => {
    // Toccarlo farebbe sobbalzare la griglia a ogni freccia.
    assert.strictEqual(
      scorrimentoPerRiga({ indice: 5, altezzaRiga: 40, scrollTop: 100, altezzaViewport: 400 }),
      null
    );
  });

  prova('riga sopra: si sale fino alla sua cima; riga sotto: si scende quanto basta', () => {
    assert.strictEqual(
      scorrimentoPerRiga({ indice: 1, altezzaRiga: 40, scrollTop: 200, altezzaViewport: 400 }),
      40
    );
    assert.strictEqual(
      scorrimentoPerRiga({ indice: 20, altezzaRiga: 40, scrollTop: 0, altezzaViewport: 400 }),
      840 - 400
    );
  });

  if (falliti) throw new Error(`${falliti} test della griglia falliti`);
  console.log('  Tutti i test del modulo griglia superati.');
})();

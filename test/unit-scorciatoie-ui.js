'use strict';

// Esegue i gestori reali del pannello con DOM e trasporto minimi.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

module.exports = (async () => {
  const combinazioni = await import('../public/js/scorciatoie.js');
  const sorgente = fs.readFileSync(path.join(__dirname, '../public/js/scorciatoie-ui.js'), 'utf8')
    .replace(/import[\s\S]*?from '[^']+';/g, '').replace(/export /g, '');
  for (const caso of ['immutato', 'stessa', 'annullata', 'modificata', 'ripristino']) {
    const nodi = new Map();
    const nodo = id => {
      if (!nodi.has(id)) nodi.set(id, { addEventListener(t, f) { this[t] = f; },
        classList: { toggle() {}, remove() {} }, setAttribute() {}, querySelector: nodo });
      return nodi.get(id);
    };
    const salvataggi = [], messaggi = [];
    let keydown, chiuso = false;
    const contesto = vm.createContext({ ...combinazioni,
      localStorage: { getItem: () => '{}', setItem() {} },
      document: { querySelector() {}, createElement: () => nodo('overlay'),
        body: { appendChild() {} }, addEventListener(t, f) { keydown = f; },
        removeEventListener() {}, dispatchEvent() {} },
      CustomEvent: class {}, $() {}, esc: String, refreshLucideIcons() {},
      removeDialog() { chiuso = true; }, toast: m => messaggi.push(m), notifica: m => messaggi.push(m),
      emit: async (t, p) => { salvataggi.push(p); return { ok: true }; },
    });
    vm.runInContext(sorgente + '\napriPannelloScorciatoie();', contesto);
    const registra = key => {
      nodo('#scorciatoie-lista').click({ target: { closest: () => ({ dataset: { registra: 'formattaJson' } }) } });
      keydown({ key, ctrlKey: true, shiftKey: true, preventDefault() {}, stopPropagation() {} });
    };
    if (caso === 'stessa') registra('F');
    if (['annullata', 'modificata', 'ripristino'].includes(caso)) registra('J');
    if (caso === 'annullata') registra('F');
    if (caso === 'ripristino') nodo('#scorciatoie-ripristina').click();
    nodo('#scorciatoie-chiudi').click();
    await new Promise(resolve => setImmediate(resolve));
    assert(chiuso, caso + ': il pannello deve chiudersi');
    const attesi = ['modificata', 'ripristino'].includes(caso) ? 1 : 0;
    assert.equal(salvataggi.length, attesi, caso + ': salvataggi');
    assert.equal(messaggi.length, attesi, caso + ': notifiche');
  }
  console.log('OK: chiusura senza modifiche, combinazione identica, modifica annullata, salvataggio e ripristino');
})();

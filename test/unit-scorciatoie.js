'use strict';

/* ---------------------------------------------------------------------------
 * Scorciatoie da tastiera: normalizzazione delle combinazioni, corrispondenza
 * con un evento, mappa effettiva (predefiniti + personalizzazioni) e conflitti.
 * Modulo puro: nessun DOM, nessun socket.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const path = require('path');

module.exports = (async () => {
  console.log('  --- Scorciatoie da tastiera (catalogo e combinazioni) ---');
  const { pathToFileURL } = require('url');
  const m = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'scorciatoie.js')).href);

  /* --------------------------- normalizzaCombo --------------------------- */

  const f = m.normalizzaCombo('Ctrl+Shift+F');
  assert.deepStrictEqual(f, { ctrl: true, alt: false, shift: true, meta: false, tasto: 'f' });

  // Alias accettati: Control, CmdOrCtrl, Option, Cmd.
  assert.strictEqual(m.normalizzaCombo('Control+Alt+Canc'), null); // "canc" non è un tasto noto
  assert.strictEqual(m.normalizzaCombo('control+k')?.tasto, 'k');
  assert.strictEqual(m.normalizzaCombo('CmdOrCtrl+p')?.ctrl, true);
  assert.strictEqual(m.normalizzaCombo('Meta+Enter')?.meta, true);
  assert.strictEqual(m.normalizzaCombo('Meta+Enter')?.tasto, 'enter');

  // Forme rifiutate: vuote, solo modificatori, due tasti principali, sparute.
  assert.strictEqual(m.normalizzaCombo(''), null);
  assert.strictEqual(m.normalizzaCombo('Ctrl'), null);
  assert.strictEqual(m.normalizzaCombo('Ctrl+Shift'), null);
  assert.strictEqual(m.normalizzaCombo('Ctrl+F+G'), null);
  assert.strictEqual(m.normalizzaCombo(null), null);
  assert.strictEqual(m.normalizzaCombo(42), null);
  console.log('  ✓ normalizzaCombo: forme valide accettate, sensate rifiutate');

  /* --------------------------- comboDaEvento ----------------------------- */

  const ev = { key: 'F', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
  assert.ok(m.stessaCombo(m.comboDaEvento(ev), m.normalizzaCombo('Ctrl+Shift+F')));

  // I modificatori DA SOLI non producono combinazioni: il keydown di Shift
  // da solo non deve mai attivare una scorciatoia.
  assert.strictEqual(m.comboDaEvento({ key: 'Shift', shiftKey: true }), null);
  assert.strictEqual(m.comboDaEvento(null), null);
  console.log('  ✓ comboDaEvento/stessaCombo: eventi e testo si incontrano al centro');

  /* ---------------------------- etichettaCombo --------------------------- */

  assert.strictEqual(m.etichettaCombo(m.normalizzaCombo('ctrl+shift+f')), 'Ctrl+Shift+F');
  assert.strictEqual(m.etichettaCombo(m.normalizzaCombo('alt+ ')), '', 'solo modificatori: nessuna combinazione');
  assert.strictEqual(m.etichettaCombo(null), '');
  console.log('  ✓ etichettaCombo: testo canonico per l\'interfaccia');

  /* --------------------------- azioneDi / mappa -------------------------- */

  const evento = (key, over = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over });
  // La mappa accetta sia la forma normalizzata sia il testo grezzo.
  const mappa = { formattaJson: 'Ctrl+Shift+F', minificaJson: { ctrl: true, shift: true, tasto: 'm' } };
  assert.strictEqual(m.azioneDi(evento('f', { ctrlKey: true, shiftKey: true }), mappa), 'formattaJson');
  assert.strictEqual(m.azioneDi(evento('m', { ctrlKey: true, shiftKey: true }), mappa), 'minificaJson');
  assert.strictEqual(m.azioneDi(evento('f', { ctrlKey: true }), mappa), null, 'senza Shift non matcha');
  assert.strictEqual(m.azioneDi(evento('x'), mappa), null);
  assert.strictEqual(m.azioneDi(evento('f'), null), null);
  console.log('  ✓ azioneDi: testo grezzo e forma normalizzata nella stessa mappa');

  /* ---------------------------- mappaEffettiva --------------------------- */

  // Senza personalizzazioni: i predefiniti del catalogo.
  const base = m.mappaEffettiva(null);
  assert.ok(Object.keys(base.mappa).length >= m.CATALOGO.length || base.mappa.formattaJson);
  assert.strictEqual(base.errori.length, 0);

  // Personalizzazione valida sostituisce; quella rotta viene scartata DICHIARATA.
  const mista = m.mappaEffettiva({ formattaJson: 'Ctrl+R', azioneInesistente: 'Ctrl+K', minificaJson: 'solo+tasti' });
  assert.strictEqual(m.etichettaCombo(mista.mappa.formattaJson), 'Ctrl+R');
  assert.ok(mista.errori.some((e) => /Azione sconosciuta/.test(e)), 'voce sconosciuta dichiarata');
  assert.ok(mista.errori.some((e) => /non valida/.test(e)), 'combinazione rotta dichiarata');

  // Conflitto: due azioni sulla stessa combinazione — dichiarato, non silenzioso.
  const conflitto = m.mappaEffettiva({ formattaJson: 'Ctrl+K', minificaJson: 'Ctrl+K' });
  assert.ok(conflitto.errori.some((e) => /Conflitto/.test(e)));
  console.log('  ✓ mappaEffettiva: predefiniti, scarti e conflitti dichiarati');

  /* -------------------- mappa attiva (cache sincrona) -------------------- */

  assert.strictEqual(m.azioneDiEvento(evento('f', { ctrlKey: true, shiftKey: true })), 'formattaJson',
    'i predefiniti funzionano PRIMA che le preferenze arrivino dal server');
  m.impostaMappaAttiva({ formattaJson: { ctrl: true, tasto: 'r' } });
  assert.strictEqual(m.azioneDiEvento(evento('r', { ctrlKey: true })), 'formattaJson');
  assert.strictEqual(m.azioneDiEvento(evento('f', { ctrlKey: true, shiftKey: true })), null,
    'la vecchia combinazione smette di rispondere subito');
  m.impostaMappaAttiva(base.mappa); // ripristino per gli altri consumatori del processo
  console.log('  ✓ mappa attiva: seminata coi predefiniti, sostituibile a caldo');

  /* ------------------ Le tre scorciatoie globali dell'app ----------------- */

  for (const [id, combo] of [['sidebarConnessioni', 'ctrl+b'], ['chiudiScheda', 'ctrl+w'], ['paletteComandi', 'ctrl+p']]) {
    const voce = m.CATALOGO.find((a) => a.id === id);
    assert.ok(voce, `il catalogo contiene "${id}"`);
    assert.strictEqual(m.etichettaCombo(m.normalizzaCombo(voce.predefinito)).toLowerCase(), combo,
      `il predefinito di "${id}" è ${combo.toUpperCase()}`);
    assert.strictEqual(m.azioneDiEvento(evento(combo.slice(-1), { ctrlKey: true }), base.mappa), id,
      `"${id}" risponde alla sua combinazione`);
  }
  // Nessuna collisione con le azioni JSON: Ctrl+Shift+F/M restano loro.
  assert.notStrictEqual(m.azioneDiEvento(evento('f', { ctrlKey: true, shiftKey: true }), base.mappa), 'chiudiScheda');
  console.log('  ✓ scorciatoie globali: Ctrl+B / Ctrl+W / Ctrl+P nel catalogo, senza collisioni');

  console.log('  --- Scorciatoie da tastiera: tutti i test superati ---');
})();

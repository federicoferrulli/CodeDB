'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari dello strato puro dei temi (public/js/theme-colori.js).
 * Nessun database, nessun browser: il modulo non importa nulla proprio per
 * essere provabile qui.
 *
 * Cosa vale la pena verificare, perché sbagliato NON si vede:
 *   1. le conversioni di colore — un errore di arrotondamento non rompe nulla,
 *      sposta solo una tinta di un paio di punti, e non se ne accorge nessuno;
 *   2. il CONTRASTO — è l'unica cosa che distingue un tema personalizzato
 *      brutto da uno inutilizzabile, e a occhio non si stima;
 *   3. il VERSO delle derivazioni — su un tema chiaro le superfici sollevate
 *      devono scurirsi, su uno scuro schiarirsi: invertirlo dà un tema che
 *      sembra funzionare finché non ci si accorge che i menu spariscono;
 *   4. la validazione — un id o un colore che finiscono in un selettore CSS
 *      sono un'iniezione nel foglio di stile, e un tema si IMPORTA da file;
 *   5. la tolleranza ai dati corrotti — un tema illeggibile in localStorage
 *      non deve impedire l'avvio, solo non essere applicato.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

console.log('--- Test Unitari Temi ---');

(async () => {
  const T = await import('../public/js/theme-colori.js');

  /* ----------------------------- conversioni ----------------------------- */

  assert.deepStrictEqual(T.leggiHex('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepStrictEqual(T.leggiHex('#000000'), { r: 0, g: 0, b: 0, a: 1 });
  assert.deepStrictEqual(T.leggiHex('6366f1'), { r: 99, g: 102, b: 241, a: 1 }, 'senza cancelletto');
  assert.strictEqual(T.leggiHex('#6366f180').a, 128 / 255, 'alfa esadecimale');
  assert.strictEqual(T.leggiHex('rosso'), null);
  assert.strictEqual(T.leggiHex('#12345'), null, 'lunghezza non valida');
  assert.strictEqual(T.leggiHex(null), null);
  assert.strictEqual(T.leggiHex(42), null);
  console.log('  OK   leggiHex');

  assert.strictEqual(T.scriviHex({ r: 99, g: 102, b: 241 }), '#6366f1');
  assert.strictEqual(T.scriviHex({ r: 0, g: 0, b: 0 }), '#000000', 'zeri riempiti');
  assert.strictEqual(T.scriviHex({ r: 300, g: -5, b: 128 }), '#ff0080', 'valori fuori scala limitati');
  console.log('  OK   scriviHex');

  // L'alfa va arrotondata: senza, una derivazione stampa 0.12000000000000001.
  assert.strictEqual(T.rgba({ r: 1, g: 2, b: 3 }, 0.1 + 0.02), 'rgba(1, 2, 3, 0.12)');
  assert.strictEqual(T.rgba({ r: 1, g: 2, b: 3 }, 5), 'rgba(1, 2, 3, 1)', 'alfa limitata');
  console.log('  OK   rgba');

  // Andata e ritorno HSL: la tinta non deve derivare.
  for (const hex of ['#6366f1', '#0d1117', '#86efac', '#ffffff', '#000000', '#7f7f7f']) {
    const rgb = T.leggiHex(hex);
    const giro = T.scriviHex(T.daHsl(T.versoHsl(rgb)));
    assert.strictEqual(giro, hex, `andata e ritorno HSL per ${hex}`);
  }
  console.log('  OK   versoHsl / daHsl (andata e ritorno)');

  /* ------------------------------ contrasto ------------------------------ */

  const nero = { r: 0, g: 0, b: 0 }, bianco = { r: 255, g: 255, b: 255 };
  assert.strictEqual(Math.round(T.contrasto(nero, bianco)), 21, 'nero/bianco = 21:1');
  assert.strictEqual(T.contrasto(nero, nero), 1, 'identici = 1:1');
  // Simmetria: l'ordine degli argomenti non conta.
  assert.strictEqual(T.contrasto(nero, bianco), T.contrasto(bianco, nero));
  // Valori noti della palette scura: il testo principale sullo sfondo deve
  // superare la soglia del testo normale.
  const contrastoTesto = T.contrasto(T.leggiHex('#e2e8f0'), T.leggiHex('#0d1117'));
  assert.ok(contrastoTesto >= T.SOGLIA_TESTO, `tema scuro: testo su sfondo = ${contrastoTesto.toFixed(1)}:1`);
  console.log(`  OK   contrasto (tema scuro, testo su sfondo: ${contrastoTesto.toFixed(1)}:1)`);

  // Lo stesso per il tema chiaro: è la verifica che il chiaro non sia stato
  // scritto "a occhio".
  const contrastoChiaro = T.contrasto(T.leggiHex('#1f2937'), T.leggiHex('#ffffff'));
  assert.ok(contrastoChiaro >= T.SOGLIA_TESTO, `tema chiaro: testo su sfondo = ${contrastoChiaro.toFixed(1)}:1`);
  console.log(`  OK   contrasto (tema chiaro, testo su sfondo: ${contrastoChiaro.toFixed(1)}:1)`);

  // testoSu: sceglie il colore leggibile, non uno fisso — ma a parità
  // sostanziale preferisce il bianco, che è la scelta di tutta l'interfaccia.
  assert.strictEqual(T.scriviHex(T.testoSu(T.leggiHex('#fbbf24'))), '#000000', 'nero sull\'ambra');
  assert.strictEqual(T.scriviHex(T.testoSu(T.leggiHex('#86efac'))), '#000000', 'nero sul verde chiaro');
  assert.strictEqual(T.scriviHex(T.testoSu(T.leggiHex('#ffffff'))), '#000000', 'nero sul bianco');
  assert.strictEqual(T.scriviHex(T.testoSu(T.leggiHex('#4338ca'))), '#ffffff', 'bianco sull\'indaco profondo');
  assert.strictEqual(T.scriviHex(T.testoSu(T.leggiHex('#000000'))), '#ffffff', 'bianco sul nero');
  // Il caso limite che motiva la tolleranza: sull'indaco predefinito il nero
  // vince di un soffio (4,70 contro 4,46) ma il pulsante primario ha il testo
  // bianco in tutta l'applicazione.
  const indaco = T.leggiHex('#6366f1');
  assert.ok(T.contrasto(indaco, { r: 0, g: 0, b: 0 }) > T.contrasto(indaco, { r: 255, g: 255, b: 255 }),
    'presupposto del caso limite: sull\'indaco il nero misura di più');
  assert.strictEqual(T.scriviHex(T.testoSu(indaco)), '#ffffff',
    'a parità sostanziale deve restare il bianco');
  console.log('  OK   testoSu (con la tolleranza sul bianco)');

  /* ----------------------------- derivazione ----------------------------- */

  const scuro = T.scelteIniziali('dark');
  const chiaro = T.scelteIniziali('light');
  const tScuro = T.derivaTokens(scuro, 'dark');
  const tChiaro = T.derivaTokens(chiaro, 'light');

  assert.strictEqual(tScuro['--bg'], '#0d1117');
  assert.strictEqual(tScuro['--accent'], '#6366f1');

  // Il VERSO: su tema scuro una superficie sollevata è più CHIARA dello
  // sfondo, su tema chiaro più SCURA. È l'errore che rende invisibili i menu.
  const lum = (hex) => T.luminanza(T.leggiHex(hex));
  assert.ok(lum(tScuro['--bg-elevated']) > lum(tScuro['--bg']),
    'tema scuro: la superficie sollevata deve schiarire');
  assert.ok(lum(tChiaro['--bg-elevated']) < lum(tChiaro['--bg']),
    'tema chiaro: la superficie sollevata deve scurire');
  console.log('  OK   derivaTokens: verso delle superfici');

  // Il testo secondario si avvicina allo sfondo in entrambi i versi.
  assert.ok(lum(tScuro['--fg-dim']) < lum(tScuro['--fg']),
    'tema scuro: il testo secondario si spegne');
  assert.ok(lum(tChiaro['--fg-dim']) > lum(tChiaro['--fg']),
    'tema chiaro: il testo secondario si schiarisce');
  console.log('  OK   derivaTokens: verso del testo');

  // Il testo sopra l'accento si calcola: con un accento giallo diventa nero.
  const giallo = T.derivaTokens({ ...scuro, accent: '#fbbf24' }, 'dark');
  assert.strictEqual(giallo['--on-accent'], '#000000',
    'accento giallo: il testo sopra deve diventare nero, non restare bianco');
  assert.strictEqual(tScuro['--on-accent'], '#ffffff', 'accento indaco: testo bianco');
  console.log('  OK   derivaTokens: testo sopra l\'accento');

  // Spostare l'accento porta con sé tutta la sua famiglia: se restasse
  // indietro si otterrebbe un tema verde con la selezione indaco.
  const verde = T.derivaTokens({ ...scuro, accent: '#22c55e' }, 'dark');
  for (const tok of ['--sel', '--focus', '--border-focus', '--accent-glow', '--accent-line', '--accent-veil', '--scrollbar-thumb']) {
    assert.ok(verde[tok] && verde[tok] !== tScuro[tok], `${tok} deve seguire l'accento`);
  }
  assert.ok(verde['--sel'].startsWith('rgba(34, 197, 94'), 'la selezione prende la tinta dell\'accento');
  console.log('  OK   derivaTokens: la famiglia dell\'accento segue');

  // Ogni valore prodotto dev'essere un colore CSS valido, mai `NaN` o
  // `undefined` che il browser scarterebbe in silenzio lasciando il token
  // ereditato — cioè un tema che sembra applicato a metà.
  const valido = /^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\)|0 0 \d+px rgba\(\d+, \d+, \d+, [\d.]+\))$/;
  for (const [k, v] of Object.entries({ ...tScuro, ...tChiaro })) {
    assert.ok(valido.test(v), `token ${k} ha un valore non valido: ${v}`);
  }
  console.log(`  OK   derivaTokens: ${Object.keys(tScuro).length} token, tutti valori CSS validi`);

  // Colori mancanti: si deriva quello che si può, senza lanciare.
  const parziale = T.derivaTokens({ bg: '#101010' }, 'dark');
  assert.strictEqual(parziale['--bg'], '#101010');
  assert.strictEqual(parziale['--accent'], undefined, 'niente accento, niente famiglia dell\'accento');
  console.log('  OK   derivaTokens: scelte parziali');

  /* ------------------------------ diagnostica ----------------------------- */

  assert.deepStrictEqual(T.diagnostica(scuro), [], 'la palette scura predefinita non ha avvisi');
  assert.deepStrictEqual(T.diagnostica(chiaro), [], 'la palette chiara predefinita non ha avvisi');

  // Grigio su grigio: illeggibile, e va detto prima del salvataggio.
  const brutto = T.diagnostica({ ...scuro, bg: '#333333', fg: '#3a3a3a' });
  assert.ok(brutto.some((a) => a.campo === 'fg'), 'il testo a contrasto nullo va segnalato');
  assert.ok(brutto[0].messaggio.includes('difficile da leggere'));
  assert.ok(brutto[0].rapporto < T.SOGLIA_TESTO);
  console.log(`  OK   diagnostica (${brutto.length} avvisi sul tema illeggibile)`);

  /* ------------------------------ validazione ----------------------------- */

  const buono = T.validaTema({ id: 'mio-tema', nome: 'Il mio tema', base: 'light', scelte: chiaro });
  assert.ok(buono.ok);
  assert.strictEqual(buono.tema.id, 'mio-tema');
  assert.strictEqual(buono.tema.base, 'light');

  // Un id che finisce in un selettore CSS: se passasse, un tema importato
  // diventerebbe codice iniettato nel foglio di stile.
  for (const cattivo of ['"] {} :root{--bg:red}', 'a b', 'con"apice', "con'apice", '', '../x', 'a'.repeat(80)]) {
    const r = T.validaTema({ id: cattivo, scelte: chiaro });
    assert.strictEqual(r.ok, false, `id non valido accettato: ${JSON.stringify(cattivo)}`);
  }
  console.log('  OK   validaTema: identificativi pericolosi rifiutati');

  // Stessa ragione per i colori: `red; } :root{…` è un valore CSS scrivibile.
  const iniezione = T.validaTema({ id: 'x', scelte: { ...chiaro, accent: 'red; } :root { --bg: red' } });
  assert.strictEqual(iniezione.ok, false, 'valore colore non esadecimale accettato');
  console.log('  OK   validaTema: valori colore non esadecimali rifiutati');

  // I temi predefiniti non si sovrascrivono.
  for (const id of ['dark', 'light', 'auto']) {
    assert.strictEqual(T.validaTema({ id, scelte: chiaro }).ok, false, `"${id}" non deve essere sovrascrivibile`);
  }
  console.log('  OK   validaTema: i temi predefiniti sono protetti');

  // Dati mancanti o corrotti: si ripiega sui valori di partenza, non si lancia.
  const monco = T.validaTema({ id: 'monco' });
  assert.ok(monco.ok, 'un tema senza scelte deve essere accettato coi valori di partenza');
  assert.strictEqual(monco.tema.scelte.bg, T.scelteIniziali('dark').bg);
  assert.strictEqual(monco.tema.nome, 'monco', 'senza nome si usa l\'id');
  for (const spazzatura of [null, undefined, 42, 'stringa', []]) {
    assert.strictEqual(T.validaTema(spazzatura).ok, false);
  }
  console.log('  OK   validaTema: dati mancanti e corrotti');

  /* --------------------------------- CSS ---------------------------------- */

  const css = T.cssDelTema(buono.tema);
  assert.ok(css.startsWith(':root[data-theme-custom="mio-tema"] {'));
  assert.ok(css.includes('--bg:'), 'il CSS deve contenere i token');
  assert.ok(css.trim().endsWith('}'));
  // Il CSS generato non deve poter chiudere la propria regola.
  assert.strictEqual((css.match(/\{/g) || []).length, 1, 'una sola graffa aperta');
  assert.strictEqual((css.match(/\}/g) || []).length, 1, 'una sola graffa chiusa');
  console.log('  OK   cssDelTema');

  assert.strictEqual(T.nomeFile({ nome: 'Il Mio Tema!' }), 'codedb-tema-il-mio-tema.json');
  assert.strictEqual(T.nomeFile({ nome: '', id: 'x' }), 'codedb-tema-x.json');
  assert.strictEqual(T.nomeFile({ nome: '!!!', id: 'y' }), 'codedb-tema-tema.json', 'nome tutto scartato');
  console.log('  OK   nomeFile');

  console.log('--- Test Temi superati ---');
})().catch((err) => {
  console.error('FALLITO:', err && err.message);
  console.error(err);
  process.exitCode = 1;
});

'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari delle decisioni del diagramma UML (public/js/uml-modello.js).
 * Nessun browser, nessun JointJS, nessun database: il modulo non importa nulla
 * proprio per essere provabile qui.
 *
 * Che cosa vale la pena verificare, perché sbagliato NON si vede — il
 * diagramma si disegna lo stesso, con l'aria di essere giusto:
 *
 *   1. L'IDENTITÀ non fonde due oggetti omonimi di schemi diversi, e non è
 *      ambigua quando un nome contiene un punto. Fuse, `vendite.ordini` e
 *      `storico.ordini` diventano un nodo solo con le relazioni di entrambe.
 *   2. UNA FK COMPOSTA È UN COLLEGAMENTO SOLO. Quattro frecce fra gli stessi
 *      due nodi dicono «quattro chiavi esterne», che è un'altra cosa — e il
 *      filtro delle righe collegate userebbe una coppia su quattro.
 *   3. UNA PAGINA DI SCHEMA NON DECLASSA quella precedente: una seconda
 *      lettura con un tetto di campi più basso toglierebbe colonne già
 *      caricate senza che nulla lo segnali.
 *   4. LA DISPOSIZIONE non sposta i nodi bloccati e sopravvive ai cicli.
 *   5. L'ANNULLAMENTO è per gesto e simmetrico.
 *   6. L'IMPORT ricostruisce, non adotta: niente tipi arbitrari, niente
 *      coordinate non finite, niente relazioni verso elementi assenti.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

console.log('--- Test Unitari Modello UML ---');

module.exports = (async () => {
  const M = await import('../public/js/uml-modello.js');

  /* --- 1. Identità -------------------------------------------------------- */
  {
    const a = M.chiaveOggetto({ conn: 'c1', db: 'vendite', nome: 'ordini' });
    const b = M.chiaveOggetto({ conn: 'c1', db: 'storico', nome: 'ordini' });
    assert.notStrictEqual(a, b, 'due schemi diversi devono dare due identità diverse');

    // L'ambiguità che una concatenazione con punti non saprebbe evitare:
    // schema "a.b" + tabella "c" contro schema "a" + tabella "b.c".
    const uno = M.chiaveOggetto({ conn: '', db: 'a.b', nome: 'c' });
    const due = M.chiaveOggetto({ conn: '', db: 'a', nome: 'b.c' });
    assert.notStrictEqual(uno, due, 'i punti nei nomi non devono rendere due identità uguali');

    assert.deepStrictEqual(M.leggiChiave(a), { conn: 'c1', db: 'vendite', tipo: 'tabella', nome: 'ordini' });
    assert.strictEqual(M.leggiChiave('non-json'), null);
    assert.strictEqual(M.leggiChiave('[1,2,3,4]'), null, 'una tupla di non-stringhe non è una nostra chiave');
    console.log('  ✓ identità: schema, punti nei nomi, andata e ritorno');
  }

  /* --- 2. Collegamenti: FK composta, FK multiple, auto-riferimento -------- */
  {
    const schema = {
      relations: [
        // FK composta su due colonne: UN vincolo.
        { from: 'righe', field: 'ordine_id', to: 'ordini', toField: 'id', constraint: 'fk_riga_ordine', ordine: 1, origine: 'vincolo', many: true },
        { from: 'righe', field: 'ordine_anno', to: 'ordini', toField: 'anno', constraint: 'fk_riga_ordine', ordine: 2, origine: 'vincolo', many: true },
        // Seconda FK, stessi due nodi: vincolo diverso, collegamento diverso.
        { from: 'righe', field: 'ordine_orig', to: 'ordini', toField: 'id', constraint: 'fk_riga_origine', ordine: 1, origine: 'vincolo', many: true },
        // Auto-riferimento.
        { from: 'dipendenti', field: 'capo_id', to: 'dipendenti', toField: 'id', constraint: 'fk_capo', ordine: 1, origine: 'vincolo' },
        // Ipotesi: nessun vincolo.
        { from: 'note', field: 'utente_id', to: 'utenti', many: false },
      ],
    };
    const links = M.collegamenti(schema, { conn: 'c1', db: 'shop' });
    assert.strictEqual(links.length, 4, 'due FK + auto-riferimento + ipotesi = quattro collegamenti');

    const composta = links.find((l) => l.nome === 'fk_riga_ordine');
    assert.strictEqual(composta.composta, true);
    assert.deepStrictEqual(composta.coppie.map((p) => [p.campo, p.colonna]),
      [['ordine_id', 'id'], ['ordine_anno', 'anno']], 'le coppie restano tutte e ORDINATE');
    assert.strictEqual(composta.origine, M.VINCOLO);

    const auto = links.find((l) => l.nome === 'fk_capo');
    assert.strictEqual(auto.auto, true, 'un auto-riferimento va dichiarato tale');
    assert.strictEqual(auto.da, auto.a);

    const ipotesi = links.find((l) => l.daNome === 'note');
    assert.strictEqual(ipotesi.origine, M.RILEVATA, 'senza vincolo resta un’ipotesi');
    assert.strictEqual(ipotesi.coppie[0].colonna, null, 'un’ipotesi non inventa la colonna di destinazione');

    // L'ordine di arrivo delle righe non decide l'ordine delle coppie.
    const invertito = M.collegamenti({ relations: [schema.relations[1], schema.relations[0]] }, {});
    assert.deepStrictEqual(invertito[0].coppie.map((p) => p.campo), ['ordine_id', 'ordine_anno']);
    console.log('  ✓ collegamenti: FK composta unica, FK parallele distinte, auto-riferimento, ipotesi');
  }

  /* --- 3. Le pagine si uniscono senza declassare -------------------------- */
  {
    const prima = {
      collections: [{ name: 'ordini', fields: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], fieldsPage: { complete: true } }],
      relations: [{ from: 'ordini', field: 'cliente_id', to: 'clienti', constraint: 'fk1' }],
    };
    const seconda = {
      collections: [
        { name: 'ordini', fields: [{ name: 'a' }], fieldsPage: { complete: false } },
        { name: 'clienti', fields: [{ name: 'id' }] },
      ],
      relations: [{ from: 'clienti', field: 'agente_id', to: 'agenti' }],
    };
    const unito = M.unisciSchema(prima, seconda);
    const ordini = unito.collections.find((c) => c.name === 'ordini');
    assert.strictEqual(ordini.fields.length, 3, 'una pagina più povera non toglie campi già caricati');
    assert.strictEqual(ordini.fieldsPage.complete, true, 'e non declassa nemmeno la dichiarazione di completezza');
    assert.strictEqual(unito.collections.length, 2, 'le collection nuove si aggiungono');
    assert.strictEqual(unito.relations.length, 2, 'le relazioni si uniscono per identità, senza duplicare');

    const ancora = M.unisciSchema(unito, seconda);
    assert.strictEqual(ancora.relations.length, 2, 'rileggere la stessa pagina non moltiplica le relazioni');

    // La pagina SUCCESSIVA dei campi: con i cursori indipendenti porta le
    // colonne dopo il tetto, e devono ACCODARSI a quelle già lette.
    const pagina1 = {
      collections: [{ name: 'larga', fields: [{ name: 'c0' }, { name: 'c1' }], fieldsPage: { total: 4, cursor: 0, nextCursor: 2, complete: false } }],
      relations: [],
    };
    const pagina2 = {
      collections: [{ name: 'larga', fields: [{ name: 'c2' }, { name: 'c3' }], fieldsPage: { total: 4, cursor: 2, nextCursor: null, complete: true } }],
      relations: [],
    };
    const campi = M.unisciSchema(pagina1, pagina2).collections[0];
    assert.deepStrictEqual(campi.fields.map((f) => f.name), ['c0', 'c1', 'c2', 'c3'],
      'la pagina successiva dei campi si accoda, nell’ordine, senza sostituire la prima');
    assert.strictEqual(campi.fieldsPage.complete, true, 'ed è la pagina più avanti a dichiarare la completezza');

    // Rimandare la PRIMA pagina non duplica nulla e non fa arretrare lo stato.
    const ripetuta = M.unisciSchema(M.unisciSchema(pagina1, pagina2), pagina1).collections[0];
    assert.strictEqual(ripetuta.fields.length, 4, 'una pagina ripetuta non duplica le colonne');
    assert.strictEqual(ripetuta.fieldsPage.complete, true, 'e non fa arretrare la completezza già dichiarata');
    console.log('  ✓ unione delle pagine: accodamento dei campi, nessun declassamento, nessun duplicato');
  }

  /* --- 4. Disposizione ---------------------------------------------------- */
  {
    const k = (n) => M.chiaveOggetto({ db: 'd', nome: n });
    const chiavi = ['a', 'b', 'c'].map(k);
    const links = [
      { da: k('a'), a: k('b') },
      { da: k('b'), a: k('c') },
    ];
    const pos = M.disposizione(chiavi, links, {});
    assert.strictEqual(pos.size, 3);
    assert.ok(pos.get(k('a')).x < pos.get(k('b')).x, 'chi riferisce sta in una colonna prima di chi è riferito');
    assert.ok(pos.get(k('b')).x < pos.get(k('c')).x);

    const bloccati = new Set([k('b')]);
    const conBlocco = M.disposizione(chiavi, links, { bloccati });
    assert.strictEqual(conBlocco.has(k('b')), false, 'un nodo bloccato non riceve una posizione nuova');

    // Ciclo puro: la visita non deve né sfuggire né lasciare nodi senza posto.
    const ciclo = [{ da: k('a'), a: k('b') }, { da: k('b'), a: k('a') }];
    const posCiclo = M.disposizione([k('a'), k('b')], ciclo, {});
    assert.strictEqual(posCiclo.size, 2, 'anche in un ciclo ogni nodo riceve una posizione');
    console.log('  ✓ disposizione: livelli, nodi bloccati, cicli');
  }

  /* --- 5. Cronologia ------------------------------------------------------ */
  {
    const storia = new M.Cronologia(3);
    const doc = M.documentoVuoto('x');
    assert.strictEqual(storia.puoAnnullare, false);

    storia.segna(doc);
    const dopo = M.clona(doc);
    dopo.note.push({ id: 'n1', x: 0, y: 0, testo: 'ciao' });
    assert.strictEqual(storia.puoAnnullare, true);

    const indietro = storia.annulla(dopo);
    assert.strictEqual(indietro.note.length, 0, 'annullare riporta allo stato PRIMA del gesto');
    assert.strictEqual(storia.puoRipetere, true);
    const avanti = storia.ripeti(indietro);
    assert.strictEqual(avanti.note.length, 1, 'ripetere rimette il gesto');

    // Il tetto vale, e un gesto nuovo cancella il ramo "avanti".
    const s2 = new M.Cronologia(2);
    s2.segna(doc); s2.segna(doc); s2.segna(doc);
    assert.strictEqual(s2.indietro.length, 2, 'la storia non cresce oltre il tetto');
    s2.annulla(doc);
    assert.strictEqual(s2.puoRipetere, true);
    s2.segna(doc);
    assert.strictEqual(s2.puoRipetere, false, 'un gesto nuovo chiude il ramo da ripetere');

    // L'istantanea è una COPIA: modificare il documento dopo `segna` non deve
    // riscrivere la voce di storia.
    const s3 = new M.Cronologia();
    const vivo = M.documentoVuoto('v');
    s3.segna(vivo);
    vivo.note.push({ id: 'n', x: 1, y: 1, testo: 'dopo' });
    assert.strictEqual(s3.annulla(vivo).note.length, 0, 'la storia non condivide la memoria del documento');
    console.log('  ✓ cronologia: un gesto una voce, tetto, ramo avanti, copia profonda');
  }

  /* --- 6. Import: si ricostruisce, non si adotta -------------------------- */
  {
    const chiaveBuona = M.chiaveOggetto({ conn: 'c', db: 'd', nome: 't' });
    const { doc, avvisi } = M.validaDocumento({
      versione: 1,
      nome: 'Mio',
      nodi: {
        [chiaveBuona]: { x: 10, y: 20, bloccato: true, tipoJoint: 'standard.Rectangle', onclick: 'alert(1)' },
        'chiave-inventata': { x: 0, y: 0 },
      },
      note: [{ id: 'n1', x: Infinity, y: NaN, w: 1e12, testo: '<script>alert(1)</script>' }],
      entita: [{ id: 'e1', nome: 'progetto', x: 5, y: 5, campi: [{ nome: 'id', tipo: 'int' }, { tipo: 'senza nome' }] }],
      logiche: [
        { id: 'l1', da: chiaveBuona, a: 'e1', cardinalita: 'inventata' },
        { id: 'l2', da: chiaveBuona, a: 'assente' },
      ],
    });

    assert.deepStrictEqual(Object.keys(doc.nodi), [chiaveBuona], 'una chiave che non è delle nostre viene scartata');
    assert.deepStrictEqual(Object.keys(doc.nodi[chiaveBuona]).sort(), ['bloccato', 'compresso', 'x', 'y'],
      'del nodo sopravvivono SOLO i campi ammessi: nessun tipo JointJS, nessun gestore');
    // Infinito e NaN non sono coordinate: ricadono su zero, non su un numero
    // enorme. Un valore FINITO ma assurdo viene invece riportato nel limite.
    assert.strictEqual(doc.note[0].x, 0, 'una coordinata infinita non entra nel documento');
    assert.strictEqual(doc.note[0].y, 0, 'NaN diventa zero, non NaN');
    assert.strictEqual(doc.note[0].w, 200000, 'una misura finita ma assurda viene riportata nel limite');
    // Il testo resta testo: non viene interpretato qui, e chi lo disegna lo
    // mette in un nodo SVG di testo, mai in innerHTML.
    assert.strictEqual(typeof doc.note[0].testo, 'string');
    assert.strictEqual(doc.entita[0].campi.length, 1, 'un campo senza nome non è un campo');
    assert.strictEqual(doc.logiche.length, 1, 'una relazione verso un elemento assente viene rifiutata');
    assert.strictEqual(doc.logiche[0].cardinalita, '1-N', 'una cardinalità inventata ricade sul predefinito');
    assert.ok(avvisi.length >= 2, 'ciò che è stato scartato viene DICHIARATO');

    // Un file che non è un documento non produce un documento a metà.
    const niente = M.validaDocumento('[]');
    assert.strictEqual(Object.keys(niente.doc.nodi).length, 0);
    assert.strictEqual(niente.avvisi.length, 1);

    // Tetto sugli elementi.
    const molti = { versione: 1, note: [] };
    for (let i = 0; i < M.MAX_ELEMENTI_IMPORT + 10; i++) molti.note.push({ id: `n${i}`, x: 0, y: 0, testo: 'x' });
    const troncato = M.validaDocumento(molti);
    assert.strictEqual(troncato.doc.note.length, M.MAX_ELEMENTI_IMPORT);
    assert.ok(troncato.avvisi.some((a) => a.includes(String(M.MAX_ELEMENTI_IMPORT))), 'il troncamento viene dichiarato');
    console.log('  ✓ import: campi ammessi, coordinate, riferimenti assenti, tetto, avvisi');
  }

  /* --- 7. Riconciliazione ------------------------------------------------- */
  {
    const k = (n) => M.chiaveOggetto({ db: 'd', nome: n });
    const doc = M.documentoVuoto();
    doc.nodi[k('a')] = { x: 0, y: 0 };
    doc.nodi[k('sparita')] = { x: 0, y: 0 };
    const { irrisolti, nuovi } = M.riconcilia(doc, [k('a'), k('b')]);
    assert.deepStrictEqual(irrisolti, [k('sparita')], 'un oggetto sparito resta nel documento, dichiarato non risolto');
    assert.deepStrictEqual(nuovi, [k('b')]);
    console.log('  ✓ riconciliazione: nulla sparisce in silenzio');
  }

  /* --- 8. Allineamento ---------------------------------------------------- */
  {
    // Bordo del gruppo: sinistra 0, destra 400, alto 0, basso 250.
    // Il bloccato partecipa al bordo ma non si muove.
    const riquadri = () => [
      { chiave: 'a', x: 0, y: 0, w: 100, h: 50 },
      { chiave: 'b', x: 50, y: 200, w: 200, h: 50 },
      { chiave: 'c', x: 300, y: 10, w: 100, h: 100, bloccato: true },
    ];
    assert.deepStrictEqual([...M.allinea(riquadri(), 'sinistra')], [['b', { x: 0, y: 200 }]]);
    assert.deepStrictEqual([...M.allinea(riquadri(), 'destra')].sort(),
      [['a', { x: 300, y: 0 }], ['b', { x: 200, y: 200 }]].sort());
    assert.deepStrictEqual([...M.allinea(riquadri(), 'centroX')].sort(),
      [['a', { x: 150, y: 0 }], ['b', { x: 100, y: 200 }]].sort());
    assert.deepStrictEqual([...M.allinea(riquadri(), 'alto')], [['b', { x: 50, y: 0 }]]);
    assert.deepStrictEqual([...M.allinea(riquadri(), 'basso')], [['a', { x: 0, y: 200 }]],
      'chi è già sul bordo non compare nella mappa');
    assert.deepStrictEqual([...M.allinea(riquadri(), 'centroY')].sort(),
      [['a', { x: 0, y: 100 }], ['b', { x: 50, y: 100 }]].sort());
    // Chi è già al suo posto non compare: la voce di storia resta pulita.
    assert.strictEqual(M.allinea(riquadri(), 'sinistra').has('a'), false);
    assert.strictEqual(M.allinea([{ chiave: 'solo', x: 1, y: 1, w: 1, h: 1 }], 'sinistra').size, 0,
      'con un solo riquadro non c’è nulla da allineare');
    assert.strictEqual(M.allinea(riquadri(), 'diagonale').size, 0, 'un modo inventato non sposta nulla');
    console.log('  ✓ allineamento: sei modi, bordo sui riquadri, bloccati fermi, mappa solo dei mossi');
  }

  /* --- 9. Distribuzione --------------------------------------------------- */
  {
    const riquadri = () => [
      { chiave: 'a', x: 0, y: 0, w: 100, h: 40 },
      { chiave: 'b', x: 150, y: 0, w: 50, h: 40 },
      { chiave: 'c', x: 400, y: 0, w: 100, h: 40 },
      { chiave: 'd', x: 600, y: 0, w: 100, h: 40 },
    ];
    // Estensione 700, occupato 350, spazio libero (700-350)/3 = 116.67.
    const mossa = M.distribuisci(riquadri(), 'x');
    assert.strictEqual(mossa.get('b').x, 217);
    assert.strictEqual(mossa.get('c').x, 384);
    assert.strictEqual(mossa.has('a'), false, 'gli estremi definiscono l’area e non si muovono');
    assert.strictEqual(mossa.has('d'), false);
    // Un medio bloccato resta dov’è ma occupa il suo spazio nel calcolo.
    const conBlocco = riquadri().map((r) => (r.chiave === 'b' ? { ...r, bloccato: true } : r));
    const mossa2 = M.distribuisci(conBlocco, 'x');
    assert.strictEqual(mossa2.has('b'), false, 'il bloccato non si muove');
    assert.strictEqual(mossa2.get('c').x, 317, 'ma lo spazio che occupa resta il suo');
    assert.strictEqual(M.distribuisci(riquadri().slice(0, 2), 'x').size, 0, 'con due riquadri non c’è un “mezzo”');
    console.log('  ✓ distribuzione: spazi uguali fra i bordi, estremi fermi, bloccati rispettati');
  }

  /* --- 10. Riscrittura dei collegamenti su gruppo compresso -------------- */
  {
    const dentro = new Map([['B', 'G'], ['C', 'G']]);
    const l1 = { id: 'l1', da: 'A', a: 'B' };
    const l2 = { id: 'l2', da: 'B', a: 'C' };
    const l3 = { id: 'l3', da: 'B', a: 'D' };
    const l4 = { id: 'l4', da: 'A', a: 'D' };
    const l5 = { id: 'l5', da: 'A', a: 'B' };
    const out = M.collegamentiCompressi([l1, l2, l3, l4, l5], dentro);
    assert.strictEqual(out.length, 4, 'il collegamento interno al gruppo sparisce, gli altri restano');
    assert.ok(!out.some((l) => l.id === 'l2'), 'un arco fra due membri non attraversa più nulla di visibile');
    assert.deepStrictEqual([out.find((l) => l.id === 'l1').da, out.find((l) => l.id === 'l1').a], ['A', 'G']);
    assert.deepStrictEqual([out.find((l) => l.id === 'l3').da, out.find((l) => l.id === 'l3').a], ['G', 'D']);
    assert.strictEqual(out.find((l) => l.id === 'l4'), l4, 'chi non tocca gruppi resta lo stesso oggetto');
    assert.strictEqual(out.filter((l) => l.da === 'A' && l.a === 'G').length, 2,
      'due relazioni diverse sulla stessa coppia restano due');
    console.log('  ✓ gruppi compressi: archi riscritti sul gruppo, interni tolti, coppie distinte conservate');
  }

  /* --- 11. Instradamenti: vertici validati, resto scartato ---------------- */
  {
    assert.deepStrictEqual(M.documentoVuoto().instradamenti, {},
      'un documento nuovo nasce senza vertici manuali');
    const chiaveBuona = M.chiaveOggetto({ conn: 'c', db: 'd', nome: 't' });
    const { doc, avvisi } = M.validaDocumento({
      versione: 1,
      nodi: { [chiaveBuona]: { x: 0, y: 0 } },
      instradamenti: {
        arco1: [{ x: 10, y: 20 }, { x: 'venti', y: NaN }, { x: 1e12, y: -1e12 }],
        rotto: 'non-un-array',
        vuoto: [],
      },
    });
    assert.deepStrictEqual(doc.instradamenti.arco1,
      [{ x: 10, y: 20 }, { x: 0, y: 0 }, { x: 200000, y: -200000 }],
      'i punti si validano uno a uno: testo e NaN valgono zero, i fuori-limite si riportano dentro');
    assert.strictEqual(doc.instradamenti.rotto, undefined, 'un instradamento che non è un elenco viene scartato');
    assert.strictEqual(doc.instradamenti.vuoto, undefined, 'un elenco senza punti validi non occupa il documento');
    assert.ok(avvisi.length >= 2, 'ogni scarto viene dichiarato');

    // La CHIAVE è dato esterno quanto il valore, e va costruita come arriva
    // davvero: `JSON.parse` (la via di `importa()`) crea `__proto__` come
    // proprietà PROPRIA, mentre un letterale `{ __proto__: … }` lo consuma
    // alla costruzione e non arriverebbe mai qui — scritto come letterale,
    // questo test passerebbe anche senza la protezione.
    const ostile = JSON.parse('{"versione":1,"instradamenti":{"__proto__":[{"x":1,"y":2}],"arco1":[{"x":9,"y":9}]}}');
    const esito = M.validaDocumento(ostile);
    assert.strictEqual(Object.getPrototypeOf(esito.doc.instradamenti), Object.prototype,
      'una chiave riservata non riassegna il prototipo del documento');
    assert.strictEqual(esito.doc.instradamenti['0'], undefined,
      'e non fa comparire vertici su un collegamento che non ne ha');
    assert.deepStrictEqual(esito.doc.instradamenti.arco1, [{ x: 9, y: 9 }],
      'l’instradamento legittimo dello stesso file resta');
    assert.ok(esito.avvisi.some((a) => /riservato/.test(a)),
      'e lo scarto viene DICHIARATO, non fatto in silenzio');
    console.log('  ✓ instradamenti: punti validati e riportati nel limite, scarti dichiarati');
  }

  /* --- 12. Gruppi annidati ------------------------------------------------ */
  {
    // Normalizzazione: sé stessi, doppi padri e cicli.
    const ciclici = [
      { id: 'A', nome: 'A', membri: ['B', 'A'], compresso: false },
      { id: 'B', nome: 'B', membri: ['A', 'x'], compresso: false },
      { id: 'C', nome: 'C', membri: ['x'], compresso: false },
    ];
    const norm = M.normalizzaGruppi(ciclici);
    const perId = new Map(norm.gruppi.map((g) => [g.id, g]));
    assert.ok(!perId.get('A').membri.includes('A'), 'un gruppo non contiene sé stesso');
    assert.ok(!(perId.get('A').membri.includes('B') && perId.get('B').membri.includes('A')),
      'un ciclo fra due gruppi viene rotto');
    assert.ok(norm.avvisi.length >= 2, 'ogni appartenenza tolta viene dichiarata');

    const doppi = [
      { id: 'P1', nome: 'P1', membri: ['x'], compresso: false },
      { id: 'P2', nome: 'P2', membri: ['x'], compresso: false },
    ];
    const nd = M.normalizzaGruppi(doppi);
    const pd = new Map(nd.gruppi.map((g) => [g.id, g]));
    assert.deepStrictEqual(pd.get('P1').membri, [], 'un figlio sta in un gruppo solo');
    assert.deepStrictEqual(pd.get('P2').membri, ['x'], 'e vince l’ultimo dell’elenco');

    // Nascondiglio: vince il compresso più esterno.
    const nested = [
      { id: 'G1', nome: 'esterno', membri: ['G2', 'a'], compresso: true },
      { id: 'G2', nome: 'interno', membri: ['b'], compresso: true },
    ];
    const nas = M.nascondiglioGruppi(nested);
    assert.strictEqual(nas.get('a'), 'G1');
    assert.strictEqual(nas.get('b'), 'G1', 'sotto due compressi si punta all’esterno, l’unico disegnato');
    assert.strictEqual(nas.get('G2'), 'G1', 'anche il segnaposto interno è coperto');
    const misto = [
      { id: 'G1', nome: 'esterno', membri: ['G2', 'a'], compresso: false },
      { id: 'G2', nome: 'interno', membri: ['b'], compresso: true },
    ];
    const nam = M.nascondiglioGruppi(misto);
    assert.strictEqual(nam.get('b'), 'G2', 'con l’esterno espanso si punta all’interno');
    assert.strictEqual(nam.has('a'), false, 'chi non è sotto un compresso resta visibile');
    assert.strictEqual(nam.has('G1'), false, 'come il gruppo esterno stesso');

    // Foglie e segnaposto attraverso i livelli.
    const doc = {
      nodi: { a: { x: 100, y: 100 }, b: { x: 300, y: 50 }, c: { x: 200, y: 400 } },
      entita: [], note: [],
      gruppi: [
        { id: 'G1', nome: 'esterno', membri: ['G2', 'a'], compresso: false },
        { id: 'G2', nome: 'interno', membri: ['b', 'fantasma'], compresso: false },
      ],
    };
    assert.deepStrictEqual(M.foglieGruppo(doc, doc.gruppi[0]).sort(), ['a', 'b'],
      'le foglie attraversano i livelli e gli id ignoti non contano');
    assert.deepStrictEqual(M.posizioneSegnaposto(doc, doc.gruppi[0]), { x: 76, y: 26 },
      'il segnaposto sta sopra le foglie di tutti i livelli');
    assert.deepStrictEqual(
      [...M.profonditaGruppi(doc.gruppi)].sort(),
      [['G1', 0], ['G2', 1]].sort(),
      'le cornici esterne stanno sotto');
    console.log('  ✓ gruppi annidati: normalizzazione, nascondiglio esterno, foglie, profondità');
  }

  /* --- 13. Stessa struttura: solo le posizioni -------------------------------- */
  {
    const base = M.documentoVuoto('d');
    base.nodi[M.chiaveOggetto({ db: 'x', nome: 'a' })] = { x: 0, y: 0, bloccato: false, compresso: true };
    base.nodi[M.chiaveOggetto({ db: 'x', nome: 'b' })] = { x: 50, y: 50, bloccato: false, compresso: true };
    const mosso = M.clona(base);
    mosso.nodi[M.chiaveOggetto({ db: 'x', nome: 'a' })].x = 999;
    assert.strictEqual(M.stessaStruttura(base, mosso), true, 'spostare non cambia la struttura');
    const aggiunto = M.clona(base);
    aggiunto.nodi[M.chiaveOggetto({ db: 'x', nome: 'c' })] = { x: 0, y: 0 };
    assert.strictEqual(M.stessaStruttura(base, aggiunto), false, 'un nodo in più è un’altra struttura');
    const compresso = M.clona(base);
    compresso.nodi[M.chiaveOggetto({ db: 'x', nome: 'a' })].compresso = false;
    assert.strictEqual(M.stessaStruttura(base, compresso), false, 'comprimere cambia la misura delle celle');
    const nota = M.clona(base);
    nota.note.push({ id: 'n', x: 1, y: 1, testo: 'ciao' });
    assert.strictEqual(M.stessaStruttura(base, nota), false, 'una nota in più è un’altra struttura');
    console.log('  ✓ stessa struttura: posizioni libere, resto vincolante');
  }

  console.log('--- Modello UML: tutti i test passati ---\n');
})();

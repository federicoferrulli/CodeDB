'use strict';

/* ---------------------------------------------------------------------------
 * Le operazioni di modifica di una geometria (public/js/geo-modifica.js).
 *
 * Sono le regole dietro i bottoni azione dell'editor su mappa: quale vertice
 * si elimina, dove entra quello nuovo, quando un'operazione va RIFIUTATA con
 * un motivo. Qui si provano senza browser, senza Leaflet e senza database —
 * sono funzioni pure.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

console.log('--- Test unitari Modifica geometrie ---');

const quadrato = () => ({
  type: 'Polygon',
  coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
});

(async () => {
  const m = await import('../public/js/geo-modifica.js');

  /* --- Nessuna operazione muta l'argomento -------------------------------- */

  const originale = quadrato();
  const impronta = JSON.stringify(originale);
  m.aggiungiVertice(originale, [5, 5]);
  m.eliminaVertice(originale, [0, 1]);
  m.inserisciVerticeDopo(originale, [0, 1]);
  assert.strictEqual(JSON.stringify(originale), impronta,
    'la geometria di partenza non viene toccata: è ciò che rende possibile annullare');
  console.log('  OK   Le operazioni restituiscono una copia e non mutano l’originale');

  /* --- Aggiunta di un vertice -------------------------------------------- */

  let r = m.aggiungiVertice({ type: 'Point', coordinates: [1, 1] }, [9, 9]);
  assert.deepStrictEqual(r.geo.coordinates, [9, 9], 'un Point si SPOSTA, non si moltiplica');

  r = m.aggiungiVertice({ type: 'Polygon', coordinates: [[]] }, [0, 0]);
  r = m.aggiungiVertice(r.geo, [2, 0]);
  assert.strictEqual(r.geo.coordinates[0].length, 2, 'due vertici non sono ancora un anello');
  r = m.aggiungiVertice(r.geo, [2, 2]);
  assert.deepStrictEqual(r.geo.coordinates[0][0], [0, 0], 'il primo vertice resta il primo');
  assert.strictEqual(r.geo.coordinates[0].length, 4, 'al terzo vertice l’anello si chiude da sé');
  assert.deepStrictEqual(r.geo.coordinates[0][3], [0, 0], 'la chiusura ripete la prima posizione');
  const conQuarto = m.aggiungiVertice(r.geo, [0, 2]);
  assert.strictEqual(conQuarto.geo.coordinates[0].length, 5, 'il vertice nuovo entra PRIMA della chiusura');
  assert.deepStrictEqual(conQuarto.geo.coordinates[0][4], [0, 0], 'e l’anello resta chiuso');

  // Multipart: il vertice va nella parte ATTIVA, non nella prima.
  const multi = { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[]]] };
  r = m.aggiungiVertice(multi, [9, 9], 1);
  assert.strictEqual(r.geo.coordinates[0][0].length, 4, 'la prima parte non viene toccata');
  assert.deepStrictEqual(r.geo.coordinates[1][0], [[9, 9]], 'il vertice entra nella parte attiva');
  assert.deepStrictEqual(r.selezione, [1, 0, 0], 'la selezione segue il vertice appena creato');
  console.log('  OK   Un vertice nuovo entra nella parte attiva e l’anello si chiude da sé');

  /* --- Eliminazione di un vertice ---------------------------------------- */

  r = m.eliminaVertice({ type: 'Point', coordinates: [1, 1] }, []);
  assert.ok(r.errore && /Point/.test(r.errore), 'un Point non perde la sua unica posizione');

  r = m.eliminaVertice(quadrato(), [0, 4]);
  // Il quadrato ha 5 posizioni (4 + chiusura) e il minimo è 4: si può togliere.
  assert.strictEqual(r.errore, '', 'un anello con un vertice di scorta si può ridurre');

  const triangolo = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] };
  r = m.eliminaVertice(triangolo, [0, 1]);
  assert.ok(r.errore && /almeno 4/.test(r.errore),
    `un triangolo è il minimo: si rifiuta dicendolo (${r.errore})`);

  // Togliendo il PRIMO vertice l'anello va richiuso sul nuovo primo, altrimenti
  // resta aperto e il database lo rifiuta molto lontano dal gesto.
  r = m.eliminaVertice(quadrato(), [0, 0]);
  const anello = r.geo.coordinates[0];
  assert.deepStrictEqual(anello[0], anello[anello.length - 1], 'l’anello resta chiuso dopo l’eliminazione');
  assert.deepStrictEqual(anello[0], [2, 0], 'la chiusura segue il nuovo primo vertice');

  r = m.eliminaVertice({ type: 'MultiPolygon', coordinates: [[[[0, 0], [2, 0], [2, 2], [0, 0]]]] }, [0, 0, 1]);
  assert.ok(r.errore && /parte intera/.test(r.errore),
    `su una parte al minimo si suggerisce di eliminare la parte (${r.errore})`);
  console.log('  OK   L’eliminazione richiude l’anello e rifiuta di scendere sotto il minimo');

  /* --- Inserimento a metà lato ------------------------------------------- */

  r = m.inserisciVerticeDopo(quadrato(), [0, 0]);
  assert.deepStrictEqual(r.geo.coordinates[0][1], [1, 0], 'il vertice nuovo sta a metà del lato successivo');
  assert.deepStrictEqual(r.selezione, [0, 1], 'e diventa il vertice selezionato');
  assert.strictEqual(r.geo.coordinates[0].length, 6, 'l’anello cresce di una posizione');

  // Ultima posizione di un anello chiuso = la prima: «dopo» vuol dire dopo la
  // prima, altrimenti il vertice finirebbe fuori dall'anello e lo aprirebbe.
  r = m.inserisciVerticeDopo(quadrato(), [0, 4]);
  const chiusoDopo = r.geo.coordinates[0];
  assert.deepStrictEqual(chiusoDopo[0], chiusoDopo[chiusoDopo.length - 1],
    'inserire dopo la posizione di chiusura non apre l’anello');
  assert.deepStrictEqual(chiusoDopo[1], [1, 0], 'il vertice entra fra la prima e la seconda posizione');

  // Linea aperta: dopo l'ultimo vertice non c'è un lato da dividere, quindi si
  // PROLUNGA il tratto.
  r = m.inserisciVerticeDopo({ type: 'LineString', coordinates: [[0, 0], [2, 0]] }, [1]);
  assert.deepStrictEqual(r.geo.coordinates, [[0, 0], [2, 0], [3, 0]],
    'sull’ultimo vertice di una linea il tratto si prolunga');

  for (const tipo of ['Point', 'MultiPoint']) {
    const g = tipo === 'Point' ? { type: tipo, coordinates: [0, 0] } : { type: tipo, coordinates: [[0, 0], [1, 1]] };
    const rr = m.inserisciVerticeDopo(g, tipo === 'Point' ? [] : [0]);
    assert.ok(rr.errore, `${tipo}: non ha lati da dividere, e lo dichiara`);
  }
  console.log('  OK   Un vertice si infila a metà di un lato senza aprire l’anello');

  /* --- Parti di una geometria multipart ---------------------------------- */

  r = m.nuovaParte({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] });
  assert.strictEqual(r.geo.coordinates.length, 2, 'la parte nuova si aggiunge');
  assert.deepStrictEqual(r.geo.coordinates[1], [], 'ed è vuota');
  assert.strictEqual(r.parteAttiva, 1, 'la parte nuova diventa quella attiva');

  r = m.nuovaParte({ type: 'Polygon', coordinates: [[]] });
  assert.ok(r.errore, 'un Polygon non ha parti da aggiungere');

  const due = { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] };
  r = m.eliminaParte(due, 1);
  assert.strictEqual(r.geo.coordinates.length, 1, 'la parte indicata sparisce');
  assert.deepStrictEqual(r.geo.coordinates[0][0][0], [0, 0], 'resta l’altra, intatta');
  assert.strictEqual(r.parteAttiva, 0, 'l’attiva torna alla precedente');

  r = m.eliminaParte({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] }, 0);
  assert.ok(r.errore && /Ridisegna/.test(r.errore),
    `l’ultima parte non si elimina: si rimanda a «Ridisegna» (${r.errore})`);
  console.log('  OK   Le parti si aggiungono e si tolgono, ma mai l’ultima');

  /* --- La forma vuota conserva il tipo ------------------------------------ */

  assert.deepStrictEqual(m.geometriaVuota('MultiPolygon'), { type: 'MultiPolygon', coordinates: [[[]]] });
  assert.deepStrictEqual(m.geometriaVuota('Polygon'), { type: 'Polygon', coordinates: [[]] });
  assert.deepStrictEqual(m.geometriaVuota('LineString'), { type: 'LineString', coordinates: [] });
  assert.strictEqual(m.geometriaVuota('GeometryCollection'), null, 'i tipi non disegnabili non hanno forma vuota');
  console.log('  OK   «Ridisegna» svuota il disegno conservando il tipo della colonna');

  /* --- Quale vertice si stava cercando di prendere ------------------------ */

  const maniglie = [
    { percorso: [0, 0], x: 100, y: 100 },
    { percorso: [0, 1], x: 118, y: 100 },
    { percorso: [0, 5], x: 400, y: 400 },
  ];
  assert.deepStrictEqual(m.verticePiuVicino(maniglie, { x: 100, y: 100 }, 22), [0, 0], 'in centro');
  assert.deepStrictEqual(m.verticePiuVicino(maniglie, { x: 112, y: 108 }, 22), [0, 1],
    'vince il più vicino, non il primo dell’elenco');
  assert.deepStrictEqual(m.verticePiuVicino(maniglie, { x: 100, y: 121 }, 22), [0, 0],
    'entro il raggio si aggancia lo stesso: mancare di venti pixel non è premere sul vuoto');
  assert.strictEqual(m.verticePiuVicino(maniglie, { x: 100, y: 130 }, 22), null,
    'oltre il raggio non si inventa una selezione');
  assert.strictEqual(m.verticePiuVicino([], { x: 0, y: 0 }, 22), null, 'senza maniglie non c’è nulla da scegliere');
  assert.strictEqual(m.verticePiuVicino(null, { x: 0, y: 0 }, 22), null, 'e un elenco assente non è un errore');
  // Il capo e la chiusura di un anello stanno nello STESSO punto: la stessa
  // pressione deve dare sempre lo stesso vertice, non ora l'uno ora l'altro.
  const sovrapposti = [{ percorso: [0, 0], x: 50, y: 50 }, { percorso: [0, 4], x: 50, y: 50 }];
  assert.deepStrictEqual(m.verticePiuVicino(sovrapposti, { x: 52, y: 51 }, 22), [0, 0],
    'a parità di distanza vince sempre il primo');
  console.log('  OK   Il vertice scelto è quello che si stava cercando di prendere, non solo quello centrato');

  /* --- Annulla / rifai ---------------------------------------------------- */

  const storia = m.creaStoria(3);
  const a = { type: 'Point', coordinates: [0, 0] };
  const b = { type: 'Point', coordinates: [1, 1] };
  const c = { type: 'Point', coordinates: [2, 2] };
  assert.strictEqual(storia.puoAnnullare(), false, 'appena aperta non c’è nulla da annullare');
  assert.strictEqual(storia.annulla(a), null, 'e annullare non inventa uno stato');
  storia.registra(a);
  storia.registra(b);
  assert.deepStrictEqual(storia.annulla(c), b, 'si torna allo stato precedente');
  assert.deepStrictEqual(storia.annulla(b), a, 'e a quello prima ancora');
  assert.strictEqual(storia.puoRipetere(), true, 'ciò che si annulla si può rifare');
  assert.deepStrictEqual(storia.ripeti(a), b, 'rifare riporta avanti');

  // Un ramo nuovo cancella il futuro: rifare porterebbe a uno stato che non
  // discende più da quello corrente.
  storia.registra(b);
  assert.strictEqual(storia.puoRipetere(), false, 'una modifica nuova cancella ciò che c’era da rifare');

  // Il tetto è una difesa dalla memoria, non un limite dichiarato all'utente:
  // oltre il tetto si perde lo stato più VECCHIO, non il più recente.
  const corta = m.creaStoria(2);
  corta.registra({ type: 'Point', coordinates: [1, 1] });
  corta.registra({ type: 'Point', coordinates: [2, 2] });
  corta.registra({ type: 'Point', coordinates: [3, 3] });
  assert.deepStrictEqual(corta.annulla(a), { type: 'Point', coordinates: [3, 3] }, 'l’ultimo stato resta disponibile');
  assert.deepStrictEqual(corta.annulla(a), { type: 'Point', coordinates: [2, 2] }, 'il penultimo pure');
  assert.strictEqual(corta.puoAnnullare(), false, 'il più vecchio è quello che il tetto ha buttato');
  console.log('  OK   Annulla e rifai tengono la storia, con un tetto che scarta i più vecchi');

  console.log('Tutti i test di Modifica geometrie superati!');
})().catch((err) => {
  console.error('  FAIL Modifica geometrie:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

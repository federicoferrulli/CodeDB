'use strict';

const assert = require('assert');

console.log('--- Test unitari Comandi del Grafo 3D ---');

(async () => {
  const {
    tabellaVuota, contaVuote, statoComandi, cercaNodo, messaggioRicerca,
  } = await import('../public/js/grafo-comandi.js');

  // --- 1. «Questa tabella è vuota» ---------------------------------------
  // Il difetto storico: il filtro cadeva su `fields.length === 0`, cioè sulle
  // tabelle senza COLONNE. Su MySQL e PostgreSQL non esistono, quindi il
  // comando «Solo popolate» non nascondeva MAI nulla su due motori su tre.
  assert.strictEqual(tabellaVuota({ rowsApprox: 0, fields: [{ name: 'id' }] }), true,
    'una tabella con colonne ma zero righe è vuota');
  assert.strictEqual(tabellaVuota({ rowsApprox: 1, fields: [{ name: 'id' }] }), false,
    'una tabella con righe non è vuota');
  assert.strictEqual(tabellaVuota({ rowsApprox: 250000, fields: [] }), false,
    'il conteggio vince sull assenza di campi campionati');

  // Il «non so» del motore (reltuples = -1 prima di un ANALYZE, TABLE_ROWS
  // NULL) NON autorizza a nascondere: far sparire una tabella piena è molto
  // peggio che mostrarne una vuota.
  assert.strictEqual(tabellaVuota({ rowsApprox: null, fields: [{ name: 'id' }] }), false,
    'senza stima e con colonne non si nasconde');
  assert.strictEqual(tabellaVuota({ rowsApprox: undefined, fields: [{ name: 'id' }] }), false,
    'una stima assente si comporta come null');
  assert.strictEqual(tabellaVuota({ rowsApprox: NaN, fields: [{ name: 'id' }] }), false,
    'NaN non è una stima');

  // Ripiego storico di MongoDB: una collection senza documenti non produce
  // alcun campo campionato. Va conservato, perché è ciò che rendeva il comando
  // funzionante almeno su un motore.
  assert.strictEqual(tabellaVuota({ fields: [] }), true,
    'senza stima e senza campi (MongoDB) la collection è vuota');
  assert.strictEqual(tabellaVuota(null), false, 'nessuna collection non è una collection vuota');

  // --- 2. Il conteggio distingue «nessuna vuota» da «non lo so» ----------
  const conto = contaVuote([
    { rowsApprox: 0, fields: [{ name: 'id' }] },
    { rowsApprox: 12, fields: [{ name: 'id' }] },
    { rowsApprox: null, fields: [{ name: 'id' }] },
  ]);
  assert.deepStrictEqual(conto, { vuote: 1, ignote: 1, totali: 3 });
  assert.deepStrictEqual(contaVuote([]), { vuote: 0, ignote: 0, totali: 0 });
  assert.deepStrictEqual(contaVuote(null), { vuote: 0, ignote: 0, totali: 0 });

  // --- 3. Stato dei comandi che dipendono dal contesto --------------------
  const senzaSelezione = statoComandi({ selezione: null });
  assert.strictEqual(senzaSelezione.vicini.abilitato, false,
    'senza una tabella scelta il filtro dei vicini non è esprimibile');
  assert.ok(/Scegli prima una tabella/.test(senzaSelezione.vicini.motivo),
    'il motivo dice che cosa fare, non solo che è disattivato');

  const conSelezione = statoComandi({ selezione: 'ordini' });
  assert.strictEqual(conSelezione.vicini.abilitato, true);
  assert.ok(conSelezione.vicini.motivo.includes('ordini'),
    'il motivo nomina la tabella su cui il filtro agisce');

  // La rotazione automatica NON si disabilita mai. Era spenta d'ufficio sui
  // grafi giudicati grandi — e uno schema di sedici tabelle bastava, purché una
  // avesse più di dodici colonne. Disattivare non era il rimedio al fatto che
  // non funzionasse: non funzionava perché i controlli predefiniti di
  // 3d-force-graph non hanno affatto `autoRotate`.
  for (const effettiRidotti of [true, false]) {
    const s1 = statoComandi({ effettiRidotti, autoRotazione: true });
    assert.strictEqual(s1.autoRotazione.abilitato, true,
      'la rotazione resta disponibile qualunque sia la dimensione del grafo');
    assert.strictEqual(s1.autoRotazione.premuto, true);
    const s0 = statoComandi({ effettiRidotti, autoRotazione: false });
    assert.strictEqual(s0.autoRotazione.premuto, false);
  }

  assert.deepStrictEqual(statoComandi().vicini.abilitato, false,
    'senza argomenti si assume nessuna selezione');

  // --- 4. La ricerca dichiara che cosa ha trovato ------------------------
  const nodi = [
    { name: 'clienti', fields: [{ name: 'id' }, { name: 'email' }] },
    { name: 'ordini', fields: [{ name: 'id' }, { name: 'cliente_id' }] },
  ];

  assert.deepStrictEqual(cercaNodo(nodi, '').esito, 'vuoto',
    'un termine vuoto non è una ricerca senza risultati');
  assert.deepStrictEqual(cercaNodo(nodi, '   ').esito, 'vuoto');

  const perTabella = cercaNodo(nodi, 'ORD');
  assert.strictEqual(perTabella.esito, 'tabella');
  assert.strictEqual(perTabella.nodo.name, 'ordini');
  assert.strictEqual(perTabella.testo, 'ordini');

  // Il nome di tabella ha la precedenza sul nome di campo: «cliente» compare
  // in entrambi, e deve vincere la tabella `clienti`.
  assert.strictEqual(cercaNodo(nodi, 'client').nodo.name, 'clienti');

  const perCampo = cercaNodo(nodi, 'email');
  assert.strictEqual(perCampo.esito, 'campo');
  assert.strictEqual(perCampo.nodo.name, 'clienti');
  assert.strictEqual(perCampo.testo, 'clienti.email');

  // È l'esito che mancava del tutto: prima una ricerca a vuoto si comportava
  // esattamente come una ricerca non ancora scritta.
  const assente = cercaNodo(nodi, 'zzz');
  assert.strictEqual(assente.esito, 'assente');
  assert.strictEqual(assente.nodo, null);
  assert.strictEqual(cercaNodo(null, 'x').esito, 'assente');

  // --- 5. Il messaggio segue l'esito ------------------------------------
  assert.strictEqual(messaggioRicerca(cercaNodo(nodi, '')), '');
  assert.strictEqual(messaggioRicerca(perTabella), 'Tabella ordini');
  assert.strictEqual(messaggioRicerca(perCampo), 'Campo clienti.email');
  assert.strictEqual(messaggioRicerca(assente), 'Nessuna corrispondenza');
  assert.strictEqual(messaggioRicerca(null), '');

  console.log('✔ Comandi del Grafo 3D: regole pure verificate');
})().catch((err) => {
  console.error('✘ Comandi del Grafo 3D:', err.message);
  process.exitCode = 1;
});

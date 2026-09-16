'use strict';

// Il diario si prova senza database: esecuzioni finte, crash simulato buttando
// il registro e ricostruendolo sulla stessa root. Ciò che conta è l'esito
// dichiarato dopo il crash: mai «completato», mai dimenticato, con i
// riferimenti a staging e recupero per la riconciliazione manuale.
//
// Un crash non si simula però solo buttando il registro: nello stesso processo
// la voce resta quella di un'istanza VIVA, ed è esattamente ciò che `riconcilia`
// deve saper distinguere. Chi muore lascia sul disco l'identità di un'altra
// istanza e un battito fermo: è quella la forma che si mette sotto prova
// (`fingiProcessoMorto`), altrimenti si proverebbe il contrario di ciò che
// serve — che una voce viva viene dichiarata fallita.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { creaDiario } = require('../db/diarioOperazioni');
const { createImportOperationRegistry } = require('../db/importOperations');

function contesto(tmp, extra = {}) {
  let n = 0;
  const diario = creaDiario({ radicePer: (owner) => path.join(tmp, owner), ...extra });
  const creaRegistro = (exec) => createImportOperationRegistry({
    id: () => `op${++n}`, execute: exec, diario,
    schedule: (fn) => { fn.retentionManual = true; return { unref() {} }; },
    unschedule: () => {},
  });
  return { diario, creaRegistro };
}

/**
 * Invecchia il battito di una voce, e opzionalmente le cambia istanza.
 *
 * Senza `altraIstanza` è il caso del processo LOCALE il cui battito si è
 * fermato — un ciclo sincrono lungo tiene fermo il timer — e lì l'identità
 * dell'istanza è l'unica cosa che sappia ancora che l'operazione è viva.
 * Con `altraIstanza` è ciò che un processo morto lascia dietro di sé.
 */
function invecchiaBattito(tmp, ownerId, operationId, { battutoMsFa = 10 * 60 * 1000, altraIstanza = false } = {}) {
  const file = path.join(tmp, ownerId, `${operationId}.json`);
  const voce = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (altraIstanza) voce.istanza = 'un-processo-che-non-c-e-piu';
  voce.vivoAl = new Date(Date.now() - battutoMsFa).toISOString();
  fs.writeFileSync(file, JSON.stringify(voce));
}

const fingiProcessoMorto = (tmp, ownerId, operationId, opzioni = {}) =>
  invecchiaBattito(tmp, ownerId, operationId, { ...opzioni, altraIstanza: true });

const piano = { connection: 'locale', targetDb: 'dest', fingerprint: 'fp1' };
const eseguiOk = async (plan, { onProgress }) => {
  onProgress({ phase: 'dati' });
  onProgress({ phase: 'verifica' });
  return { status: 'completato', fingerprint: plan.fingerprint, recovery: { id: 'r1' }, staging: { db: 's1' } };
};

(async () => {
  /* --- Diario puro ---------------------------------------------------------- */

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-diario-'));
    const diario = creaDiario({ radicePer: (owner) => path.join(tmp, owner) });
    diario.registra({ ownerId: 'ada', operationId: 'op1', fingerprint: 'fp', connection: 'c', targetDb: 't' });
    let voce = diario.leggi({ ownerId: 'ada', operationId: 'op1' });
    assert.strictEqual(voce.status, 'in_corso');
    assert.strictEqual(voce.phase, 'accettata');
    diario.fase({ ownerId: 'ada', operationId: 'op1', phase: 'dati' });
    assert.strictEqual(diario.leggi({ ownerId: 'ada', operationId: 'op1' }).phase, 'dati');
    diario.conclude({ ownerId: 'ada', operationId: 'op1', status: 'completato' });
    voce = diario.leggi({ ownerId: 'ada', operationId: 'op1' });
    assert.strictEqual(voce.status, 'completato');
    // Riconciliare non tocca ciò che si è concluso.
    assert.deepStrictEqual(diario.riconcilia('ada'), []);
    assert.strictEqual(diario.leggi({ ownerId: 'ada', operationId: 'op1' }).status, 'completato');
    // Isolamento e validazione.
    assert.strictEqual(diario.leggi({ ownerId: 'bea', operationId: 'op1' }), null);
    assert.deepStrictEqual(diario.elenca('bea'), []);
    assert.throws(() => diario.registra({ ownerId: 'ada', operationId: '../x', fingerprint: 'f' }), /non valido/i);
    diario.rimuovi({ ownerId: 'ada', operationId: 'op1' });
    assert.strictEqual(diario.leggi({ ownerId: 'ada', operationId: 'op1' }), null);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  OK   diario puro: registra, fasi, esito, isolamento');
  }

  /* --- Crash a metà volo ------------------------------------------------------ */

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-diario-'));
    const { diario, creaRegistro } = contesto(tmp);
    let rilascia;
    const gate = new Promise((resolve) => { rilascia = resolve; });
    const r1 = creaRegistro(async (plan, { onProgress }) => {
      onProgress({ phase: 'dati' });
      await gate;
      return { status: 'completato', fingerprint: plan.fingerprint };
    });
    const accettata = r1.start({ plan: piano, adapter: {}, ownerId: 'ada', tabId: 'tab-a' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(diario.leggi({ ownerId: 'ada', operationId: accettata.operationId }).phase, 'dati',
      'il cambio di fase è già su disco mentre l operazione corre');
    // Finché l'operazione è viva NON si riconcilia, per quante letture arrivino:
    // un `list` arriva a ogni apertura di tab, e dichiarare fallito ciò che sta
    // lavorando è il difetto che questa guardia esiste per togliere.
    const r1bis = creaRegistro(eseguiOk);
    assert.strictEqual(r1bis.list('ada').length, 1);
    assert.strictEqual(diario.leggi({ ownerId: 'ada', operationId: accettata.operationId }).status, 'in_corso',
      'una voce viva non si riconcilia');

    // Battito fermo ma istanza NOSTRA: l'operazione è viva per definizione — un
    // ciclo sincrono lungo ferma il timer, non l'operazione. Senza questa
    // guardia bastava una fase muta più lunga della grazia per dichiarare
    // fallito ciò che stava ancora lavorando in questo processo.
    invecchiaBattito(tmp, 'ada', accettata.operationId);
    r1bis.list('ada');
    assert.strictEqual(diario.leggi({ ownerId: 'ada', operationId: accettata.operationId }).status, 'in_corso',
      'una voce di questa istanza è viva anche col battito fermo');

    // Un'altra istanza che BATTE è viva quanto la propria: neanche lei si tocca.
    fingiProcessoMorto(tmp, 'ada', accettata.operationId, { battutoMsFa: 2 * 1000 });
    r1bis.list('ada');
    assert.strictEqual(diario.leggi({ ownerId: 'ada', operationId: accettata.operationId }).status, 'in_corso',
      'un altra istanza che batte è viva');

    // Il processo muore qui: si butta il registro e se ne costruisce un altro.
    fingiProcessoMorto(tmp, 'ada', accettata.operationId);
    const r2 = creaRegistro(eseguiOk);
    const vista = r2.get(accettata.operationId, 'ada');
    assert.strictEqual(vista.status, 'intervento_richiesto', 'mai completato presunto');
    assert.strictEqual(vista.esitoIncerto, true);
    assert.match(vista.error || '', /incerto/i);
    // Idempotente: la seconda lettura non riscrive né cambia.
    const riletta = r2.get(accettata.operationId, 'ada');
    assert.strictEqual(riletta.status, 'intervento_richiesto');
    assert.strictEqual(riletta.esitoIncerto, true);
    // In elenco insieme alle vive, senza duplicati.
    const vive = r2.start({ plan: piano, adapter: {}, ownerId: 'ada', tabId: 'tab-a' });
    await r2.wait(vive.operationId);
    const elenco = r2.list('ada').map((op) => op.operationId);
    assert.deepStrictEqual([...elenco].sort(), [accettata.operationId, vive.operationId].sort());
    // Un altro tenant non vede nulla.
    assert.deepStrictEqual(r2.list('bea'), []);
    assert.throws(() => r2.get(accettata.operationId, 'bea'), /non trovata/i);
    rilascia();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  OK   crash: esito incerto dichiarato, mai presunto né dimenticato');
  }

  /* --- Esito felice e pulizia --------------------------------------------------- */

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-diario-'));
    const { diario, creaRegistro } = contesto(tmp);
    const r = creaRegistro(eseguiOk);
    const accettata = r.start({ plan: piano, adapter: {}, ownerId: 'ada', tabId: 'tab-a' });
    await r.wait(accettata.operationId);
    const stato = r.get(accettata.operationId, 'ada');
    assert.strictEqual(stato.status, 'completato');
    assert.strictEqual(stato.esitoIncerto || false, false);
    let pulizie = 0;
    await r.cleanup(accettata.operationId, 'ada', { async cleanup() { pulizie += 1; } });
    assert.strictEqual(pulizie, 1);
    assert.strictEqual(diario.leggi({ ownerId: 'ada', operationId: accettata.operationId }), null,
      'la pulizia esplicita chiude anche il diario');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  OK   completato e pulito: diario chiuso con l operazione');
  }

  /* --- L'errore sopravvive alla retention ---------------------------------------- */

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-diario-'));
    let n = 0;
    const diario = creaDiario({ radicePer: (owner) => path.join(tmp, owner) });
    const timers = [];
    const r = createImportOperationRegistry({
      id: () => `op${++n}`, diario, retentionMs: 1, maxTerminal: 10,
      execute: async () => { throw Object.assign(new Error('crollo'), { code: 'X' }); },
      schedule: (fn) => { const t = { fn }; timers.push(t); return t; },
      unschedule: () => {},
    });
    const fallita = r.start({ plan: piano, adapter: {}, ownerId: 'ada', tabId: 't' });
    await r.wait(fallita.operationId).catch(() => {});
    assert.strictEqual(r.get(fallita.operationId, 'ada').status, 'intervento_richiesto');
    for (const t of timers) t.fn();
    // La memoria dimentica, ma get guarisce dal diario: è la feature, non un buco.
    assert.strictEqual(r.get(fallita.operationId, 'ada').status, 'intervento_richiesto',
      'dopo la retention la voce vive nel diario');
    assert.ok(diario.leggi({ ownerId: 'ada', operationId: fallita.operationId }),
      'l errore col recupero non si cancella da solo');
    const r2 = createImportOperationRegistry({ id: () => 'op-nuovo', diario });
    const vista = r2.get(fallita.operationId, 'ada');
    assert.strictEqual(vista.status, 'intervento_richiesto', 'il diario no: il recupero resta riconciliabile');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  OK   errore con recupero: la retention non cancella il diario');
  }

  console.log('  OK   Diario delle operazioni passed');
})().catch((err) => {
  console.error('  FAIL Diario operazioni:', err.stack || err);
  process.exitCode = 1;
});

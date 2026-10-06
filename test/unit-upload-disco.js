'use strict';

// L'archivio su disco si prova senza rete e senza server: root temporanea,
// byte veri, crash simulato costruendo una seconda istanza sulla stessa root.
// Ogni caso sbagliato qui è un file diverso da quello dichiarato — un upload
// ripreso che cuce due contenuti, un finalizzato senza verifica.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createArchivioUpload } = require('../db/uploadDisco');

function radice() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-upload-'));
  return { tmp, radicePer: (owner) => path.join(tmp, owner) };
}

function archivio(tmp, extra = {}) {
  let n = 0;
  return createArchivioUpload({ radicePer: (owner) => path.join(tmp, owner), id: () => `u${++n}`, ...extra });
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = (async () => {
  /* --- Percorso felice ---------------------------------------------------- */

  {
    const { tmp, radicePer } = radice();
    let n = 0;
    const store = createArchivioUpload({ radicePer, id: () => `u${++n}` });
    const { uploadId, maxChunkBytes } = store.avvia('ada', 'terminale-1');
    assert.ok(maxChunkBytes > 0);
    const primo = Buffer.from('primi-dati-');
    const secondo = Buffer.from('secondi-dati');
    let esito = await store.aggiungi(uploadId, 'ada', { offset: 0, contenuto: primo, attore: 'terminale-1' });
    assert.strictEqual(esito.ripetuto, false);
    assert.strictEqual(esito.scritti, primo.length);
    // Ripresa: lo stesso blocco è idempotente e non sposta la posizione.
    esito = await store.aggiungi(uploadId, 'ada', { offset: 0, contenuto: primo, attore: 'terminale-1' });
    assert.strictEqual(esito.ripetuto, true);
    assert.strictEqual(esito.scritti, primo.length);
    esito = await store.aggiungi(uploadId, 'ada', { offset: primo.length, contenuto: secondo, attore: 'terminale-1' });
    const totale = Buffer.concat([primo, secondo]);
    assert.strictEqual(esito.scritti, totale.length);
    assert.deepStrictEqual(store.stato(uploadId, 'ada', 'terminale-1').scritti, totale.length);
    const manifest = await store.finalizza(uploadId, 'ada', {
      dimensioneAttesa: totale.length, digestAtteso: sha(totale), nome: 'prova.bin', attore: 'terminale-1',
    });
    assert.strictEqual(manifest.digest, sha(totale));
    assert.strictEqual(manifest.dimensione, totale.length);
    assert.strictEqual(manifest.nome, 'prova.bin');
    const { file, manifest: riletto } = store.percorsoDati(manifest.id, 'ada');
    assert.deepStrictEqual(fs.readFileSync(file), totale, 'i byte su disco sono quelli inviati');
    assert.strictEqual(fs.existsSync(path.join(tmp, 'ada', 'caricamenti', uploadId)), false,
      'la sessione sparisce alla finalizzazione');
    assert.strictEqual(store.elenca('ada').length, 1);
    assert.strictEqual(riletto.id, manifest.id, 'il manifesto si rilegge dal disco');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  OK   avvio, blocchi, ripresa idempotente e finalizzazione verificata');
  }

  /* --- Conflitti e sequenza ----------------------------------------------- */

  {
    const { tmp } = radice();
    const store = archivio(tmp);
    const { uploadId } = store.avvia('ada');
    const contenuto = Buffer.from('0123456789');
    await store.aggiungi(uploadId, 'ada', { offset: 0, contenuto });
    await assert.rejects(() => store.aggiungi(uploadId, 'ada', { offset: 0, contenuto: Buffer.from('ABCDEFGHIJ') }),
      /corrotto|Conflitto/, 'stesso offset, contenuto diverso: rifiutato, non scelto');
    await assert.rejects(() => store.aggiungi(uploadId, 'ada', { offset: 99, contenuto }),
      /sequenza/i, 'un salto lascia byte mai scritti: rifiutato');
    await assert.rejects(() => store.aggiungi(uploadId, 'ada', { offset: 10, contenuto: Buffer.alloc(0) }),
      /vuoto/i);
    // La sessione è intatta dopo i rifiuti: si prosegue dall'offset giusto.
    const esito = await store.aggiungi(uploadId, 'ada', { offset: 10, contenuto });
    assert.strictEqual(esito.scritti, 20);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  OK   conflitti e buchi rifiutati, sessione intatta');
  }

  /* --- Limiti e quote ------------------------------------------------------ */

  {
    const { tmp } = radice();
    const store = archivio(tmp, { maxBytes: 12, maxChunkBytes: 10, maxPerOwner: 1 });
    const { uploadId } = store.avvia('ada');
    assert.throws(() => store.avvia('ada'), /contemporanei/, 'tetto per account');
    await assert.rejects(() => store.aggiungi(uploadId, 'ada', { offset: 0, contenuto: Buffer.alloc(11) }),
      /troppo grande/i, 'blocco oltre il tetto');
    await store.aggiungi(uploadId, 'ada', { offset: 0, contenuto: Buffer.alloc(10) });
    await assert.rejects(() => store.aggiungi(uploadId, 'ada', { offset: 10, contenuto: Buffer.alloc(10) }),
      /troppo grande/i, 'artefatto oltre il tetto');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  OK   tetti di blocco, artefatto e concorrenza');
  }

  /* --- Finalizzazione fail-closed ------------------------------------------ */

  {
    const { tmp } = radice();
    const store = archivio(tmp);
    const { uploadId } = store.avvia('ada');
    const dati = Buffer.from('sei-byte-sei-bytes-1234');
    await store.aggiungi(uploadId, 'ada', { offset: 0, contenuto: dati });
    await assert.rejects(() => store.finalizza(uploadId, 'ada', {
      dimensioneAttesa: dati.length + 1, digestAtteso: sha(dati),
    }), /incompleto/i, 'dimensione dichiarata diversa: niente pubblicazione');
    await assert.rejects(() => store.finalizza(uploadId, 'ada', {
      dimensioneAttesa: dati.length, digestAtteso: '0'.repeat(64),
    }), /corrotto|coincide/i, 'impronta diversa: niente pubblicazione');
    await assert.rejects(() => store.finalizza(uploadId, 'ada', {
      dimensioneAttesa: dati.length, digestAtteso: 'non-esadecimale',
    }), /non valida/i);
    // Dopo i rifiuti la sessione c'è ancora e si finalizza davvero.
    const manifest = await store.finalizza(uploadId, 'ada', { dimensioneAttesa: dati.length, digestAtteso: sha(dati) });
    assert.strictEqual(manifest.dimensione, dati.length);
    assert.throws(() => store.stato(uploadId, 'ada'), /non trovato/i, 'finalizzata: non più riprendibile');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  OK   finalizzazione solo a dimensione e impronta esatte');
  }

  /* --- Ripresa dopo un crash ----------------------------------------------- */

  {
    const { tmp, radicePer } = radice();
    let n = 0;
    const prima = createArchivioUpload({ radicePer, id: () => `u${++n}` });
    const { uploadId } = prima.avvia('ada', 'a1');
    const dati = Buffer.from('parte-prima-');
    await prima.aggiungi(uploadId, 'ada', { offset: 0, contenuto: dati, attore: 'a1' });
    // Il processo muore qui: si butta l'istanza e se ne costruisce un'altra.
    const dopo = createArchivioUpload({ radicePer, id: () => 'mai-usato' });
    const resto = Buffer.from('parte-dopo');
    const esito = await dopo.aggiungi(uploadId, 'ada', { offset: dati.length, contenuto: resto, attore: 'a1' });
    assert.strictEqual(esito.scritti, dati.length + resto.length, 'si riparte dallo stato su disco');
    const totale = Buffer.concat([dati, resto]);
    const manifest = await dopo.finalizza(uploadId, 'ada', {
      dimensioneAttesa: totale.length, digestAtteso: sha(totale), attore: 'a1',
    });
    assert.strictEqual(manifest.digest, sha(totale));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  OK   crash a metà upload: si riprende dallo stato su disco');
  }

  /* --- Scadenze e isolamento ------------------------------------------------ */

  {
    const { tmp, radicePer } = radice();
    let adesso = 1_000_000;
    let n = 0;
    const store = createArchivioUpload({ radicePer, id: () => `u${++n}`, now: () => adesso, ttlMs: 1000 });
    const { uploadId } = store.avvia('ada');
    adesso += 2000;
    assert.throws(() => store.stato(uploadId, 'ada'), /scaduto/i);
    // La sola lettura non cancella: lo spazzino sì, e una volta sola.
    assert.strictEqual(store.pulisciScadutiDi('ada').rimossi, 1, 'lo spazzino rimuove gli incompleti');
    assert.strictEqual(store.pulisciScadutiDi('ada').rimossi, 0);
    assert.throws(() => store.stato(uploadId, 'ada'), /non trovato/i);
    void tmp;
    console.log('  OK   incompleti scaduti rimossi, mai pubblicati');
  }

  {
    const { tmp } = radice();
    const store = archivio(tmp);
    const { uploadId } = store.avvia('ada', 'a1');
    await store.aggiungi(uploadId, 'ada', { offset: 0, contenuto: Buffer.from('x'), attore: 'a1' });
    assert.throws(() => store.stato(uploadId, 'bea'), /non trovato/i, 'un tenant non vede l altro');
    assert.throws(() => store.stato(uploadId, 'ada', 'altro-attore'), /non trovato/i);
    assert.throws(() => store.stato('../scappa', 'ada'), /non valido/i);
    assert.throws(() => store.leggiManifesto('../../x', 'ada'), /non valido|non trovato/i);
    assert.throws(() => store.avvia(''), /mancante/i);
    // Il proprietario si VALIDA, non si riscrive: sostituire i caratteri non
    // ammessi con `_` fa condividere una cartella — e quindi gli artefatti —
    // a due tenant diversi. Due id che differiscono solo per quei caratteri
    // devono restare due tenant, non diventare lo stesso.
    assert.throws(() => store.avvia('a/b'), /non valido/i, 'niente riscrittura: un ownerId storto si rifiuta');
    assert.throws(() => store.avvia('..'), /non valido/i);
    const a = store.avvia('a_b', 'x1');
    assert.throws(() => store.stato(a.uploadId, 'a/b'), /non valido/i, 'a/b e a_b non sono lo stesso tenant');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  OK   isolamento tenant/attore e id validati');
  }

  /* --- Scarto ---------------------------------------------------------------- */

  {
    const { tmp } = radice();
    const store = archivio(tmp);
    const { uploadId } = store.avvia('ada');
    await store.aggiungi(uploadId, 'ada', { offset: 0, contenuto: Buffer.from('y') });
    assert.deepStrictEqual(store.scarta(uploadId, 'ada'), { ok: true });
    assert.throws(() => store.stato(uploadId, 'ada'), /non trovato/i);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  OK   scarto esplicito di un upload abortito');
  }

  /* --- Quota e retention ---------------------------------------------------------- */

  {
    const { tmp, radicePer } = radice();
    let n = 0;
    const store = createArchivioUpload({
      radicePer, id: () => `q${++n}`, maxBytes: 100, maxPerOwner: 10, quotaTenantBytes: 150,
    });
    const dati = (c) => Buffer.from(c.repeat(60));
    const chiudi = async (byte) => {
      const { uploadId } = store.avvia('ada');
      await store.aggiungi(uploadId, 'ada', { offset: 0, contenuto: byte });
      return store.finalizza(uploadId, 'ada', { dimensioneAttesa: byte.length, digestAtteso: sha(byte) });
    };
    // 60 byte finalizzati: restano 90 di quota, ma una sessione ne prenota 100.
    await chiudi(dati('a'));
    assert.strictEqual(store.usoTenant('ada').byte, 60);
    assert.throws(() => store.avvia('ada'), /quota/i, 'la quota si controlla prima di promettere spazio');
    assert.strictEqual(store.pulisciFinalizzatiDi('ada').rimossi, 0, 'di default i finalizzati non si toccano');
    assert.strictEqual(store.pulisciFinalizzatiDi('ada', { conservaMs: 0 }).rimossi, 1, 'a scadenza si rimuovono');
    assert.strictEqual(store.usoTenant('ada').byte, 0);
    const { uploadId } = store.avvia('ada');
    assert.ok(uploadId, 'spazio liberato: si riparte');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  OK   quota all avvio, retention configurata, uso misurato');
  }

  {
    const { tmp } = radice();
    const store = archivio(tmp);
    const { uploadId } = store.avvia('ada');
    const chunk = Buffer.alloc(1024 * 1024, 97), hash = crypto.createHash('sha256');
    const writing = store.aggiungi(uploadId, 'ada', { offset: 0, contenuto: chunk });
    await assert.rejects(store.aggiungi(uploadId, 'ada', { offset: 0, contenuto: chunk }), /occupato/);
    assert.throws(() => store.scarta(uploadId, 'ada'), /occupato/);
    await writing; hash.update(chunk);
    for (let i = 1; i < 32; i++) { await store.aggiungi(uploadId, 'ada', { offset: i * chunk.length, contenuto: chunk }); hash.update(chunk); }
    const digest = hash.digest('hex');
    let ticks = 0, duranteHash = false, updates = 0;
    const original = crypto.createHash;
    const timer = setInterval(() => ticks++, 0);
    crypto.createHash = (...args) => {
      const hash = original(...args), update = hash.update;
      hash.update = function (bytes) { updates++; duranteHash ||= ticks > 0; return update.call(this, bytes); };
      return hash;
    };
    try {
      const completing = store.finalizza(uploadId, 'ada', { dimensioneAttesa: 32 * chunk.length, digestAtteso: digest });
      await assert.rejects(store.aggiungi(uploadId, 'ada', { offset: 32 * chunk.length, contenuto: chunk }), /occupato/);
      assert.throws(() => store.scarta(uploadId, 'ada'), /occupato/);
      const manifest = await completing;
      assert.strictEqual(manifest.digest, digest);
      assert(updates > 1 && duranteHash, 'il timer deve avanzare DURANTE il checksum, non solo prima della pubblicazione');
    } finally { crypto.createHash = original; clearInterval(timer); fs.rmSync(tmp, { recursive: true, force: true }); }
    console.log('  OK   checksum non bloccante e mutazioni concorrenti escluse sullo stesso upload');
  }
  console.log('  OK   Archivio upload su disco passed');
})().catch((err) => {
  console.error('  FAIL Archivio upload:', err.stack || err);
  process.exitCode = 1;
});

'use strict';

// Le decisioni del trasferimento si provano senza rete e senza disco: entrano
// header e stato, esce la decisione. Ogni caso qui sotto, sbagliato, non
// produce un errore ma un FILE DIVERSO da quello che si voleva — un download
// ripreso che cuce insieme due versioni, un blocco che lascia un buco di byte
// mai scritti. Sono i difetti che nessun controllo di dimensione vede.

const assert = require('assert');
const crypto = require('crypto');
const {
  interpretaRange, etagDi, decidiDownload, decidiBlocco, creaTicket, verificaTicket, sha256,
} = require('../db/trasferimenti');

/* --- Range ---------------------------------------------------------------- */

const N = 1000;
assert.deepStrictEqual(interpretaRange('bytes=0-499', N), { tipo: 'parziale', inizio: 0, fine: 499 });
assert.deepStrictEqual(interpretaRange('bytes=500-', N), { tipo: 'parziale', inizio: 500, fine: 999 },
  'senza fine si arriva all ultimo byte, che e size-1');
assert.deepStrictEqual(interpretaRange('bytes=-500', N), { tipo: 'parziale', inizio: 500, fine: 999 },
  'il suffisso sono gli ULTIMI n byte, non i primi');
assert.deepStrictEqual(interpretaRange('bytes=-5000', N), { tipo: 'parziale', inizio: 0, fine: 999 },
  'un suffisso piu lungo del file vale tutto il file');
assert.deepStrictEqual(interpretaRange('bytes=999-999', N), { tipo: 'parziale', inizio: 999, fine: 999 },
  'l ultimo byte da solo e un intervallo legittimo');
assert.deepStrictEqual(interpretaRange('bytes=0-5000', N), { tipo: 'parziale', inizio: 0, fine: 999 },
  'una fine oltre il file si accorcia, non si rifiuta');
// Fuori dal file: 416, ed e' diverso da «non ho capito».
assert.deepStrictEqual(interpretaRange('bytes=1000-', N), { tipo: 'non-soddisfacibile' });
assert.deepStrictEqual(interpretaRange('bytes=1200-1300', N), { tipo: 'non-soddisfacibile' });
assert.deepStrictEqual(interpretaRange('bytes=-0', N), { tipo: 'non-soddisfacibile' },
  'un suffisso di zero byte non e soddisfacibile');
assert.deepStrictEqual(interpretaRange('bytes=0-0', 0), { tipo: 'non-soddisfacibile' },
  'un file vuoto non ha byte da servire');
// Malformato o assente: si IGNORA e si serve tutto. Rispondere 416 a un header
// che non si e' capito romperebbe client corretti per colpa di un proxy.
for (const brutto of ['', null, undefined, 'righe=0-10', 'bytes=abc', 'bytes=', 'bytes=10-5']) {
  const esito = interpretaRange(brutto, N);
  assert.ok(esito.tipo === 'intero' || esito.tipo === 'non-soddisfacibile',
    `"${brutto}" non deve produrre un intervallo`);
}
assert.deepStrictEqual(interpretaRange('bytes=0-10,20-30', N), { tipo: 'intero' },
  'piu intervalli si servono come risorsa intera, non a meta');
console.log('  OK   Range: suffissi, estremi, fuori file e header malformati');

/* --- If-Range ------------------------------------------------------------- */

const etag = etagDi({ digest: 'a'.repeat(64) });
assert.strictEqual(etag, `"sha256:${'a'.repeat(64)}"`);
assert.notStrictEqual(etagDi({ dimensione: 10, mtimeMs: 5 }), etagDi({ dimensione: 10, mtimeMs: 6 }));

const parziale = decidiDownload({ headers: { range: 'bytes=500-' }, dimensione: N, etag });
assert.strictEqual(parziale.stato, 206);
assert.strictEqual(parziale.contentRange, 'bytes 500-999/1000');
assert.strictEqual(parziale.lunghezza, 500);

const conIfRange = decidiDownload({ headers: { range: 'bytes=500-', 'if-range': etag }, dimensione: N, etag });
assert.strictEqual(conIfRange.stato, 206, 'con lo stesso ETag la ripresa procede');

// Il file e' cambiato mentre il client era fermo: servire l'intervallo
// cucirebbe insieme due file diversi, e il risultato avrebbe la dimensione
// giusta. L'unica risposta corretta e' mandare tutto.
const cambiato = decidiDownload({
  headers: { range: 'bytes=500-', 'if-range': '"sha256:vecchio"' }, dimensione: N, etag,
});
assert.strictEqual(cambiato.stato, 200);
assert.strictEqual(cambiato.lunghezza, N);
assert.strictEqual(cambiato.motivo, 'if-range-non-corrisponde');

const fuori = decidiDownload({ headers: { range: 'bytes=5000-' }, dimensione: N, etag });
assert.strictEqual(fuori.stato, 416);
assert.strictEqual(fuori.contentRange, 'bytes */1000', 'il 416 deve dire quanto e lungo il file');
console.log('  OK   If-Range: una ripresa su un file cambiato torna intera, non cucita');

/* --- Blocchi di upload ---------------------------------------------------- */

const primo = Buffer.from('abcdefghij');
const secondo = Buffer.from('klmnopqrst');
const improntePerOffset = new Map();

let scritti = 0;
let esito = decidiBlocco({ offset: 0, contenuto: primo, scritti, improntePerOffset });
assert.strictEqual(esito.azione, 'scrivi');
improntePerOffset.set(0, { impronta: esito.impronta, lunghezza: primo.length });
scritti = esito.scritti;
assert.strictEqual(scritti, 10);

esito = decidiBlocco({ offset: 10, contenuto: secondo, scritti, improntePerOffset });
assert.strictEqual(esito.azione, 'scrivi');
improntePerOffset.set(10, { impronta: esito.impronta, lunghezza: secondo.length });
scritti = esito.scritti;

// Ripresa: il client rimanda un blocco che il server ha gia' scritto. Non sa
// dove si e' fermata la SCRITTURA, sa dove si e' fermata la sua richiesta.
esito = decidiBlocco({ offset: 0, contenuto: primo, scritti, improntePerOffset });
assert.strictEqual(esito.azione, 'gia-scritto', 'rimandare lo stesso blocco deve essere idempotente');
assert.strictEqual(esito.scritti, 20, 'e non deve far arretrare la posizione');

// Stesso posto, contenuto diverso: due file pretendono lo stesso offset, e
// sceglierne uno vorrebbe dire indovinare quale sia quello vero.
esito = decidiBlocco({ offset: 0, contenuto: Buffer.from('ABCDEFGHIJ'), scritti, improntePerOffset });
assert.strictEqual(esito.azione, 'rifiuta');
assert.match(esito.motivo, /Conflitto/);

// Stessa impronta ma lunghezza diversa non e' possibile con SHA-256, ma la
// regola non deve poggiare su quella assunzione: entrambe devono coincidere.
esito = decidiBlocco({
  offset: 0, contenuto: primo, scritti,
  improntePerOffset: new Map([[0, { impronta: sha256(primo), lunghezza: 99 }]]),
});
assert.strictEqual(esito.azione, 'rifiuta');

// Un salto in avanti lascerebbe byte mai scritti, indistinguibili da zeri veri.
esito = decidiBlocco({ offset: 100, contenuto: primo, scritti, improntePerOffset });
assert.strictEqual(esito.azione, 'rifiuta');
assert.match(esito.motivo, /fuori sequenza/);

esito = decidiBlocco({ offset: 20, contenuto: primo, scritti, improntePerOffset, massimo: 25 });
assert.strictEqual(esito.azione, 'rifiuta');
assert.match(esito.motivo, /troppo grande/);

for (const brutto of [{ offset: -1, contenuto: primo }, { offset: 1.5, contenuto: primo },
  { offset: 20, contenuto: Buffer.alloc(0) }, { offset: 20, contenuto: 'testo' }]) {
  assert.strictEqual(decidiBlocco({ ...brutto, scritti, improntePerOffset }).azione, 'rifiuta');
}
console.log('  OK   blocchi: ripresa idempotente, conflitti rifiutati, nessun buco');

/* --- Ticket --------------------------------------------------------------- */

const segreto = crypto.randomBytes(32);
const ticket = creaTicket({ segreto, risorsa: 'backup/gruppo/id', attore: 'ada', ownerId: 'tenant' });
const buono = verificaTicket({ segreto, ticket });
assert.strictEqual(buono.ok, true);
assert.strictEqual(buono.risorsa, 'backup/gruppo/id');
assert.strictEqual(buono.attore, 'ada');

// Un ticket nomina UNA risorsa: non e' un token di sessione, e con esso non si
// puo' fare altro che scaricare quella.
const altro = verificaTicket({ segreto, ticket });
assert.notStrictEqual(altro.risorsa, 'backup/gruppo/altro');

assert.strictEqual(verificaTicket({ segreto, ticket: ticket.slice(0, -1) + 'x' }).ok, false,
  'una firma alterata non vale');
assert.strictEqual(verificaTicket({ segreto: crypto.randomBytes(32), ticket }).ok, false,
  'un altro segreto non vale');
assert.strictEqual(verificaTicket({ segreto, ticket: 'senza-punto' }).ok, false);
assert.strictEqual(verificaTicket({ segreto, ticket: '' }).ok, false);
assert.strictEqual(
  verificaTicket({ segreto, ticket, adesso: Date.now() + 10 * 60 * 1000 }).motivo, 'Ticket scaduto.',
  'un ticket vale pochi minuti: e un permesso, non una credenziale',
);

// Il corpo e' firmato ma NON cifrato: cambiarne il contenuto deve invalidare
// la firma, altrimenti si potrebbe riscrivere la risorsa e scaricare altro.
const [testo] = ticket.split('.');
const manomesso = JSON.parse(Buffer.from(testo, 'base64url').toString('utf8'));
manomesso.r = 'backup/altro-tenant/id';
const rifatto = Buffer.from(JSON.stringify(manomesso), 'utf8').toString('base64url');
assert.strictEqual(verificaTicket({ segreto, ticket: `${rifatto}.${ticket.split('.')[1]}` }).ok, false,
  'riscrivere la risorsa dentro il ticket deve invalidarlo');
console.log('  OK   ticket: firmati, legati a una risorsa sola, scadenti');

console.log('  OK   Trasferimento artefatti: range, ripresa, blocchi e ticket passed');

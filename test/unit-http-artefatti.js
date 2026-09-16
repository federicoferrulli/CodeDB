'use strict';

// Il data-plane HTTP si prova contro un server vero su porta effimera, senza
// database: caricamento a blocchi, finalizzazione, download intero e parziale,
// ripresa, ticket e isolamento. Ogni caso sbagliato qui è un file diverso da
// quello dichiarato o un byte leggibile da chi non deve.

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createArchivioUpload } = require('../db/uploadDisco');
const { creaModuloArtefatti } = require('../server/http-artefatti');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function richiesta({ metodo = 'GET', porta, percorso, headers = {}, corpo = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: percorso, method: metodo, headers }, (res) => {
      const pezzi = [];
      res.on('data', (c) => pezzi.push(c));
      res.on('end', () => resolve({ stato: res.statusCode, headers: res.headers, corpo: Buffer.concat(pezzi) }));
    });
    req.on('error', reject);
    if (corpo) req.write(corpo);
    req.end();
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-http-art-'));
  let n = 0;
  const archivio = createArchivioUpload({ radicePer: (owner) => path.join(tmp, owner), id: () => `u${++n}` });
  const segreto = crypto.randomBytes(32);
  const artefatti = creaModuloArtefatti({ archivio, segreto });
  const app = express();
  artefatti.monta(app, { verificaOrigine: () => ({ ok: true }) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const porta = server.address().port;
  const bearer = (ticket) => ({ authorization: `Bearer ${ticket}` });
  const creazione = artefatti.emettiTicket({ risorsa: 'caricamenti', attore: 'ada', ownerId: 'tenant-a' });

  try {
    /* --- Senza ticket non si fa nulla -------------------------------------- */

    let r = await richiesta({ metodo: 'POST', porta, percorso: '/artefatti/caricamenti', headers: {} });
    assert.strictEqual(r.stato, 403, 'creare un caricamento senza ticket è vietato');

    /* --- Caricamento a blocchi ---------------------------------------------- */

    r = await richiesta({ metodo: 'POST', porta, percorso: '/artefatti/caricamenti', headers: bearer(creazione) });
    assert.strictEqual(r.stato, 200);
    const aperto = JSON.parse(r.corpo.toString('utf8'));
    assert.ok(aperto.uploadId);
    const ticketUpload = aperto.ticket;
    const totale = Buffer.concat([crypto.randomBytes(3000), crypto.randomBytes(5000), Buffer.from('coda')]);

    async function blocco(offset, contenuto, ticket = ticketUpload, extra = {}) {
      return richiesta({
        metodo: 'POST', porta, percorso: `/artefatti/caricamenti/${aperto.uploadId}/blocco`,
        headers: { ...bearer(ticket), 'x-codedb-offset': String(offset), 'x-codedb-blocco-sha256': sha(contenuto), 'content-type': 'application/octet-stream', ...extra },
        corpo: contenuto,
      });
    }

    r = await blocco(0, totale.subarray(0, 3000));
    assert.strictEqual(r.stato, 200);
    assert.strictEqual(JSON.parse(r.corpo.toString('utf8')).ripetuto, false);
    // Impronta dichiarata diversa dal contenuto: 400 prima ancora di toccare il disco.
    r = await blocco(3000, totale.subarray(3000, 8000), ticketUpload, { 'x-codedb-blocco-sha256': '0'.repeat(64) });
    assert.strictEqual(r.stato, 400, 'blocco con impronta falsa rifiutato');
    r = await blocco(8000, totale.subarray(8000));
    assert.strictEqual(r.stato, 409, 'salto in avanti rifiutato');
    r = await blocco(3000, totale.subarray(3000, 8000));
    assert.strictEqual(r.stato, 200);
    // Ripresa: il client rimanda il primo blocco, il server lo conferma senza riscrivere.
    r = await blocco(0, totale.subarray(0, 3000));
    assert.strictEqual(JSON.parse(r.corpo.toString('utf8')).ripetuto, true);
    r = await blocco(8000, totale.subarray(8000));
    assert.strictEqual(r.stato, 200);
    console.log('  OK   upload a blocchi con ripresa idempotente e rifiuti');

    /* --- Finalizzazione ------------------------------------------------------- */

    const ticketFinalizza = ticketUpload;
    async function finalizza(payload, ticket = ticketFinalizza) {
      const corpo = Buffer.from(JSON.stringify(payload), 'utf8');
      return richiesta({
        metodo: 'POST', porta, percorso: `/artefatti/caricamenti/${aperto.uploadId}/finalizza`,
        headers: { ...bearer(ticket), 'content-type': 'application/json', 'content-length': String(corpo.length) },
        corpo,
      });
    }
    r = await finalizza({ dimensioneAttesa: totale.length + 1, digestAtteso: sha(totale) });
    assert.strictEqual(r.stato, 409, 'dimensione errata: niente pubblicazione');
    r = await finalizza({ dimensioneAttesa: totale.length, digestAtteso: sha(totale), nome: 'dump.bin' });
    assert.strictEqual(r.stato, 200);
    const { manifest, ticket: ticketDownload } = JSON.parse(r.corpo.toString('utf8'));
    assert.strictEqual(manifest.digest, sha(totale));
    console.log('  OK   finalizzazione solo a dimensione e impronta esatte');

    /* --- Download -------------------------------------------------------------- */

    const scarica = `/artefatti/${manifest.id}/scarica?ticket=${encodeURIComponent(ticketDownload)}`;
    r = await richiesta({ porta, percorso: scarica });
    assert.strictEqual(r.stato, 200);
    assert.deepStrictEqual(r.corpo, totale, 'il file scaricato è quello caricato');
    assert.strictEqual(r.headers.etag, `"sha256:${sha(totale)}"`);
    assert.strictEqual(r.headers['accept-ranges'], 'bytes');
    assert.match(r.headers['content-disposition'] || '', /attachment/);

    r = await richiesta({ porta, percorso: scarica, headers: { range: 'bytes=0-99' } });
    assert.strictEqual(r.stato, 206);
    assert.deepStrictEqual(r.corpo, totale.subarray(0, 100));
    assert.strictEqual(r.headers['content-range'], `bytes 0-99/${totale.length}`);

    r = await richiesta({ porta, percorso: scarica, headers: { range: `bytes=${totale.length}-` } });
    assert.strictEqual(r.stato, 416);
    assert.strictEqual(r.headers['content-range'], `bytes */${totale.length}`);

    // Il file è cambiato mentre il client era fermo: mai cucire due versioni.
    r = await richiesta({
      porta, percorso: scarica, headers: { range: 'bytes=10-', 'if-range': '"sha256:vecchio"' },
    });
    assert.strictEqual(r.stato, 200);
    assert.deepStrictEqual(r.corpo, totale);

    r = await richiesta({ metodo: 'HEAD', porta, percorso: scarica });
    assert.strictEqual(r.stato, 200);
    assert.strictEqual(r.corpo.length, 0, 'HEAD: intestazioni senza corpo');
    assert.strictEqual(Number(r.headers['content-length']), totale.length);
    console.log('  OK   download intero, parziale, 416, If-Range e HEAD');

    /* --- Ticket: ambito, scadenza, tenant -------------------------------------- */

    const altroTicket = artefatti.emettiTicket({ risorsa: 'caricamenti', attore: 'bea', ownerId: 'tenant-b' });
    r = await richiesta({
      porta, percorso: `/artefatti/${manifest.id}/scarica?ticket=${encodeURIComponent(altroTicket)}`,
    });
    assert.strictEqual(r.stato, 403, 'un ticket per un altra risorsa non scarica');

    const ticketBea = artefatti.emettiTicket({ risorsa: `artefatto:${manifest.id}`, attore: 'bea', ownerId: 'tenant-b' });
    r = await richiesta({
      porta, percorso: `/artefatti/${manifest.id}/scarica?ticket=${encodeURIComponent(ticketBea)}`,
    });
    assert.strictEqual(r.stato, 404, 'un tenant non legge gli artefatti dell altro');

    const moduloScaduto = creaModuloArtefatti({ archivio, segreto, scadenzaTicketMs: -1 });
    const ticketScaduto = moduloScaduto.emettiTicket({ risorsa: `artefatto:${manifest.id}`, attore: 'ada', ownerId: 'tenant-a' });
    r = await richiesta({
      porta, percorso: `/artefatti/${manifest.id}/scarica?ticket=${encodeURIComponent(ticketScaduto)}`,
    });
    assert.strictEqual(r.stato, 403, 'ticket scaduto rifiutato');

    r = await richiesta({ porta, percorso: '/artefatti/id%20non%20valido/scarica?ticket=x' });
    assert.strictEqual(r.stato, 400, 'id malformato prima ancora del ticket');
    console.log('  OK   ticket legati a risorsa, tenant e scadenza');

    /* --- Revoca ------------------------------------------------------------------- */

    // Un ticket firmato sa solo SCADERE. Fra la revoca di un accesso e la fine
    // del ticket resterebbe una finestra in cui si scarica un artefatto che può
    // contenere l'intero database: il modulo deve chiedere a ogni richiesta se
    // quell'attore è ancora valido, non fidarsi della sola firma.
    const vivi = new Set(['ada']);
    const moduloRevocabile = creaModuloArtefatti({
      archivio, segreto, attoreAncoraValido: (attore) => vivi.has(attore),
    });
    const app3 = express();
    moduloRevocabile.monta(app3, { verificaOrigine: () => ({ ok: true }) });
    const server3 = await new Promise((resolve) => {
      const s = app3.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const porta3 = server3.address().port;
      const biglietto = moduloRevocabile.emettiTicket({
        risorsa: `artefatto:${manifest.id}`, attore: 'ada', ownerId: 'tenant-a',
      });
      const url = `/artefatti/${manifest.id}/scarica?ticket=${encodeURIComponent(biglietto)}`;
      const prima = await richiesta({ porta: porta3, percorso: url });
      assert.strictEqual(prima.stato, 200, 'attore valido: scarica');
      // La revoca chiude i socket del soggetto: lo STESSO ticket, ancora dentro
      // la sua scadenza, non deve più valere.
      vivi.delete('ada');
      const dopo = await richiesta({ porta: porta3, percorso: url });
      assert.strictEqual(dopo.stato, 403, 'accesso revocato: il ticket non vale più');
      assert.match(String(dopo.corpo), /revocat/i);
    } finally {
      await new Promise((resolve) => server3.close(resolve));
    }
    console.log('  OK   la revoca dell attore invalida un ticket ancora in corso');

    /* --- Gate Origin -------------------------------------------------------------- */

    const app2 = express();
    artefatti.monta(app2, { verificaOrigine: () => ({ ok: false, reason: 'origine ostile' }) });
    const server2 = await new Promise((resolve) => {
      const s = app2.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const r2 = await richiesta({ porta: server2.address().port, percorso: scarica });
      assert.strictEqual(r2.stato, 403, 'origine rifiutata anche con ticket valido');
    } finally {
      await new Promise((resolve) => server2.close(resolve));
    }
    console.log('  OK   gate Origin applicato al data-plane');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('  OK   Data-plane HTTP degli artefatti passed');
})().catch((err) => {
  console.error('  FAIL Data-plane HTTP:', err.stack || err);
  process.exitCode = 1;
});

'use strict';

// La traccia di audit del data-plane si prova contro un server effimero: ciclo
// di vita registrato, rifiuti registrati, segreti mai registrati. Un audit che
// contiene il ticket che autorizza è una credenziale in chiaro su disco.

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
      res.on('end', () => resolve({ stato: res.statusCode, corpo: Buffer.concat(pezzi) }));
    });
    req.on('error', reject);
    if (corpo) req.write(corpo);
    req.end();
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-audit-art-'));
  let n = 0;
  const eventi = [];
  const artefatti = creaModuloArtefatti({
    archivio: createArchivioUpload({ radicePer: (owner) => path.join(tmp, owner), id: () => `u${++n}` }),
    segreto: crypto.randomBytes(32),
    registraEvento: (e) => eventi.push(e),
  });
  const app = express();
  artefatti.monta(app, { verificaOrigine: () => ({ ok: true }) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const porta = server.address().port;
  const bearer = (ticket) => ({ authorization: `Bearer ${ticket}` });
  try {
    const creazione = artefatti.emettiTicket({ risorsa: 'caricamenti', attore: 'ada', ownerId: 'tenant-a' });
    let r = await richiesta({ metodo: 'POST', porta, percorso: '/artefatti/caricamenti', headers: bearer(creazione) });
    assert.strictEqual(r.stato, 200);
    const { uploadId, ticket } = JSON.parse(r.corpo.toString('utf8'));
    const dati = Buffer.from('contenuto-verificato');
    const blocco = (contenuto, hash) => richiesta({
      metodo: 'POST', porta, percorso: `/artefatti/caricamenti/${uploadId}/blocco`,
      headers: { ...bearer(ticket), 'x-codedb-offset': '0', 'x-codedb-blocco-sha256': hash, 'content-type': 'application/octet-stream' },
      corpo: contenuto,
    });
    r = await blocco(dati, '0'.repeat(64));
    assert.strictEqual(r.stato, 400, 'rifiuto da tracciare');
    r = await blocco(dati, sha(dati));
    assert.strictEqual(r.stato, 200);
    const fin = Buffer.from(JSON.stringify({ dimensioneAttesa: dati.length, digestAtteso: sha(dati), nome: 'a.bin' }), 'utf8');
    r = await richiesta({
      metodo: 'POST', porta, percorso: `/artefatti/caricamenti/${uploadId}/finalizza`,
      headers: { ...bearer(ticket), 'content-type': 'application/json', 'content-length': String(fin.length) },
      corpo: fin,
    });
    assert.strictEqual(r.stato, 200);
    const { manifest, ticket: scarica } = JSON.parse(r.corpo.toString('utf8'));
    r = await richiesta({ porta, percorso: `/artefatti/${manifest.id}/scarica?ticket=${encodeURIComponent(scarica)}` });
    assert.strictEqual(r.stato, 200);
    assert.deepStrictEqual(r.corpo, dati);
    r = await richiesta({ porta, percorso: `/artefatti/${manifest.id}/scarica?ticket=sbagliato` });
    assert.strictEqual(r.stato, 403, 'negazione da tracciare');

    const tipi = eventi.map((e) => e.tipo);
    for (const atteso of ['caricamento-avviato', 'blocco-rifiutato', 'caricamento-finalizzato', 'scaricamento', 'accesso-negato']) {
      assert.ok(tipi.includes(atteso), `traccia contiene ${atteso}: ${tipi.join(',')}`);
    }
    const completato = eventi.find((e) => e.tipo === 'scaricamento' && e.esito === 'completato');
    assert.ok(completato, 'il download riuscito è tracciato alla fine dello stream');
    assert.strictEqual(completato.attore, 'ada');
    assert.strictEqual(completato.ownerId, 'tenant-a');
    // Mai credenziali nella traccia: né il ticket usato né segreti.
    const testo = JSON.stringify(eventi);
    assert.ok(!testo.includes(scarica) && !testo.includes(ticket) && !testo.includes(creazione),
      'nessun ticket finisce nella traccia');
    assert.ok(!testo.includes(dati.toString('utf8')), 'né i byte');
    for (const e of eventi) {
      assert.ok(e.quando && e.tipo && e.esito, 'ogni voce ha quando, tipo ed esito');
    }
    console.log('  OK   ciclo di vita e rifiuti tracciati, segreti mai');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('  OK   Audit del data-plane passed');
})().catch((err) => {
  console.error('  FAIL Audit data-plane:', err.stack || err);
  process.exitCode = 1;
});

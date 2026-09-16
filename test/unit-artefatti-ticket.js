'use strict';

// L'evento `artefatti:ticket` si prova con il contesto finto e il modulo vero:
// emette un ticket legato al tenant di chi lo chiede e rifiuta le risorse
// inventate. Il ticket non viaggia mai nello storico: l'audit registra solo
// che cosa autorizza.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { registraEventi } = require('../server');
const { contestoFinto } = require('./contesto-finto');
const { verificaTicket } = require('../db/trasferimenti');
const { createArchivioUpload } = require('../db/uploadDisco');
const { creaModuloArtefatti } = require('../server/http-artefatti');

module.exports = (async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-ticket-'));
  try {
    const segreto = crypto.randomBytes(32);
    const ctx = contestoFinto();
    ctx.artefatti = creaModuloArtefatti({
      archivio: createArchivioUpload({ radicePer: (owner) => path.join(tmp, owner) }),
      segreto,
    });
    registraEventi(ctx);

    const ownerId = ctx.principal.ownerId;
    const attore = ctx.principal.id;
    const risposta = await ctx.socket.chiama('artefatti:ticket', { risorsa: 'caricamenti' });
    assert.strictEqual(risposta.ok, true);
    const verifica = verificaTicket({ segreto, ticket: risposta.ticket });
    assert.strictEqual(verifica.ok, true);
    assert.strictEqual(verifica.risorsa, 'caricamenti');
    assert.strictEqual(verifica.ownerId, ownerId, 'il tenant è del chiamante, non del payload');
    assert.strictEqual(verifica.attore, attore);

    const rifiutata = await ctx.socket.chiama('artefatti:ticket', { risorsa: 'connessioni/*' });
    assert.strictEqual(rifiutata.ok, false, 'una risorsa inventata non diventa un ticket');
    const assente = await ctx.socket.chiama('artefatti:ticket', {});
    assert.strictEqual(assente.ok, false, 'senza risorsa non si emette nulla');

    console.log('  OK   Evento artefatti:ticket: legato al tenant, risorse validate passed');

    /* --- Chi può emettere: solo chi amministra il tenant ------------------------ */

    // Un artefatto può contenere l'intero database: un sottoutente con scope su
    // due collection non deve scaricarlo aggirando i permessi per connessione.
    const modulo = ctx.artefatti;
    const sotto = (extra) => {
      const c = contestoFinto({
        principal: {
          id: 'sub-1', type: 'subuser', owner: false, root: false,
          ownerId, tenantCapabilities: [], grants: [], connScope: null, ...extra,
        },
      });
      c.artefatti = modulo;
      registraEventi(c);
      return c;
    };
    const limitato = await sotto({}).socket.chiama('artefatti:ticket', { risorsa: 'caricamenti' });
    assert.strictEqual(limitato.ok, false, 'sottoutente con scope: niente ticket');
    assert.match(limitato.error || '', /amministrazione del tenant/);
    const amministratore = await sotto({ tenantCapabilities: ['admin'] }).socket.chiama('artefatti:ticket', { risorsa: 'caricamenti' });
    assert.strictEqual(amministratore.ok, true, 'tenant-admin: ticket emesso');

    console.log('  OK   Evento artefatti:ticket: solo chi amministra il tenant passed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('  FAIL Evento artefatti:ticket:', err.stack || err);
  process.exitCode = 1;
});

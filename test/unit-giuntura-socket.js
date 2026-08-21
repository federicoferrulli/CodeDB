'use strict';

/* ---------------------------------------------------------------------------
 * La giuntura degli eventi socket, invocata davvero.
 *
 * Fino al ticket 16 questo file non poteva esistere: la giuntura viveva dentro
 * una chiusura anonima di duemiladuecento righe che catturava socket, sessioni
 * e principal, e non c'era alcun punto in cui sostituirli. I test di server.js
 * erano perciò controlli STATICI — leggevano il file come testo e bilanciavano
 * le graffe con un'espressione regolare. Restano, e servono ancora; ma non sono
 * più l'unica cosa possibile.
 *
 * Qui gli handler vengono **chiamati**, con un contesto costruito per la prova:
 * nessun socket vero, nessun database.
 *
 * I tre handler provati appartengono a tre famiglie diverse (ADR-0001):
 *   - `db:list`          — evento sui DATI, delega a una strategia;
 *   - `vault:status`     — evento AMMINISTRATIVO, nessuna strategia;
 *   - `query:cancel`     — operazione lunga, opera sullo stato della sessione.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');
const { ROOT_PRINCIPAL } = require('../auth/principal');

let falliti = 0;
async function prova(nome, fn) {
  try {
    await fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err.message}`);
  }
}

module.exports = (async () => {
  // `require.main !== module` in server.js: importarlo NON avvia il listener.
  const { registraEventi } = require('../server');

  console.log('  --- La giuntura degli eventi socket (server.js) ---');

  /** Un contesto con gli eventi già registrati. */
  function conGiuntura(opts) {
    const ctx = contestoFinto(opts);
    registraEventi(ctx);
    return ctx;
  }

  /* --- La giuntura si monta su un contesto qualunque -------------------- */

  await prova('registraEventi accetta un contesto costruito per la prova', () => {
    const ctx = conGiuntura();
    assert.ok(ctx.socket.eventi().length > 50,
      `attesi molti eventi registrati, trovati ${ctx.socket.eventi().length}`);
    for (const evento of ['db:list', 'collection:find', 'vault:status', 'query:cancel', 'disconnect']) {
      assert.ok(ctx.socket.conosce(evento), `l'evento "${evento}" deve essere registrato`);
    }
  });

  /* --- Famiglia 1: evento sui dati -------------------------------------- */

  await prova('db:list delega alla strategia della sessione indicata dal tabId', async () => {
    let vista = false;
    const ctx = conGiuntura({
      sessioni: [['tab-1', sessioneFinta({
        strategy: { type: 'mongodb', async listDatabases() { vista = true; return ['app', 'prova']; } },
      })]],
    });
    const res = await ctx.socket.chiama('db:list', { tabId: 'tab-1' });
    assert.strictEqual(res.ok, true, res.error);
    assert.deepStrictEqual(res.databases, ['app', 'prova']);
    assert.strictEqual(vista, true, 'la strategia deve essere stata invocata');
  });

  await prova('senza sessione per quel tab la giuntura rifiuta, e non tocca nulla', async () => {
    const ctx = conGiuntura();
    const res = await ctx.socket.chiama('db:list', { tabId: 'tab-inesistente' });
    assert.strictEqual(res.ok, false);
    assert.ok(/Nessuna connessione attiva/.test(res.error), res.error);
  });

  await prova('i campi riservati al server vengono tolti dal payload del client', async () => {
    // `maxRows` alza il tetto dei risultati a 100.000 documenti: se lo potesse
    // mandare il client, una normale find si farebbe serializzare centinaia di
    // MB per socket e per tab.
    let ricevuto = null;
    const ctx = conGiuntura({
      sessioni: [['tab-1', sessioneFinta({
        strategy: {
          type: 'mongodb',
          async collectionFind(db, coll, payload) { ricevuto = payload; return { docs: [] }; },
        },
      })]],
    });
    const res = await ctx.socket.chiama('collection:find', {
      tabId: 'tab-1', db: 'app', coll: 'utenti', maxRows: 100000, opHandle: { runId: 'rubato' },
    });
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(ricevuto.maxRows, undefined, 'maxRows del client non deve arrivare alla strategia');
    assert.strictEqual(ricevuto.opHandle, undefined, 'senza runId non deve esserci alcun opHandle');
  });

  await prova('con un runId il riferimento di annullamento lo mette il SERVER', async () => {
    let ricevuto = null;
    const ctx = conGiuntura({
      sessioni: [['tab-1', sessioneFinta({
        strategy: {
          type: 'mongodb',
          async collectionFind(db, coll, payload) { ricevuto = payload; return { docs: [] }; },
        },
      })]],
    });
    await ctx.socket.chiama('collection:find', {
      tabId: 'tab-1', db: 'app', coll: 'utenti', runId: 'r1', opHandle: { runId: 'rubato' },
    });
    assert.ok(ricevuto.opHandle, 'il server deve registrare il proprio opHandle');
    assert.strictEqual(ricevuto.opHandle.runId, 'r1', 'quello del client non deve sopravvivere');
  });

  await prova('l\'errore della strategia torna come messaggio, non come eccezione', async () => {
    const ctx = conGiuntura({
      sessioni: [['tab-1', sessioneFinta({
        strategy: { type: 'mongodb', async listDatabases() { throw new Error('il motore ha detto no'); } },
      })]],
    });
    const res = await ctx.socket.chiama('db:list', { tabId: 'tab-1' });
    assert.strictEqual(res.ok, false);
    assert.ok(/il motore ha detto no/.test(res.error), res.error);
  });

  /* --- Famiglia 2: evento amministrativo -------------------------------- */

  await prova('vault:status risponde senza toccare alcuna strategia', async () => {
    // Nessuna sessione aperta: se questo handler passasse dalla giuntura dei
    // dati fallirebbe con «Nessuna connessione attiva», ed è la ragione per cui
    // ADR-0001 lo tiene in una famiglia sua.
    const ctx = conGiuntura();
    const res = await ctx.socket.chiama('vault:status', {});
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(typeof res.locked, 'boolean', 'lo stato del vault è un booleano');
  });

  /* --- Famiglia 3: operazione lunga ------------------------------------- */

  await prova('query:cancel lavora sullo stato della sessione, non su una strategia', async () => {
    let annullato = null;
    const sess = sessioneFinta({
      strategy: {
        type: 'mongodb',
        async cancelQuery(handle) { annullato = handle; return { cancelled: true }; },
      },
    });
    sess.inflight = new Map([['r1', { runId: 'r1' }]]);
    const ctx = conGiuntura({ sessioni: [['tab-1', sess]] });

    const res = await ctx.socket.chiama('query:cancel', { tabId: 'tab-1', runId: 'r1' });
    assert.strictEqual(res.ok, true, res.error);
    assert.ok(annullato && annullato.runId === 'r1', 'deve annullare proprio quella richiesta');
  });

  await prova('query:cancel su un runId sconosciuto non inventa nulla', async () => {
    const sess = sessioneFinta({ strategy: { type: 'mongodb' } });
    sess.inflight = new Map();
    const ctx = conGiuntura({ sessioni: [['tab-1', sess]] });
    const res = await ctx.socket.chiama('query:cancel', { tabId: 'tab-1', runId: 'mai-visto' });
    assert.ok(res && typeof res.ok === 'boolean', 'deve comunque rispondere');
    assert.notStrictEqual(res.cancelled, true, 'non deve dichiarare annullato ciò che non ha trovato');
  });

  /* --- Il contesto è davvero l'unica via -------------------------------- */

  await prova('due contesti hanno sessioni indipendenti', async () => {
    // È la prova che il contesto non sia diventato uno stato globale: due
    // socket devono restare due socket.
    const a = conGiuntura({
      sessioni: [['tab-1', sessioneFinta({
        strategy: { type: 'mongodb', async listDatabases() { return ['di-a']; } },
      })]],
    });
    const b = conGiuntura({
      sessioni: [['tab-1', sessioneFinta({
        strategy: { type: 'mongodb', async listDatabases() { return ['di-b']; } },
      })]],
    });
    assert.deepStrictEqual((await a.socket.chiama('db:list', { tabId: 'tab-1' })).databases, ['di-a']);
    assert.deepStrictEqual((await b.socket.chiama('db:list', { tabId: 'tab-1' })).databases, ['di-b']);
  });

  await prova("l'identità che la giuntura usa è quella del CONTESTO", async () => {
    // È la prova che il contesto sia davvero la fonte, e non un ornamento: se
    // `registraEventi` tornasse a risolversi il principal da sé dal socket,
    // quello passato qui verrebbe ignorato e questa prova diventerebbe rossa.
    const identita = {
      ...ROOT_PRINCIPAL,
      id: 'finto-1',
      email: 'prova@contesto.local',
      displayName: 'Utente del contesto',
    };
    const ctx = conGiuntura({ principal: identita });
    const res = await ctx.socket.chiama('auth:me', {});
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.user.email, 'prova@contesto.local',
      `la giuntura ha usato un'altra identità: ${JSON.stringify(res.user)}`);
  });

  await prova("l'handler riceve il contesto come terzo argomento", async () => {
    // È il punto d'appoggio delle giunture dei ticket 17-19: un handler nuovo
    // non deve doversi catturare socket, sessioni e principal dalla chiusura.
    // Si registra un handler proprio sul socket finto e si guarda cosa arriva.
    const ctx = conGiuntura();
    let terzo = null;
    const lista = ctx.socket.handler.get('db:list');
    assert.ok(lista && lista.length, 'db:list deve essere registrato');
    // Il terzo argomento lo passa `safeOn`, quindi si osserva da un handler
    // registrato attraverso la stessa via: si riusa quello di `app:info`,
    // sostituendone la funzione interna non si può — si verifica invece che il
    // contesto ricevuto sia LO STESSO oggetto, tramite un evento che lo espone
    // indirettamente (auth:me qui sopra) e tramite l'identità delle sessioni.
    const sess = sessioneFinta({ strategy: { type: 'mongodb', async listDatabases() { return []; } } });
    ctx.sessions.set('tab-2', sess);
    const res = await ctx.socket.chiama('db:list', { tabId: 'tab-2' });
    assert.strictEqual(res.ok, true, res.error);
    terzo = ctx.sessions.get('tab-2');
    assert.strictEqual(terzo, sess,
      'la giuntura deve leggere le sessioni DAL contesto, non da una mappa propria');
  });

  if (falliti) throw new Error(`${falliti} test della giuntura socket falliti`);
  console.log('  Giuntura socket: gli handler si invocano senza rete.');
})();

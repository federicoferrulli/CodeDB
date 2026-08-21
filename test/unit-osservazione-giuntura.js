'use strict';

/* ---------------------------------------------------------------------------
 * I quattro eventi di osservazione passano dalla giuntura dei dati.
 *
 * Sono i quattro soli candidati puri fra i quarantotto eventi registrati per la
 * via generica (ADR-0001). Rifacevano a mano la ricerca della sessione, con lo
 * stesso messaggio d'errore copiato quattro volte, e questo costava tre cose:
 *
 *  1. **nessuna riconnessione automatica** — mettere in osservazione una
 *     collezione su una connessione caduta non riprovava, e l'osservazione
 *     restava spenta senza che nulla lo dicesse;
 *  2. i due eventi che TOLGONO l'osservazione non avevano una **capability**,
 *     quindi passando sotto la giuntura sarebbero stati negati a ogni
 *     sottoutente;
 *  3. gli stessi due non **rispondevano** al client, che restava in attesa di
 *     un ack che non arrivava mai.
 *
 * Nessun socket vero e nessun database: si invoca la giuntura su un contesto
 * costruito per la prova (ticket 16).
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');
const { makePrincipal } = require('../auth/principal');
const { EVENT_CAPABILITY } = require('../auth/capabilities');

const QUATTRO = ['collection:watch', 'collection:unwatch', 'schema:watch', 'schema:unwatch'];

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

/** Una strategia che registra le chiamate di osservazione ricevute. */
function strategiaOsservabile() {
  const viste = [];
  return {
    type: 'mongodb',
    viste,
    watch(db, coll, handlers) { viste.push({ metodo: 'watch', db, coll, handlers }); },
    unwatch() { viste.push({ metodo: 'unwatch' }); },
    watchSchema(handlers) { viste.push({ metodo: 'watchSchema', handlers }); },
    unwatchSchema() { viste.push({ metodo: 'unwatchSchema' }); },
  };
}

module.exports = (async () => {
  const { registraEventi } = require('../server');

  console.log('  --- I quattro eventi di osservazione nella giuntura dei dati ---');

  function conGiuntura(opts) {
    const ctx = contestoFinto(opts);
    registraEventi(ctx);
    return ctx;
  }

  /* --- Tutti e quattro passano dalla giuntura --------------------------- */

  await prova('tutti e quattro rispondono al client', async () => {
    // Due dei quattro non rispondevano affatto: il client restava in attesa di
    // un ack che non sarebbe mai arrivato.
    const strategy = strategiaOsservabile();
    const ctx = conGiuntura({ sessioni: [['tab-1', sessioneFinta({ strategy })]] });
    for (const evento of QUATTRO) {
      const res = await ctx.socket.chiama(evento, { tabId: 'tab-1', db: 'app', coll: 'utenti' });
      assert.strictEqual(res && res.ok, true, `${evento}: ${res && res.error}`);
    }
    assert.deepStrictEqual(
      strategy.viste.map((v) => v.metodo),
      ['watch', 'unwatch', 'watchSchema', 'unwatchSchema'],
      'ogni evento deve raggiungere il proprio metodo della strategia'
    );
  });

  await prova('senza sessione rispondono con il messaggio della giuntura', async () => {
    // Il messaggio non è più copiato quattro volte: viene da `delegate`.
    const ctx = conGiuntura();
    for (const evento of QUATTRO) {
      const res = await ctx.socket.chiama(evento, { tabId: 'assente' });
      assert.strictEqual(res.ok, false, `${evento} doveva fallire`);
      assert.ok(/Nessuna connessione attiva/.test(res.error), `${evento}: ${res.error}`);
    }
  });

  await prova("gli eventi push portano il tabId, così il frontend li instrada", async () => {
    const strategy = strategiaOsservabile();
    const ctx = conGiuntura({ sessioni: [['tab-7', sessioneFinta({ tabId: 'tab-7', strategy })]] });
    await ctx.socket.chiama('collection:watch', { tabId: 'tab-7', db: 'app', coll: 'utenti' });
    const registrata = strategy.viste.find((v) => v.metodo === 'watch');
    registrata.handlers.onChange({ operationType: 'insert' });
    const spedito = ctx.socket.ultimoInviato('collection:changed');
    assert.ok(spedito, 'il cambiamento deve essere spedito al client');
    assert.strictEqual(spedito.args[0].tabId, 'tab-7');
    assert.strictEqual(spedito.args[0].coll, 'utenti');
    assert.strictEqual(spedito.args[0].operationType, 'insert');

    registrata.handlers.onUnavailable();
    assert.ok(ctx.socket.ultimoInviato('watch:unavailable'), 'l\'indisponibilità va segnalata');
  });

  await prova('lo schema: stesso trattamento, senza collezione', async () => {
    const strategy = strategiaOsservabile();
    const ctx = conGiuntura({ sessioni: [['tab-1', sessioneFinta({ strategy })]] });
    await ctx.socket.chiama('schema:watch', { tabId: 'tab-1' });
    const registrata = strategy.viste.find((v) => v.metodo === 'watchSchema');
    registrata.handlers.onChange({ tipo: 'db-creato' });
    const spedito = ctx.socket.ultimoInviato('schema:changed');
    assert.ok(spedito && spedito.args[0].tabId === 'tab-1', 'il push porta il tab di origine');
  });

  /* --- La capability: un sottoutente in sola lettura li usa tutti ------- */

  await prova('i quattro hanno una capability dichiarata, ed è "read"', () => {
    for (const evento of QUATTRO) {
      assert.strictEqual(EVENT_CAPABILITY[evento], 'read',
        `${evento} deve dichiarare la capability, altrimenti la giuntura lo nega`);
    }
  });

  await prova('un sottoutente con la sola lettura può usarli tutti e quattro', async () => {
    // È la prova del difetto 2: senza capability i due `unwatch` sarebbero stati
    // negati proprio a chi ha i permessi più stretti.
    const lettore = makePrincipal(
      { id: 'u1', email: 'lettore@e2e.local', ownerId: 'owner-1', status: 'active' },
      [{ connName: 'prod', role: 'viewer', capabilities: ['read'], scope: null }]
    );
    const strategy = strategiaOsservabile();
    const ctx = conGiuntura({
      principal: lettore,
      sessioni: [['tab-1', sessioneFinta({ strategy, connName: 'prod', principal: lettore })]],
    });
    for (const evento of QUATTRO) {
      const res = await ctx.socket.chiama(evento, { tabId: 'tab-1', db: 'app', coll: 'utenti' });
      assert.strictEqual(res && res.ok, true, `${evento} negato a un lettore: ${res && res.error}`);
    }
  });

  await prova('un sottoutente SENZA lettura viene negato su tutti e quattro', async () => {
    // L'altra faccia: la capability non è un timbro, è un controllo.
    const senzaNulla = makePrincipal(
      { id: 'u2', email: 'nessuno@e2e.local', ownerId: 'owner-1', status: 'active' },
      [{ connName: 'prod', role: 'nessuno', capabilities: [], scope: null }]
    );
    const ctx = conGiuntura({
      principal: senzaNulla,
      sessioni: [['tab-1', sessioneFinta({
        strategy: strategiaOsservabile(), connName: 'prod', principal: senzaNulla,
      })]],
    });
    for (const evento of QUATTRO) {
      const res = await ctx.socket.chiama(evento, { tabId: 'tab-1', db: 'app', coll: 'utenti' });
      assert.strictEqual(res.ok, false, `${evento} doveva essere negato`);
      assert.ok(/Permesso negato/.test(res.error), `${evento}: ${res.error}`);
    }
  });

  /* --- La riconnessione automatica, che prima non c'era ----------------- */

  await prova('i quattro passano dalla via che riprova, e non da una propria', () => {
    // La riconnessione non è codice di questi handler: è `executeWithReconnect`,
    // che `delegate` avvolge attorno a ogni chiamata alla strategia. Provarla
    // qui vorrebbe dire far girare il vero ciclo di ripristino — quattordici
    // tentativi con attese crescenti, minuti — dentro una suite unitaria.
    // La PROVA DI COMPORTAMENTO sta quindi in test/e2e-osservazione.js, contro
    // un MongoDB vero; qui si verifica il collegamento, cioè che quei quattro
    // eventi stiano davvero sulla via che riprova.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const corpoDelegate = src.slice(src.indexOf('function delegate(event, fn)'));
    assert.ok(
      /executeWithReconnect\(sess, \(strat\) => fn\(strat, richiesta\)\)/.test(corpoDelegate),
      'delegate deve invocare la strategia attraverso executeWithReconnect: '
      + 'è da lì che viene la riconnessione automatica'
    );
  });

  /* --- La ricerca della sessione non è più fatta a mano ----------------- */

  await prova('nessuno dei quattro cerca più la sessione da sé', () => {
    // Controllo statico: la copia da togliere è `sessions.get(normTabId(...))`
    // dentro il corpo di uno di questi handler. Se ricompare, il messaggio
    // d'errore torna a essere copiato e la riconnessione torna a mancare.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    for (const evento of QUATTRO) {
      assert.ok(
        src.includes(`delegate('${evento}'`),
        `${evento} deve essere registrato con delegate(), non con safeOn()`
      );
      assert.ok(
        !src.includes(`safeOn('${evento}'`),
        `${evento} è ancora registrato con safeOn(): rifà a mano la ricerca della sessione`
      );
    }
  });

  if (falliti) throw new Error(`${falliti} test dell'osservazione falliti`);
  console.log('  Osservazione: i quattro eventi passano dalla giuntura dei dati.');
})();

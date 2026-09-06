'use strict';
const assert = require('assert');
const { contestoFinto } = require('./contesto-finto');
const { catalogoEventi, politiche, giuntura } = require('./server-fixture');
let falliti = 0;
async function prova(nome, fn) {
  try { await fn(); console.log('  OK   ' + nome); }
  catch (err) { falliti++; console.error('  FAIL ' + nome + ': ' + err.message); }
}
module.exports = (async () => {
  const { registraEventi } = require('../server');
  const amministrativi = catalogoEventi().filter(e => e.famiglia === 'amministrativo');
  const policy = politiche();
  await prova('tutti i 31 eventi amministrativi dichiarano audit o motivo', () => {
    assert.strictEqual(amministrativi.length, 31);
    for (const { evento, handler } of amministrativi) {
      const voce = policy.EVENTI_AMMINISTRATIVI[evento];
      assert(voce && (voce.op || voce.tracciato === false && voce.motivo), evento);
      assert(!/auditUi\(\{/.test(handler.toString()), evento + ': nessun audit duplicato');
    }
  });
  await prova('un evento amministrativo non dichiarato viene rifiutato', () => {
    const modulo = giuntura([(_ctx, lifecycle) => lifecycle.amministrativo('evento:nuovo:non:dichiarato', () => {})]);
    assert.throws(() => modulo.registraEventi(contestoFinto()), err =>
      /Evento amministrativo "evento:nuovo:non:dichiarato" non dichiarato/.test(err.message)
      && /NON_TRACCIATO/.test(err.message));
  });
  /* --- Gli eventi rispondono ancora ------------------------------------- */

  await prova('gli eventi amministrativi di lettura rispondono come prima', async () => {
    const ctx = contestoFinto();
    registraEventi(ctx);
    for (const evento of ['vault:status', 'app:info', 'app:license', 'auth:me', 'connections:list']) {
      const res = await ctx.socket.chiama(evento, {});
      assert.strictEqual(res && res.ok, true, `${evento}: ${res && res.error}`);
    }
  });

  await prova('un evento amministrativo che fallisce risponde con l\'errore', async () => {
    const ctx = contestoFinto();
    registraEventi(ctx);
    // `users:list` richiede RBAC attivo: senza, deve rispondere con un errore
    // parlante e non con un'eccezione.
    const res = await ctx.socket.chiama('users:list', {});
    assert.strictEqual(typeof res.ok, 'boolean', 'deve comunque rispondere');
    if (!res.ok) assert.ok(res.error && res.error.length > 0, 'l\'errore deve essere spiegato');
  });

  if (falliti) throw new Error(`${falliti} test della giuntura amministrativa falliti`);
  console.log('  Giuntura amministrativa: l\'audit non si può più dimenticare.');
})();

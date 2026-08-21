'use strict';

/* ---------------------------------------------------------------------------
 * La giuntura amministrativa (ADR-0001, seconda delle tre famiglie).
 *
 * Ventisei eventi che non toccano alcuna strategia. Non hanno un database come
 * bersaglio — la verifica della capability per database non li riguarda — ma
 * hanno l'AUDIT, e una quindicina di loro se lo componeva a mano, riga per
 * riga, con la stessa forma ripetuta.
 *
 * Scritto a mano vuol dire dimenticabile, e il difetto che ne segue non si vede
 * mai al momento giusto: si vede il giorno in cui serve leggere lo storico e la
 * riga non c'è. Il modo di renderlo impossibile non è ricordarselo meglio, è
 * far sì che un evento non dichiarato **non si registri affatto**.
 *
 * Nessun socket vero, nessun database: contesto finto del ticket 16.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { contestoFinto } = require('./contesto-finto');

const RADICE = path.join(__dirname, '..');

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

/** Gli eventi registrati con una certa giuntura, letti dal sorgente. */
function eventiCon(giuntura, src) {
  const re = new RegExp(`\\b${giuntura}\\(\\s*['"]([^'"]+)['"]\\s*,`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

module.exports = (async () => {
  const { registraEventi } = require('../server');
  const src = fs.readFileSync(path.join(RADICE, 'server.js'), 'utf8');

  console.log('  --- La giuntura amministrativa (server.js) ---');

  const amministrativi = eventiCon('amministrativo', src);

  /* --- La famiglia esiste e ha la sua giuntura -------------------------- */

  await prova('i ventisei eventi amministrativi passano dalla loro giuntura', () => {
    assert.strictEqual(amministrativi.length, 26,
      `attesi 26 eventi amministrativi, trovati ${amministrativi.length}: ${amministrativi.join(', ')}`);
    // Un campione di ciascun gruppo: vault, connessioni, applicazione, identità.
    for (const atteso of ['vault:reset', 'connections:save', 'app:info', 'users:create', 'apikeys:revoke']) {
      assert.ok(amministrativi.includes(atteso), `${atteso} deve passare dalla giuntura amministrativa`);
    }
  });

  await prova('nessuno di loro è rimasto sulla via generica', () => {
    const generici = eventiCon('safeOn', src);
    const doppi = amministrativi.filter((e) => generici.includes(e));
    assert.deepStrictEqual(doppi, [], `registrati due volte: ${doppi.join(', ')}`);
  });

  /* --- L'audit è scritto da un posto solo ------------------------------- */

  await prova("nessuna composizione a mano dell'audit sopravvive fra gli amministrativi", () => {
    // Si guarda dentro il corpo di ciascun handler amministrativo: se ricompare
    // un `auditUi({` lì dentro, la voce è tornata a essere copiata a mano — e
    // con essa la possibilità di dimenticarla.
    const colpevoli = [];
    for (const evento of amministrativi) {
      const inizio = src.indexOf(`amministrativo('${evento}'`);
      const fine = src.indexOf('\n  amministrativo(', inizio + 10);
      const corpo = src.slice(inizio, fine > 0 ? fine : inizio + 4000);
      if (/auditUi\(\{/.test(corpo)) colpevoli.push(evento);
    }
    assert.deepStrictEqual(colpevoli, [],
      `questi handler compongono ancora l'audit a mano: ${colpevoli.join(', ')}`);
  });

  await prova('la voce di audit si compone in una funzione sola', () => {
    assert.ok(/function scriviAuditAmministrativo\(/.test(src),
      'deve esistere un solo posto in cui la voce viene composta');
  });

  /* --- Un evento nuovo non può dimenticarsi l'audit --------------------- */

  await prova('registrare un evento non dichiarato è un errore, subito', () => {
    // È il cuore del ticket: chi aggiunge un evento amministrativo nuovo non
    // deve *ricordarsi* dell'audit — deve non poter procedere senza dichiararlo.
    //
    // La dimostrazione è **comportamentale**, non una lettura del sorgente: si
    // registra la giuntura su una copia di server.js in cui è stato aggiunto un
    // evento amministrativo che nessuno ha dichiarato, e si controlla che
    // `registraEventi` rifiuti. L'errore arriva così all'AVVIO, non il giorno
    // in cui serve leggere lo storico e la riga non c'è.
    const os = require('os');
    const copia = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-amm-')), 'server-con-evento-nuovo.js'
    );
    const conEventoNuovo = src.replace(
      "amministrativo('app:info'",
      "amministrativo('evento:nuovo:non:dichiarato', (_p, cb) => cb({ ok: true }));\n"
      + "  amministrativo('app:info'"
    );
    assert.notStrictEqual(conEventoNuovo, src, 'la copia deve contenere l\'evento nuovo');
    fs.writeFileSync(copia, conEventoNuovo);

    // La copia va caricata dalla stessa cartella, altrimenti i suoi `require`
    // relativi non risolverebbero.
    const accanto = path.join(RADICE, '.server-prova-evento-nuovo.js');
    fs.copyFileSync(copia, accanto);
    try {
      delete require.cache[require.resolve(accanto)];
      const modulo = require(accanto);
      assert.throws(
        () => modulo.registraEventi(contestoFinto()),
        /Evento amministrativo "evento:nuovo:non:dichiarato" non dichiarato/,
        'un evento amministrativo non dichiarato non deve potersi registrare'
      );
    } finally {
      fs.rmSync(accanto, { force: true });
      fs.rmSync(path.dirname(copia), { recursive: true, force: true });
    }
  });

  await prova('il messaggio dice come rimediare, non solo che qualcosa non va', () => {
    assert.ok(
      /oppure dichiara NON_TRACCIATO\(motivo\)/.test(src),
      'il messaggio deve dire anche come dichiarare una lettura senza effetti'
    );
  });

  await prova('ogni evento dichiarato o ha un\'etichetta o dice perché non è tracciato', () => {
    // Una voce a metà — né etichetta né motivo — sarebbe un modo di dimenticare
    // l'audit passando dal controllo.
    const tabella = src.slice(src.indexOf('const EVENTI_AMMINISTRATIVI = {'),
      src.indexOf('const AUDIT_WRITES = {'));
    const malformate = [];
    for (const evento of amministrativi) {
      const i = tabella.indexOf(`'${evento}':`);
      assert.ok(i >= 0, `${evento} non ha una voce nella tabella`);
      const voce = tabella.slice(i, i + 400);
      const tracciato = /op:/.test(voce.slice(0, voce.indexOf('\n  \'', 5) > 0 ? voce.indexOf('\n  \'', 5) : 400));
      const nonTracciato = voce.startsWith(`'${evento}': NON_TRACCIATO(`);
      if (!tracciato && !nonTracciato) malformate.push(evento);
    }
    assert.deepStrictEqual(malformate, [], `voci senza etichetta né motivo: ${malformate.join(', ')}`);
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

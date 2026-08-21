'use strict';

/* ---------------------------------------------------------------------------
 * La tabella delle autorizzazioni è completa?
 *
 * Il Proxy autorizzante (`auth/guardStrategy.js`) è il punto in cui passano
 * tutti gli accessi ai dati — griglia, Query Engine, JOIN virtuali, tool MCP —
 * e decide consultando `METHOD_CAPABILITY`. Un metodo che non compare in quella
 * tabella non è "sicuro": è **non classificato**, e finché il Proxy lascia
 * passare ciò che non trova, aggiungere un metodo a una strategia è un modo
 * silenzioso di aggiungere una porta.
 *
 * Nessun controllo di tipo può accorgersene: la tabella è un oggetto letterale
 * e i metodi sono su tre prototipi diversi. Questo test li confronta a mano, ed
 * è l'unica cosa che rende **impossibile** aggiungere un metodo scoperto senza
 * accorgersene.
 *
 * Che cosa NON garantisce, dichiarato: che la capability scelta sia quella
 * giusta. Il test vede che una voce c'è, non che dica il vero — che
 * `dropCollection` chieda `ddl` e non `read` lo provano i test dell'RBAC.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { METHOD_CAPABILITY } = require('../auth/capabilities');
const DbStrategy = require('../db/DbStrategy');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');

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

/**
 * I metodi che il Proxy può vedere su una strategia: tutta la catena dei
 * prototipi fino a Object. `getOwnPropertyNames` e non `for...in` perché
 * `installaMetadati` (db/sqlMetadati.js) li definisce **non enumerabili**,
 * come sono i metodi di una classe — un elenco che li saltasse darebbe una
 * tabella "completa" con nove buchi dentro.
 */
function metodiVisibili(Classe) {
  const out = new Set();
  let proto = Classe.prototype;
  while (proto && proto !== Object.prototype) {
    for (const nome of Object.getOwnPropertyNames(proto)) {
      if (nome === 'constructor') continue;
      const d = Object.getOwnPropertyDescriptor(proto, nome);
      if (d && typeof d.value === 'function') out.add(nome);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return out;
}

const CLASSI = {
  DbStrategy,
  MongoDbStrategy,
  MySqlStrategy,
  PostgreSqlStrategy,
};

function tuttiIMetodi() {
  const tutti = new Map(); // nome -> [classi in cui compare]
  for (const [nome, Classe] of Object.entries(CLASSI)) {
    for (const metodo of metodiVisibili(Classe)) {
      if (!tutti.has(metodo)) tutti.set(metodo, []);
      tutti.get(metodo).push(nome);
    }
  }
  return tutti;
}

module.exports = (async () => {
  console.log('  --- Tabella delle autorizzazioni (auth/capabilities.js) ---');

  const metodi = tuttiIMetodi();
  const inTabella = new Set(Object.keys(METHOD_CAPABILITY));

  await prova('ogni metodo delle tre strategie ha la sua voce', () => {
    const scoperti = [...metodi.keys()]
      .filter((m) => !inTabella.has(m))
      .sort()
      .map((m) => `${m} (${metodi.get(m).join(', ')})`);
    assert.deepStrictEqual(scoperti, [],
      'metodi senza voce in METHOD_CAPABILITY:\n       - ' + scoperti.join('\n       - '));
  });

  await prova('nessuna voce per un metodo che non esiste', () => {
    // Una voce orfana è il difetto opposto e altrettanto silenzioso: si crede
    // di aver classificato qualcosa che è stato rinominato o rimosso.
    const orfane = [...inTabella].filter((m) => !metodi.has(m)).sort();
    assert.deepStrictEqual(orfane, [], `voci senza metodo: ${orfane.join(', ')}`);
  });

  await prova('ogni voce dice o una capability o il motivo per cui non serve', () => {
    const CAPABILITY_VALIDE = new Set(['read', 'write', 'delete', 'ddl', 'manage', 'dynamic']);
    const malformate = [];
    for (const [nome, spec] of Object.entries(METHOD_CAPABILITY)) {
      if (spec.cap == null) {
        // Voce dichiaratamente fuori dai dati: deve dire perché, altrimenti è
        // indistinguibile da una dimenticanza.
        if (!spec.motivo || typeof spec.motivo !== 'string') malformate.push(`${nome}: manca il motivo`);
      } else if (!CAPABILITY_VALIDE.has(spec.cap)) {
        malformate.push(`${nome}: capability sconosciuta "${spec.cap}"`);
      }
    }
    assert.deepStrictEqual(malformate, [], malformate.join('; '));
  });

  await prova('il test si accorge di un metodo aggiunto senza voce', () => {
    // La prova della prova: senza questa, un errore nel modo di elencare i
    // metodi renderebbe il controllo qui sopra verde per sempre.
    class StrategiaConMetodoNuovo extends DbStrategy {
      async metodoScopertoDiProposito() { return null; }
    }
    const visti = metodiVisibili(StrategiaConMetodoNuovo);
    assert.ok(visti.has('metodoScopertoDiProposito'), 'il metodo nuovo deve essere visto');
    assert.ok(!inTabella.has('metodoScopertoDiProposito'), 'e non deve avere una voce');
    // Ed è visibile anche attraverso la catena dei prototipi ereditata.
    assert.ok(visti.has('collectionFind'), 'anche i metodi ereditati vanno visti');
  });

  /* --- Il Proxy rifiuta ciò che non trova ------------------------------- */

  const { guardStrategy } = require('../auth/guardStrategy');
  const { ROOT_PRINCIPAL } = require('../auth/principal');

  function avvolta(strategia) {
    return guardStrategy(strategia, { principal: ROOT_PRINCIPAL, connName: 'prova' });
  }

  await prova('un metodo privo di voce viene rifiutato, anche a root', () => {
    // Prima dell'inversione questo metodo passava: era il buco che rendeva la
    // leva del Proxy — «aggiungere un handler o un tool non può aprire un
    // buco» — vera solo per i metodi che qualcuno si era ricordato di
    // classificare. Root non è un'eccezione: `can()` gli concede tutto, ma
    // qui non c'è niente da concedere, c'è una regola che manca.
    const strategia = avvolta({
      type: 'finto',
      metodoNonClassificato: () => 'sono passato',
    });
    assert.throws(
      () => strategia.metodoNonClassificato(),
      /non è classificato/,
      'un metodo senza voce deve essere negato'
    );
  });

  await prova('il rifiuto nomina il metodo e dice dove si dichiara', () => {
    const strategia = avvolta({ type: 'finto', esfiltraTutto: () => 'ops' });
    assert.throws(() => strategia.esfiltraTutto(), (err) => {
      assert.ok(/"esfiltraTutto"/.test(err.message), 'deve nominare il metodo');
      assert.ok(/METHOD_CAPABILITY/.test(err.message), 'deve dire dove si dichiara');
      return true;
    });
  });

  await prova('una voce che dichiara di non essere un\'operazione sui dati passa', () => {
    // È l'altra metà dell'inversione: si nega ciò di cui nessuno ha detto
    // niente, non ciò che è stato deciso non dover essere autorizzato.
    let visto = null;
    const strategia = avvolta({
      type: 'finto',
      cancelQuery(handle) { visto = handle; return { cancelled: true }; },
    });
    assert.deepStrictEqual(strategia.cancelQuery({ runId: 'r1' }), { cancelled: true });
    assert.deepStrictEqual(visto, { runId: 'r1' });
  });

  await prova('le proprietà passano: il backup legge il driver nativo', () => {
    // `strategy.pool` / `strategy.client` restano raggiungibili: gli eventi di
    // backup sono autorizzati a parte, sull'intera connessione.
    const poolFinto = { query: () => {} };
    const strategia = avvolta({ type: 'finto', pool: poolFinto, currentDb: 'app' });
    assert.strictEqual(strategia.pool, poolFinto);
    assert.strictEqual(strategia.currentDb, 'app');
  });

  await prova('i metodi classificati continuano a funzionare', async () => {
    // Il rifiuto non deve essere diventato la risposta a tutto.
    let chiamato = false;
    const strategia = avvolta({
      type: 'finto',
      async listCollections(db) { chiamato = db; return ['a']; },
    });
    assert.deepStrictEqual(await strategia.listCollections('app'), ['a']);
    assert.strictEqual(chiamato, 'app');
  });

  if (falliti) throw new Error(`${falliti} test della tabella delle autorizzazioni falliti`);
  console.log('  Tabella delle autorizzazioni: completa.');
})();

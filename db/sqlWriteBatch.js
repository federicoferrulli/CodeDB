'use strict';

/* ---------------------------------------------------------------------------
 * Il batch di scritture comune ai due motori SQL.
 *
 * Applicare più mutazioni in ordine, dentro una sola transazione, e dire con
 * esattezza che cosa è stato applicato quando qualcosa va storto non ha nulla
 * di MySQL né di PostgreSQL: la garanzia che il gateway MCP promette
 * all'utente che firma un `confirm_token` è una sola. Viveva però in due copie
 * nei due adattatori, con il blocco dell'esito di fallimento identico parola
 * per parola: correggerne una avrebbe lasciato l'altra intatta senza che nulla
 * lo segnalasse, che è la stessa classe di difetto già chiusa da
 * `db/sqlTabellare.js` e `db/sqlMetadati.js`.
 *
 * Ciò che cambia davvero fra i due motori è il **dialetto**, e resta
 * dell'adattatore: come si prende una connessione dal pool, dove si dichiara
 * il tetto di tempo (MySQL lo passa per-query al driver, PostgreSQL lo impone
 * con un `SET LOCAL` che esiste solo *dentro* la transazione), che forma ha il
 * riepilogo di uno statement, e come si restituisce o si distrugge la
 * connessione alla fine.
 *
 * Due decisioni valgono la pena di essere dichiarate.
 *
 * **Un rollback avvenuto va dichiarato tale.** Su MySQL una query che sfonda
 * il tetto di tempo lascia la connessione avvelenata: il driver ha smesso di
 * aspettare ma il server continua, quindi la si distrugge invece di
 * restituirla al pool. Il `ROLLBACK` esplicito lì non si può mandare, ma la
 * transazione viene annullata lo stesso dal server nel momento in cui la
 * connessione cade — è proprio la ragione per cui distruggerla è sicuro.
 * Registrare `rolledBack: false` significherebbe scrivere nell'audit che
 * restano applicate delle mutazioni che non esistono.
 *
 * **Chi ha fallito si dice solo quando si sa.** Se a fallire è il `commit`,
 * nessuno statement è colpevole: incolpare l'ultimo (`Math.min(index, n-1)`)
 * è un'informazione inventata. L'esito porta quindi la **fase**, e
 * `failedIndex` compare soltanto quando a fallire è davvero uno statement.
 * ------------------------------------------------------------------------- */

const DbStrategy = require('./DbStrategy');

/** Messaggio unico: era scritto in tre punti diversi. */
const MESSAGGIO_BATCH_VUOTO = 'Il batch SQL deve contenere almeno uno statement.';

/** Un batch senza statement non è un batch vuoto da eseguire: è una richiesta malformata. */
function assertBatchNonVuoto(statements) {
  if (!Array.isArray(statements) || statements.length === 0) {
    throw new Error(MESSAGGIO_BATCH_VUOTO);
  }
}

/** Lo statement in posizione `index`, già ripulito e non vuoto. */
function statementDelBatch(statements, index) {
  const sql = String(statements[index] || '').trim();
  if (!sql) throw new Error(`Lo statement SQL in posizione ${index + 1} è vuoto.`);
  return sql;
}

/**
 * Le righe restituite da uno statement (la clausola `RETURNING` di PostgreSQL)
 * passano dagli stessi tetti di righe e byte delle letture, e il troncamento è
 * DICHIARATO. La giuntura di `db/tetti.js` qui non arriva: applica il tetto al
 * campo `docs` in cima al risultato, mentre in un batch le righe stanno dentro
 * il riepilogo di ciascuno statement. Senza questo, una scrittura con
 * `RETURNING *` sarebbe una via di lettura non limitata.
 */
function conRighe(summary, rows, columns) {
  if (!Array.isArray(rows) || rows.length === 0) return summary;
  const cap = DbStrategy.resultCap({});
  const troncatoDalleRighe = rows.length > cap;
  const { rows: tenute, truncated } = DbStrategy.truncateBySize(
    troncatoDalleRighe ? rows.slice(0, cap) : rows,
  );
  summary.docs = tenute;
  summary.columns = Array.isArray(columns) ? columns : [];
  if (troncatoDalleRighe || truncated) summary.truncated = true;
  return summary;
}

/**
 * Esegue gli statement in ordine dentro una sola transazione.
 *
 * Il `dialetto` dichiara ciò che varia fra i due motori:
 *   apri()                    -> la connessione presa dal pool
 *   primaDellaTransazione(c)  -> facoltativo (MySQL: `USE <db>`)
 *   begin(c) / commit(c) / rollback(c)
 *   dentroLaTransazione(c)    -> facoltativo (PostgreSQL: `SET LOCAL`)
 *   esegui(c, sql)            -> il riepilogo di uno statement; per marcare la
 *                                connessione inservibile lancia un errore con
 *                                `connessioneAvvelenata = true`
 *   chiudi(c, { avvelenata }) -> rilascio o distruzione
 *
 * In caso di errore attacca `err.auditResult` e rilancia: l'audit del gateway
 * MCP lo raccoglie da lì.
 */
async function eseguiBatchScritture(statements, dialetto) {
  assertBatchNonVuoto(statements);
  const conn = await dialetto.apri();
  const results = [];
  let transazioneAperta = false;
  let avvelenata = false;
  let fase = 'preparazione';
  let index = 0;
  try {
    if (dialetto.primaDellaTransazione) await dialetto.primaDellaTransazione(conn);
    await dialetto.begin(conn);
    transazioneAperta = true;
    if (dialetto.dentroLaTransazione) await dialetto.dentroLaTransazione(conn);
    fase = 'statement';
    for (; index < statements.length; index++) {
      results.push(await dialetto.esegui(conn, statementDelBatch(statements, index)));
    }
    fase = 'commit';
    await dialetto.commit(conn);
    transazioneAperta = false;
    return {
      transactional: true,
      operationCount: statements.length,
      completed: statements.length,
      results,
    };
  } catch (err) {
    avvelenata = !!(err && err.connessioneAvvelenata);
    const annullamento = await annulla(dialetto, conn, { transazioneAperta, avvelenata });
    err.auditResult = {
      transactional: true,
      operationCount: statements.length,
      completed: annullamento.rolledBack ? 0 : results.length,
      fase,
      ...(fase === 'statement' ? { failedIndex: index } : {}),
      ...annullamento,
      attemptedResults: results,
    };
    throw err;
  } finally {
    await dialetto.chiudi(conn, { avvelenata });
  }
}

/**
 * Annulla la transazione e dichiara **come**. La distinzione conta: un
 * `rollback` mandato sulla connessione e un annullamento ottenuto lasciando
 * cadere una connessione avvelenata hanno lo stesso effetto sui dati, ma solo
 * il primo è una conferma che il server ha risposto.
 */
async function annulla(dialetto, conn, { transazioneAperta, avvelenata }) {
  if (!transazioneAperta) return { rolledBack: false };
  if (avvelenata) return { rolledBack: true, rolledBackBy: 'disconnessione' };
  const ok = await Promise.resolve(dialetto.rollback(conn)).then(() => true, () => false);
  return ok ? { rolledBack: true, rolledBackBy: 'rollback' } : { rolledBack: false };
}

module.exports = {
  eseguiBatchScritture,
  assertBatchNonVuoto,
  statementDelBatch,
  conRighe,
  MESSAGGIO_BATCH_VUOTO,
};

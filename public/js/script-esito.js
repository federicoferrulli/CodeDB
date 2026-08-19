/**
 * CodeDB — Decisioni del pannello di esecuzione script (strato PURO)
 *
 * Nessun DOM, nessun socket: qui stanno solo le scelte su COSA mostrare a
 * partire dagli eventi `script:progress`. Sono scelte che, sbagliate, non
 * lanciano e non si vedono — si vede solo un pannello che racconta un'altra
 * esecuzione — quindi è il posto giusto per metterle sotto test.
 *
 * Lo usa `script-run.js`, verificato da `test/unit-script-esito.js`.
 */

/**
 * Righe del log da tenere.
 *
 * Gli eventi `statement` sono DIRADATI dal server (SCRIPT_PROGRESS_MS): senza
 * diradamento uno script da decine di migliaia di istruzioni intaserebbe il
 * socket. Il prezzo è che su uno script veloce il log ne perde per strada — due
 * istruzioni eseguite e una sola elencata — e sembra fermo a metà. Il resoconto
 * COMPLETO però arriva con gli eventi terminali (`done`, `paused`, `aborted`):
 * quando c'è, ed è almeno lungo quanto ciò che si è raccolto per strada, è
 * quello a dire la verità.
 *
 * Il confronto sulla lunghezza non è una cautela di stile: il resoconto del
 * server ha un suo tetto, e sostituire un log più lungo con uno più corto
 * cancellerebbe righe che l'utente ha già visto passare.
 *
 * @param {Array} logCorrente righe raccolte dagli eventi `statement`
 * @param {object} stato      `ev.stato` dell'evento appena arrivato
 * @param {number} max        tetto di righe da tenere in memoria
 * @returns {Array} il log da usare (può essere `logCorrente` stesso)
 */
export function unisciLog(logCorrente, stato, max) {
  const corrente = Array.isArray(logCorrente) ? logCorrente : [];
  const resoconto = stato && Array.isArray(stato.results) ? stato.results : null;
  if (!resoconto || resoconto.length < corrente.length) return corrente;
  const tetto = Number.isFinite(max) && max > 0 ? max : resoconto.length;
  return resoconto.slice(-tetto);
}

/**
 * Quante righe la griglia sta mostrando davvero, cioè il numero che il
 * contatore «record» deve dire.
 *
 * Prima riceveva le ISTRUZIONI eseguite: sopra una griglia con una riga si
 * leggeva «2 record», e il numero di istruzioni era già scritto due righe sotto
 * nel pannello. Un result set VUOTO vale zero — non "nessun dato": è la
 * differenza fra una tabella vuota (giusta) e il risultato dell'istruzione
 * precedente lasciato lì (sbagliato, ma con l'aria di essere la risposta).
 *
 * @param {object|null} ultimoRisultato `ev.ultimoRisultato`
 * @returns {number} righe da dichiarare (0 se non c'è nulla da mostrare)
 */
export function righeDaMostrare(ultimoRisultato) {
  const docs = ultimoRisultato && ultimoRisultato.docs;
  return Array.isArray(docs) ? docs.length : 0;
}

/**
 * C'è un result set da disegnare? Distingue "zero righe" (da mostrare, come
 * tabella vuota) da "niente" (griglia da svuotare, perché ciò che contiene
 * appartiene a un'esecuzione precedente).
 */
export function haRisultato(ultimoRisultato) {
  return !!(ultimoRisultato && Array.isArray(ultimoRisultato.docs));
}

/* --- Risultati per istruzione ---------------------------------------------
 * Uno script produce un result set per istruzione. Il pannello ne mostra le
 * linguette; il contenuto arriva dal server una scheda alla volta (i result set
 * stanno su file, vedi db/ScriptResults.js). Qui stanno solo le decisioni: che
 * cosa scrivere sulla linguetta e quale accendere.
 * ------------------------------------------------------------------------- */

/**
 * Etichetta di una linguetta: la riga nel sorgente e l'inizio dell'istruzione.
 * Il numero di riga viene PRIMA del testo perché è ciò che rende la scheda
 * riconoscibile quando le istruzioni si somigliano — in uno script generato,
 * venti `SELECT * FROM …` differiscono solo per una parola in fondo.
 */
export function etichettaScheda(scheda, maxTesto = 32) {
  const s = scheda || {};
  const testo = String(s.sql || '').replace(/\s+/g, ' ').trim();
  const tagliato = testo.length > maxTesto ? `${testo.slice(0, maxTesto)}…` : testo;
  return {
    riga: s.line != null ? `riga ${s.line}` : '',
    testo: tagliato || '(istruzione)',
    righe: `${s.rows != null ? s.rows : 0} ${s.rows === 1 ? 'riga' : 'righe'}`,
  };
}

/**
 * Quale linguetta è accesa all'arrivo del risultato.
 *
 * La griglia, a fine script, mostra l'ultimo RISULTATO — che può essere il
 * riepilogo di una scrittura, e un riepilogo non è una scheda. In quel caso non
 * si accende niente: fingere che la griglia stia mostrando l'ultima SELECT
 * sarebbe la stessa bugia che si è appena tolta di mezzo.
 *
 * @returns {number|null} `pos` della scheda da accendere, o null
 */
export function schedaAttiva(schede, ultimoRisultato) {
  if (!Array.isArray(schede) || !schede.length) return null;
  const index = ultimoRisultato && ultimoRisultato.index;
  if (!Number.isInteger(index)) return null;
  const trovata = schede.find((s) => s.index === index);
  return trovata ? trovata.pos : null;
}

/**
 * Nota sulle schede non conservate. Il tetto esiste (memoria e disco non sono
 * infiniti) ma va DETTO: una linguetta che non compare, senza spiegazione,
 * sembra un risultato perso.
 */
export function notaScartate(risultati) {
  const n = risultati && risultati.scartati;
  if (!n) return '';
  return n === 1
    ? '1 altro risultato non conservato (tetto raggiunto)'
    : `${n} altri risultati non conservati (tetto raggiunto)`;
}

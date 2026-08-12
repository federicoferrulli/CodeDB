'use strict';

/* ---------------------------------------------------------------------------
 * Sessioni e query attive sul SERVER di database — strato puro.
 *
 * Le tre fonti non si somigliano affatto:
 *
 *   MongoDB      $currentOp            → opid, secs_running, op, ns, command{}
 *   MySQL        information_schema    → ID, USER, HOST, DB, COMMAND, TIME, INFO
 *                .PROCESSLIST
 *   PostgreSQL   pg_stat_activity      → pid, usename, state, query, query_start,
 *                                        wait_event_type, backend_type
 *
 * Qui dentro diventano un descrittore solo. Sta a parte dalle strategie per la
 * stessa ragione di `cell-stats.js` e `chart-option.js`, con un'aggravante: un
 * errore in questa normalizzazione non produce una tabella storta, produce un
 * pulsante "Termina" accanto alla riga sbagliata — e chi lo preme non ha modo
 * di accorgersene prima. Da qui `test/unit-sessioni.js`, che lavora su righe
 * grezze catturate dai tre DBMS senza bisogno di alcun database.
 *
 * Le tre regole che il modulo tiene per costruzione:
 *
 *   1. una connessione di CodeDB non è mai terminabile — terminarla non ferma
 *      nulla di ciò che l'utente sta guardando, scollega la scheda e sembra un
 *      guasto dell'applicazione;
 *   2. un processo di SERVIZIO del server (autovacuum, checkpointer, replica,
 *      binlog dump) non è mai terminabile — non è la query di nessuno, e
 *      ucciderlo danneggia il server invece di sbloccarlo;
 *   3. "annulla la query" su una sessione che non sta eseguendo niente non è
 *      un'operazione a vuoto ma un'operazione FUORVIANTE: riesce, non cambia
 *      nulla, e chi la usa per liberare un lock crede di aver fatto qualcosa.
 *      Su una sessione inattiva si offre la sola terminazione della connessione.
 * ------------------------------------------------------------------------- */

// Tetto alle righe riportate: su un server carico `pg_stat_activity` ha
// migliaia di righe, che nessuno legge e che costerebbero un payload enorme a
// ogni refresh. Oltre il tetto si dichiara il troncamento invece di tacerlo.
const MAX_SESSIONI = 500;

// Il testo di una query può essere enorme (uno script generato, un IN con
// diecimila valori). Si tronca dichiarandolo: serve a capire COSA sta girando,
// non a rileggerlo per intero.
const MAX_TESTO_QUERY = 4000;

/** Nome applicativo con cui CodeDB si presenta ai DBMS che lo supportano. */
const APP_NAME = 'CodeDB';

const STATO_ATTIVA = 'attiva';
const STATO_ATTESA = 'in attesa';
const STATO_INATTIVA = 'inattiva';
const STATO_SCONOSCIUTO = 'sconosciuto';

function testo(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Numero di secondi, arrotondato al decimo; valori non numerici → null. */
function secondi(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10) / 10;
}

/** Testo della query, troncato al tetto e con il troncamento dichiarato. */
function ritagliaQuery(v) {
  const s = testo(v);
  if (!s) return { query: null, queryTroncata: false };
  if (s.length <= MAX_TESTO_QUERY) return { query: s, queryTroncata: false };
  return { query: s.slice(0, MAX_TESTO_QUERY), queryTroncata: true };
}

/**
 * Descrittore comune di una sessione. I campi assenti restano `null` invece di
 * sparire: la tabella ha colonne fisse e un `undefined` diventerebbe "undefined"
 * a schermo in un punto dell'interfaccia dove la precisione conta.
 */
function sessione(campi) {
  return {
    id: String(campi.id),
    utente: campi.utente || null,
    host: campi.host || null,
    db: campi.db || null,
    stato: campi.stato || STATO_SCONOSCIUTO,
    // Testo grezzo dello stato riportato dal DBMS ("idle in transaction",
    // "Waiting for table metadata lock", "Sending data"): è il dettaglio che
    // dice davvero cosa sta succedendo, e riassumerlo lo perderebbe.
    dettaglioStato: campi.dettaglioStato || null,
    comando: campi.comando || null,
    secondi: campi.secondi != null ? campi.secondi : null,
    // I secondi misurano due cose diverse a seconda dello stato: da quanto
    // gira la query, oppure da quanto la sessione è ferma. Sono numeri che
    // portano a decisioni opposte, quindi la colonna dichiara quale dei due è.
    secondiDi: campi.secondiDi || null,
    query: campi.query || null,
    queryTroncata: !!campi.queryTroncata,
    // Sessione ferma ma dentro una transazione aperta: non consuma CPU e per
    // questo non compare fra le "query lente", ma tiene i lock e blocca gli
    // altri. È il caso che si cerca quando "il database è fermo" e nel
    // monitor non si vede nulla di attivo.
    transazioneAperta: !!campi.transazioneAperta,
    nostra: !!campi.nostra,
    interna: !!campi.interna,
    // Chi la sta bloccando e quante ne sta bloccando lei. Riempiti da
    // `collegaBlocchi` quando il DBMS sa dirlo (vedi lì il perché è la cosa
    // più importante di tutto il pannello).
    bloccataDa: [],
    bloccaAltre: 0,
  };
}

/* --- Chi blocca chi --------------------------------------------------------
 * È il dato che trasforma l'elenco in una risposta. Senza, davanti a "il
 * database è fermo" si vede una sessione in attesa, la si termina, e non
 * cambia nulla: quella in attesa è la VITTIMA, e il lock ce l'ha un'altra —
 * spesso una sessione che non sta eseguendo niente (idle in transaction) e che
 * quindi non compare fra le query lente né dà segno di sé in alcun modo.
 *
 * Le coppie arrivano dalle strategie (`pg_blocking_pids` su PostgreSQL,
 * `performance_schema.data_lock_waits` su MySQL); dove il DBMS non sa dirlo si
 * resta senza, e l'interfaccia lo dichiara invece di far intendere che non ci
 * siano blocchi.
 * ------------------------------------------------------------------------- */
function collegaBlocchi(sessioni, coppie) {
  const perId = new Map(sessioni.map((s) => [String(s.id), s]));
  for (const c of Array.isArray(coppie) ? coppie : []) {
    const attesa = perId.get(String(c && c.attesa));
    const blocca = String(c && c.blocca);
    // Si registra il bloccante anche se non è nell'elenco (può essere finito
    // fuori dal tetto delle righe): sapere che ESISTE e che ha quell'id è già
    // metà della risposta. Il collegamento all'altra riga, invece, si fa solo
    // se la riga c'è davvero.
    if (!attesa || !blocca || blocca === 'null' || blocca === 'undefined') continue;
    if (!attesa.bloccataDa.includes(blocca)) attesa.bloccataDa.push(blocca);
    // La tabella dei lock è una fonte MIGLIORE dello stato riportato dal DBMS,
    // e su MySQL è l'unica: un'attesa su un lock di riga non compare in
    // `STATE` (la sessione risulta semplicemente "in esecuzione"), quindi
    // senza questa promozione la vittima non veniva vista come bloccata e il
    // verdetto non si accorgeva del blocco. Su PostgreSQL il risultato
    // coincide con `wait_event_type = 'Lock'`, che infatti resta.
    if (attesa.stato === STATO_ATTIVA || attesa.stato === STATO_SCONOSCIUTO) attesa.stato = STATO_ATTESA;
    const bloccante = perId.get(blocca);
    if (bloccante) bloccante.bloccaAltre += 1;
  }
  return sessioni;
}

/* --- MongoDB ---------------------------------------------------------------
 * `$currentOp` con `idleConnections: false`: si vedono solo le operazioni in
 * esecuzione, quindi non esistono sessioni "inattive" da mostrare. È una
 * differenza reale fra i DBMS e l'interfaccia la dichiara invece di far
 * sembrare che MongoDB abbia sempre poco traffico.
 * ------------------------------------------------------------------------- */

// Chiavi di servizio del protocollo, non della query: mostrarle riempirebbe la
// colonna di rumore identico su ogni riga, nascondendo l'unica parte che
// interessa (collezione, filtro, pipeline).
const MONGO_CHIAVI_RUMORE = new Set(['lsid', 'txnNumber', 'autocommit', 'startTransaction', 'writeConcern', 'readConcern', 'shardVersion', 'databaseVersion']);

function comandoMongoLeggibile(command) {
  if (!command || typeof command !== 'object') return null;
  const pulito = {};
  for (const [k, v] of Object.entries(command)) {
    if (k.startsWith('$') || MONGO_CHIAVI_RUMORE.has(k)) continue;
    pulito[k] = v;
  }
  if (Object.keys(pulito).length === 0) return null;
  try {
    return JSON.stringify(pulito);
  } catch {
    return null; // riferimenti circolari o valori non serializzabili
  }
}

function normalizzaMongo(ops, opts = {}) {
  const nostroAppName = opts.appName || APP_NAME;
  const out = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || op.opid === undefined || op.opid === null) continue;

    const ns = testo(op.ns);
    const db = ns ? ns.split('.')[0] : null;
    const utente = Array.isArray(op.effectiveUsers) && op.effectiveUsers.length
      ? op.effectiveUsers.map((u) => u && u.user).filter(Boolean).join(', ') || null
      : null;

    // `secs_running` manca sulle operazioni appena partite: i microsecondi ci
    // sono comunque, e una query da 300 ms che compare come "—" farebbe
    // sembrare rotta proprio la colonna su cui si ordina.
    const sec = op.secs_running != null
      ? secondi(op.secs_running)
      : (op.microsecs_running != null ? secondi(Number(op.microsecs_running) / 1e6) : null);

    const attesa = !!op.waitingForLock;
    out.push(sessione({
      id: typeof op.opid === 'object' ? JSON.stringify(op.opid) : op.opid,
      utente,
      host: testo(op.client) || testo(op.client_s),
      db,
      stato: attesa ? STATO_ATTESA : STATO_ATTIVA,
      dettaglioStato: attesa ? 'in attesa di un lock' : testo(op.desc),
      comando: testo(op.op),
      secondi: sec,
      secondiDi: 'query',
      ...ritagliaQuery(comandoMongoLeggibile(op.command)),
      // L'appName è l'unico segnale esatto disponibile: identifica CodeDB, non
      // QUESTA istanza di CodeDB. Due installazioni collegate allo stesso
      // server si vedrebbero a vicenda come "nostre" e non potrebbero
      // terminarsi — un errore per eccesso di prudenza, che è il verso giusto
      // in cui sbagliare qui.
      nostra: testo(op.appName) === nostroAppName,
      // Operazioni interne del server: replica, sessioni di sistema, TTL
      // monitor. `killOp` su queste non risolve nulla e destabilizza il nodo.
      interna: /^(repl|ReplBatcher|TTLMonitor|WT|OplogFetcher|conn.*internal)/i.test(testo(op.desc) || '')
        || testo(op.op) === 'none',
    }));
  }
  return out;
}

/* --- MySQL -----------------------------------------------------------------
 * `information_schema.PROCESSLIST` (o `SHOW FULL PROCESSLIST`, stesse colonne).
 * ------------------------------------------------------------------------- */

// Utenti e comandi che non sono sessioni applicative: thread di replica, di
// event scheduler, dump del binlog.
const MYSQL_COMANDI_INTERNI = new Set(['daemon', 'binlog dump', 'binlog dump gtid']);
const MYSQL_UTENTI_INTERNI = new Set(['system user', 'event_scheduler']);

function normalizzaMysql(rows, opts = {}) {
  // Gli id dei thread del NOSTRO pool: mysql2 li espone come `threadId` su
  // ogni connessione. È l'identificazione esatta — un confronto per
  // utente/host marcherebbe come nostre anche le sessioni di un altro client
  // collegato con le stesse credenziali, cioè proprio quelle da terminare.
  const nostri = new Set((opts.threadIds || []).map((v) => String(v)));
  // Thread con una transazione InnoDB aperta. È l'equivalente MySQL di "idle
  // in transaction" di PostgreSQL, che qui non ha uno stato proprio: un thread
  // fermo in `Sleep` con una transazione aperta si presenta identico a uno
  // fermo e basta, mentre il primo tiene i lock e il secondo no.
  const conTransazione = new Set((opts.transazioni || []).map((v) => String(v)));
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.ID == null) continue;
    const comando = testo(r.COMMAND);
    const stato = testo(r.STATE);
    const utente = testo(r.USER);
    const dorme = (comando || '').toLowerCase() === 'sleep';
    const interna = MYSQL_COMANDI_INTERNI.has((comando || '').toLowerCase())
      || MYSQL_UTENTI_INTERNI.has((utente || '').toLowerCase());
    // `STATE` durante un'attesa dice esattamente cosa si aspetta ("Waiting for
    // table metadata lock", "Waiting for table level lock").
    //
    // I thread di SERVIZIO restano però fuori da questa lettura: aspettare è
    // il loro mestiere ("Waiting on empty queue" dell'event scheduler, "Waiting
    // for source to send event" della replica) e dipingerli come bloccati
    // significa mettere un allarme rosso permanente accanto a un thread che sta
    // funzionando esattamente come deve — cioè insegnare a ignorare il rosso
    // proprio nel pannello dove serve a qualcosa.
    const inAttesa = !dorme && !interna && /wait/i.test(stato || '');

    out.push(sessione({
      id: r.ID,
      utente,
      host: testo(r.HOST),
      db: testo(r.DB),
      stato: dorme ? STATO_INATTIVA : (inAttesa ? STATO_ATTESA : STATO_ATTIVA),
      dettaglioStato: stato,
      comando,
      secondi: secondi(r.TIME),
      // Il `TIME` di un thread di servizio è da quanto sta in piedi, non da
      // quanto dura una query: contarlo come durata di query lo colorerebbe di
      // rosso per sempre (un event scheduler avviato ieri segna 90.000 s) e lo
      // farebbe entrare nella "query più lunga" del riassunto.
      secondiDi: (dorme || interna) ? 'inattivita' : 'query',
      ...ritagliaQuery(r.INFO),
      transazioneAperta: conTransazione.has(String(r.ID)),
      nostra: nostri.has(String(r.ID)),
      interna,
    }));
  }
  return out;
}

/* --- PostgreSQL ------------------------------------------------------------
 * `pg_stat_activity`. Due particolarità che il descrittore comune deve
 * conservare: `backend_type` distingue i processi di servizio dai client, e
 * "idle in transaction" è uno stato a sé — fermo ma con i lock in mano.
 * ------------------------------------------------------------------------- */

function normalizzaPostgres(rows, opts = {}) {
  const nostri = new Set((opts.processIDs || []).map((v) => String(v)));
  const nostroAppName = opts.appName || APP_NAME;
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.pid == null) continue;
    const state = (testo(r.state) || '').toLowerCase();
    const backendType = testo(r.backend_type);
    const interna = !!backendType && backendType !== 'client backend';
    const inTransazione = state.startsWith('idle in transaction');
    const attiva = state === 'active' || state === 'fastpath function call';
    // Solo `Lock` significa "fermo perché un'altra transazione tiene il lock".
    // `Client`, `Activity`, `Timeout`, `IO` sono attese fisiologiche: contarle
    // come blocchi riempirebbe la colonna di allarmi che non lo sono.
    const bloccata = attiva && testo(r.wait_event_type) === 'Lock';

    let stato = STATO_SCONOSCIUTO;
    if (bloccata) stato = STATO_ATTESA;
    else if (attiva) stato = STATO_ATTIVA;
    else if (state) stato = STATO_INATTIVA;

    const dettaglio = [testo(r.state), r.wait_event_type ? `attesa ${r.wait_event_type}${r.wait_event ? `/${r.wait_event}` : ''}` : null]
      .filter(Boolean).join(' · ') || null;

    const host = testo(r.client_addr)
      ? `${testo(r.client_addr)}${r.client_port ? `:${r.client_port}` : ''}`
      : (interna ? null : 'locale'); // client_addr nullo = connessione via socket UNIX

    out.push(sessione({
      id: r.pid,
      utente: testo(r.usename),
      host,
      db: testo(r.datname),
      stato,
      dettaglioStato: dettaglio,
      comando: backendType,
      secondi: secondi(r.secondi != null ? r.secondi : r.durata),
      secondiDi: attiva ? 'query' : 'inattivita',
      ...ritagliaQuery(r.query),
      transazioneAperta: inTransazione,
      nostra: nostri.has(String(r.pid)) || testo(r.application_name) === nostroAppName,
      interna,
    }));
  }
  return out;
}

/* --- Ordinamento, riassunto, filtro ---------------------------------------- */

// Peso dello stato: prima ciò su cui si interviene (bloccate, poi attive),
// in fondo ciò che sta fermo. Dentro ogni gruppo, la più vecchia in cima: su un
// monitor di query in corso la domanda è sempre "chi sta girando da troppo".
const PESO_STATO = { [STATO_ATTESA]: 0, [STATO_ATTIVA]: 1, [STATO_SCONOSCIUTO]: 2, [STATO_INATTIVA]: 3 };

function ordina(sessioni) {
  return [...(sessioni || [])].sort((a, b) => {
    // I processi di servizio non competono per l'attenzione: sempre in fondo.
    if (a.interna !== b.interna) return a.interna ? 1 : -1;
    // Chi blocca gli altri viene prima di tutto, anche prima delle bloccate:
    // è la riga su cui si agisce, e per stato può benissimo essere una
    // sessione "inattiva" che senza questa regola finirebbe in fondo alla
    // tabella — cioè fuori vista proprio mentre tiene fermo il database.
    if ((a.bloccaAltre > 0) !== (b.bloccaAltre > 0)) return a.bloccaAltre > 0 ? -1 : 1;
    if (a.bloccaAltre !== b.bloccaAltre) return b.bloccaAltre - a.bloccaAltre;
    const pa = PESO_STATO[a.stato] != null ? PESO_STATO[a.stato] : 2;
    const pb = PESO_STATO[b.stato] != null ? PESO_STATO[b.stato] : 2;
    if (pa !== pb) return pa - pb;
    const sa = a.secondi == null ? -1 : a.secondi;
    const sb = b.secondi == null ? -1 : b.secondi;
    if (sa !== sb) return sb - sa;
    return String(a.id).localeCompare(String(b.id));
  });
}

/* --- Il verdetto -----------------------------------------------------------
 * Chi apre questo pannello ha quasi sempre UNA domanda ("perché il database è
 * lento o fermo?") e vuole UNA risposta, non sette colonne da confrontare. Il
 * verdetto la dà in una riga e indica la sessione su cui agire.
 *
 * L'ordine dei casi non è estetico, è la loro gravità reale:
 *
 *   1. qualcuno è BLOCCATO e si sa da chi → è l'unico caso in cui la riga da
 *      colpire non è quella che si nota (la vittima è ferma e visibile, il
 *      bloccante spesso non sta eseguendo niente);
 *   2. qualcuno è bloccato e non si sa da chi → si dice così, invece di
 *      indicare a caso;
 *   3. una query gira da troppo → il caso ovvio, e infatti quello per cui il
 *      pannello serve meno;
 *   4. una transazione aperta e ferma da un pezzo → non ha ancora bloccato
 *      nessuno, ma è la causa più comune del caso 1 di fra dieci minuti;
 *   5. niente di tutto questo → lo si dice, chiaramente. "Nessun problema" è
 *      una risposta utile quanto le altre: chiude la ricerca invece di
 *      lasciare l'utente a esaminare righe innocenti.
 * ------------------------------------------------------------------------- */

// Soglie: 30 s per una query, 60 s per una transazione ferma. Sono valori
// scelti a mano, non arrotondamenti — sotto i 30 s una query lenta è quasi
// sempre solo una query pesante, e una transazione appena aperta è lavoro
// normale.
const SOGLIA_QUERY_LENTA_S = 30;
const SOGLIA_TRANSAZIONE_S = 60;

/** Sessione su cui ha senso agire, con il modo giusto per quel suo stato. */
function azioneSu(sess) {
  if (!sess) return null;
  // Una sessione ferma non ha una query da annullare: l'unica azione che la
  // libera è chiudere la connessione. Proporre l'altra sarebbe proporre un
  // pulsante che riesce senza fare nulla.
  const modo = (sess.stato === STATO_INATTIVA) ? 'connessione' : 'query';
  if (sess.blocchi && sess.blocchi[modo]) return { id: sess.id, modo, impedita: sess.blocchi[modo] };
  return { id: sess.id, modo, impedita: null };
}

function diagnosi(sessioni) {
  const list = (sessioni || []).filter((s) => !s.interna);
  const perId = new Map(list.map((s) => [String(s.id), s]));

  const bloccate = list.filter((s) => s.stato === STATO_ATTESA);
  if (bloccate.length) {
    // Il bloccante che ne tiene ferme di più: è quello che, tolto, sblocca il
    // maggior numero di sessioni.
    const conteggi = new Map();
    for (const b of bloccate) for (const id of b.bloccataDa) conteggi.set(id, (conteggi.get(id) || 0) + 1);
    const [idPeggiore] = [...conteggi.entries()].sort((a, b) => b[1] - a[1])[0] || [];

    if (idPeggiore) {
      const bloccante = perId.get(idPeggiore);
      const quante = conteggi.get(idPeggiore);
      return {
        livello: 'allarme',
        titolo: `${bloccate.length} ${bloccate.length === 1 ? 'sessione ferma' : 'sessioni ferme'} in attesa di un lock`,
        dettaglio: bloccante
          // La frase deve dire la cosa controintuitiva: si agisce su chi tiene
          // il lock, non su chi è fermo ad aspettarlo — che è la riga che
          // l'utente ha davanti agli occhi e che istintivamente terminerebbe.
          ? `A ${quante > 1 ? 'tenerle' : 'tenerla'} ferm${quante > 1 ? 'e' : 'a'} è la sessione ${idPeggiore}${bloccante.utente ? ` di ${bloccante.utente}` : ''}, ${descriviBloccante(bloccante)}. Va fermata quella: ${quante > 1 ? 'quelle in attesa ripartiranno da sole' : 'quella in attesa ripartirà da sola'}.`
          : `A ${quante > 1 ? 'tenerle' : 'tenerla'} ferm${quante > 1 ? 'e' : 'a'} è la sessione ${idPeggiore}, che non compare in questo elenco (potrebbe essere oltre il limite di righe mostrate).`,
        azione: bloccante ? azioneSu(bloccante) : null,
      };
    }
    return {
      livello: 'allarme',
      titolo: `${bloccate.length} ${bloccate.length === 1 ? 'sessione ferma' : 'sessioni ferme'} in attesa di un lock`,
      dettaglio: 'Questo database non riporta quale sessione tenga il lock: cerca fra le transazioni aperte e le scritture più vecchie.',
      azione: null,
    };
  }

  const lente = list
    .filter((s) => s.secondiDi === 'query' && s.secondi != null && s.secondi >= SOGLIA_QUERY_LENTA_S)
    .sort((a, b) => b.secondi - a.secondi);
  if (lente.length) {
    const q = lente[0];
    return {
      livello: 'attenzione',
      titolo: lente.length === 1
        ? `Una query gira da ${formattaDurata(q.secondi)}`
        : `${lente.length} query girano da oltre ${SOGLIA_QUERY_LENTA_S} s (la più lunga da ${formattaDurata(q.secondi)})`,
      dettaglio: `Sessione ${q.id}${q.utente ? ` di ${q.utente}` : ''}${q.db ? ` su ${q.db}` : ''}.`,
      azione: azioneSu(q),
    };
  }

  const transazioni = list
    // Solo le sessioni FERME: una transazione aperta su una query in corso è
    // lavoro normale, e chiamarla "aperta e ferma" sarebbe falso oltre che
    // allarmistico. Il caso che interessa è quello di chi tiene i lock senza
    // fare nulla.
    .filter((s) => s.stato === STATO_INATTIVA && s.transazioneAperta && s.secondi != null && s.secondi >= SOGLIA_TRANSAZIONE_S)
    .sort((a, b) => b.secondi - a.secondi);
  if (transazioni.length) {
    const t = transazioni[0];
    return {
      livello: 'attenzione',
      titolo: `${transazioni.length === 1 ? 'Una transazione aperta e ferma' : `${transazioni.length} transazioni aperte e ferme`} da oltre ${formattaDurata(t.secondi)}`,
      dettaglio: 'Non sta consumando nulla, ma tiene i lock: è la causa più comune dei blocchi che compaiono poco dopo.',
      azione: azioneSu(t),
    };
  }

  const attive = list.filter((s) => s.stato === STATO_ATTIVA).length;
  return {
    livello: 'ok',
    titolo: attive ? `Nessun blocco e nessuna query lenta (${attive} in esecuzione)` : 'Nessuna query in corso',
    dettaglio: null,
    azione: null,
  };
}

function descriviBloccante(s) {
  if (s.transazioneAperta) return 'ferma dentro una transazione aperta';
  if (s.stato === STATO_INATTIVA) return 'inattiva ma con la connessione aperta';
  if (s.secondi != null) return `in esecuzione da ${formattaDurata(s.secondi)}`;
  return 'in esecuzione';
}

/** Durata leggibile. Vive qui perché la usano sia il verdetto sia il client. */
function formattaDurata(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} m ${Math.round(sec % 60)} s`;
  return `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} m`;
}

/* --- Cosa è terminabile ---------------------------------------------------- */

/**
 * Motivo per cui la sessione NON può essere terminata nel modo richiesto,
 * oppure `null` se l'operazione ha senso.
 *
 * Restituisce una frase, non un booleano: il pulsante disabilitato senza
 * spiegazione è esattamente ciò che fa credere a un guasto. La stessa funzione
 * gira sul client (per disabilitare) e sul server (per rifiutare): la
 * decisione non può stare nella sola interfaccia, o basterebbe un evento
 * socket costruito a mano per uccidere una connessione di servizio.
 *
 * @param {object} sess descrittore normalizzato
 * @param {'query'|'connessione'} modo
 * @param {{ annullaQuery?: boolean, terminaConnessione?: boolean }} capacita del DBMS
 */
function motivoNonTerminabile(sess, modo, capacita = {}) {
  if (!sess) return 'Sessione non trovata: potrebbe essere già terminata.';
  if (sess.nostra) {
    return `È una connessione aperta da ${APP_NAME}: terminarla scollegherebbe questa scheda senza fermare nulla di ciò che stai guardando.`;
  }
  if (sess.interna) {
    return 'È un processo di servizio del server di database, non la query di un utente: terminarlo danneggia il server invece di sbloccarlo.';
  }
  if (modo === 'query') {
    if (capacita.annullaQuery === false) {
      return 'Questo database non sa annullare la singola query: si può solo terminare la connessione.';
    }
    if (sess.stato === STATO_INATTIVA && !sess.transazioneAperta) {
      return 'La sessione non sta eseguendo nulla: non c\'è una query da annullare. Per liberarla usa «Termina connessione».';
    }
    if (sess.stato === STATO_INATTIVA && sess.transazioneAperta) {
      return 'La sessione è ferma dentro una transazione aperta: non c\'è una query da annullare, e i lock restano finché la transazione non finisce. Per liberarli usa «Termina connessione».';
    }
    return null;
  }
  if (modo === 'connessione') {
    if (capacita.terminaConnessione === false) {
      return 'Questo database non espone la chiusura di una connessione altrui: si può solo annullare l\'operazione in corso.';
    }
    return null;
  }
  return `Modo di terminazione sconosciuto: "${modo}".`;
}

module.exports = {
  APP_NAME,
  MAX_SESSIONI,
  MAX_TESTO_QUERY,
  STATO_ATTIVA,
  STATO_ATTESA,
  STATO_INATTIVA,
  STATO_SCONOSCIUTO,
  SOGLIA_QUERY_LENTA_S,
  SOGLIA_TRANSAZIONE_S,
  normalizzaMongo,
  normalizzaMysql,
  normalizzaPostgres,
  collegaBlocchi,
  diagnosi,
  formattaDurata,
  ordina,
  motivoNonTerminabile,
};

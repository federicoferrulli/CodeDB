'use strict';

/* ---------------------------------------------------------------------------
 * Errori parlanti
 *
 * Gli errori che arrivano al browser sono, oggi, quelli grezzi dei driver:
 * "operation exceeded time limit", "ER_ACCESS_DENIED_ERROR", "connect
 * ECONNREFUSED 127.0.0.1:27017", "57014". Sono precisi ma dicono all'utente
 * *cosa* è successo nel driver, mai *perché* né *cosa fare* — e in beta questo
 * è il primo motivo per cui una segnalazione arriva senza informazioni utili.
 *
 * Questo modulo è l'unico punto in cui un errore tecnico diventa una frase
 * italiana con tre parti: cosa è successo, cosa fare, e il messaggio originale
 * conservato in coda (senza il quale una segnalazione diventa indiagnosticabile
 * — la spiegazione aiuta l'utente, il dettaglio aiuta noi).
 *
 * Due proprietà da preservare:
 *  - **Idempotenza**: `spiegaErrore` viene applicata nei punti di uscita
 *    (`errMsg` di server.js e del gateway MCP), che possono ricevere anche
 *    messaggi già nostri o già spiegati. Un messaggio che contiene già il
 *    marcatore viene restituito identico.
 *  - **Nessuna invenzione**: se l'errore non è riconosciuto si restituisce il
 *    messaggio originale immutato. Meglio un errore tecnico che una spiegazione
 *    plausibile e sbagliata.
 * ------------------------------------------------------------------------- */

// Marcatore di un messaggio già passato di qui: serve all'idempotenza.
const MARCATORE = 'Cosa fare:';

// I driver possono includere la stringa di connessione nel messaggio (specie
// quando la URI è malformata). Prima di inviarlo al browser o all'audit si
// eliminano userinfo, query string e frammento: tutti possono contenere segreti.
const URI_NEL_TESTO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s'\x22<>]+)/gi;

function redigiUri(testo) {
  return String(testo == null ? '' : testo).replace(URI_NEL_TESTO, (_tutto, schema, resto) => {
    let pulito = resto;
    const at = pulito.lastIndexOf('@');
    if (at >= 0) pulito = '***@' + pulito.slice(at + 1);
    const query = pulito.search(/[?#]/);
    if (query >= 0) pulito = pulito.slice(0, query) + '?…';
    return schema + pulito;
  });
}

// Estrazione difensiva del messaggio: questa funzione sta sul percorso di OGNI
// errore dell'applicazione, quindi non può a sua volta fallire — un oggetto con
// un getter `message` difettoso (o un toString che esplode) trasformerebbe un
// errore gestito in un crash del gestore, cioè in un client appeso.
function testo(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  try {
    return err.message || String(err);
  } catch {
    return '';
  }
}

// Codice normalizzato a stringa maiuscola: mysql2 usa ER_*, pg lo SQLSTATE,
// MongoDB un numero, Node i codici di sistema (ECONNREFUSED...).
function codiceDi(err) {
  if (!err || typeof err !== 'object') return '';
  const c = err.code != null ? String(err.code) : '';
  return c.toUpperCase();
}

function codeNameDi(err) {
  return (err && err.codeName ? String(err.codeName) : '').toLowerCase();
}

function nomeDi(err) {
  return (err && err.name ? String(err.name) : '').toLowerCase();
}

// Valori correnti dei limiti configurabili: citarli nel messaggio evita il
// classico "quanto vale questo timeout?" (e la variabile d'ambiente da toccare).
function msQueryTimeout() {
  const m = parseInt(process.env.CODEDB_QUERY_TIMEOUT_MS, 10);
  return Number.isFinite(m) ? Math.max(m, 0) : 30000;
}

function msAggregateTimeout() {
  const m = parseInt(process.env.CODEDB_AGGREGATE_TIMEOUT_MS, 10);
  return Number.isFinite(m) ? Math.max(m, 0) : 120000;
}

function msCountTimeout() {
  const m = parseInt(process.env.CODEDB_COUNT_TIMEOUT_MS, 10);
  return Number.isFinite(m) ? Math.max(m, 0) : 5000;
}

// Destinazione leggibile dal contesto ("localhost:27017"), quando nota.
function bersaglio(ctx) {
  if (!ctx) return '';
  const host = ctx.host || '';
  const port = ctx.port || '';
  if (host && port) return `${host}:${port}`;
  return host || '';
}

/* ---------------------------------------------------------------------------
 * Regole di riconoscimento
 *
 * Ogni regola ritorna { causa, rimedio } oppure null. L'ordine conta: si va
 * dal codice più specifico al pattern testuale più generico.
 * ------------------------------------------------------------------------- */

// --- Rete e raggiungibilità -------------------------------------------------

function regolaRete(err, ctx) {
  const code = codiceDi(err);
  const msg = testo(err).toLowerCase();
  const dove = bersaglio(ctx);
  const suDove = dove ? ` su ${dove}` : '';

  if (code === 'ECONNREFUSED' || msg.includes('econnrefused')) {
    return {
      causa: `Connessione rifiutata${suDove}: nessun servizio è in ascolto su quell'indirizzo e quella porta`,
      rimedio: 'verifica che il database sia avviato e che host e porta siano quelli giusti. Se il database è in Docker, controlla che la porta sia pubblicata sull\'host',
    };
  }
  if (code === 'ENOTFOUND' || msg.includes('enotfound') || msg.includes('getaddrinfo')) {
    return {
      causa: `Nome host non risolto${suDove}: il DNS non conosce questo indirizzo`,
      rimedio: 'controlla di non aver sbagliato a digitare il nome host; se è un nome interno (VPN, Docker, rete aziendale) verifica di essere sulla rete giusta',
    };
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || msg.includes('etimedout')) {
    return {
      causa: `Nessuna risposta${suDove} entro il tempo massimo di connessione`,
      rimedio: 'di solito è un firewall che scarta i pacchetti, o un host irraggiungibile: verifica la raggiungibilità della porta e, se serve, apri un tunnel SSH dalla scheda di connessione',
    };
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return {
      causa: `Host o rete irraggiungibile${suDove}`,
      rimedio: 'controlla la connettività di rete (VPN, routing) verso quell\'indirizzo',
    };
  }
  if (code === 'ECONNRESET' || msg.includes('econnreset') || msg.includes('socket hang up')) {
    return {
      causa: 'La connessione è stata chiusa di colpo dall\'altro capo',
      rimedio: 'può essere il database riavviato, un timeout di inattività del server o un firewall che chiude le connessioni ferme: riprova, e se accade spesso controlla i log del database',
    };
  }
  if (code === 'EPIPE' || msg.includes('protocol_connection_lost')) {
    return {
      causa: 'Connessione al database persa durante l\'operazione',
      rimedio: 'CodeDB tenta la riconnessione automatica: se l\'errore si ripete, controlla che il database sia ancora attivo',
    };
  }
  if (code === 'EADDRINUSE') {
    return {
      causa: 'Porta già occupata da un altro processo',
      rimedio: 'chiudi l\'istanza già in ascolto oppure avvia CodeDB su un\'altra porta con la variabile PORT',
    };
  }
  return null;
}

// --- Autenticazione e permessi ---------------------------------------------

function regolaAuth(err, ctx) {
  const code = codiceDi(err);
  const msg = testo(err).toLowerCase();
  const codeName = codeNameDi(err);
  const tipo = (ctx && ctx.dbType) || '';

  // MongoDB: 18 AuthenticationFailed
  if (code === '18' || codeName === 'authenticationfailed'
    || (msg.includes('authentication failed') && tipo !== 'mysql')) {
    return {
      causa: 'Autenticazione al database non riuscita: utente o password non accettati',
      rimedio: 'controlla utente e password; su MongoDB verifica anche il campo "authSource" (l\'utente è spesso definito su "admin", non sul database che stai aprendo)',
    };
  }
  // MySQL: 1045 ER_ACCESS_DENIED_ERROR / 1044 ER_DBACCESS_DENIED_ERROR
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR') {
    return {
      causa: 'Accesso negato da MySQL: utente o password non validi per questo host',
      rimedio: 'verifica le credenziali. MySQL lega l\'utente all\'host di provenienza: un utente creato come \'utente\'@\'localhost\' non può entrare da un altro indirizzo',
    };
  }
  if (code === 'ER_DBACCESS_DENIED_ERROR') {
    return {
      causa: 'L\'utente MySQL non ha i permessi su questo database',
      rimedio: 'chiedi un GRANT sul database, oppure connettiti con un utente che li possiede',
    };
  }
  // PostgreSQL: 28P01 password errata, 28000 regola pg_hba
  if (code === '28P01') {
    return {
      causa: 'PostgreSQL ha rifiutato la password per questo utente',
      rimedio: 'controlla utente e password',
    };
  }
  if (code === '28000') {
    return {
      causa: 'PostgreSQL ha rifiutato la connessione per la configurazione di autenticazione (pg_hba.conf)',
      rimedio: 'l\'indirizzo da cui ti colleghi o il metodo di autenticazione non sono ammessi: serve una riga in pg_hba.conf sul server',
    };
  }
  // Permessi sull'operazione (non sull'accesso)
  if (code === '13' || codeName === 'unauthorized') {
    return {
      causa: 'L\'utente MongoDB non è autorizzato a questa operazione',
      rimedio: 'servono privilegi maggiori sul database (ruolo readWrite o dbAdmin a seconda dell\'operazione): l\'utente attuale non li ha',
    };
  }
  if (code === 'ER_TABLEACCESS_DENIED_ERROR' || code === 'ER_COLUMNACCESS_DENIED_ERROR'
    || code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR') {
    return {
      causa: 'L\'utente MySQL non ha il permesso per questa operazione sulla tabella',
      rimedio: 'serve un GRANT specifico (SELECT, INSERT, ALTER... a seconda del comando) per questo utente',
    };
  }
  if (code === '42501') {
    return {
      causa: 'Privilegi PostgreSQL insufficienti per questa operazione',
      rimedio: 'serve un GRANT sull\'oggetto (tabella, schema o sequenza) per l\'utente con cui sei connesso',
    };
  }
  return null;
}

// --- Timeout e interruzioni -------------------------------------------------

function regolaTimeout(err) {
  const code = codiceDi(err);
  const codeName = codeNameDi(err);
  const msg = testo(err).toLowerCase();

  // MongoDB: maxTimeMS scaduto (codice 50)
  if (code === '50' || codeName === 'maxtimemsexpired'
    || msg.includes('operation exceeded time limit')) {
    return {
      causa: `La query ha superato il tempo massimo consentito (${msQueryTimeout()} ms per una lettura, ${msAggregateTimeout()} ms per un'aggregazione) ed è stata interrotta dal server`,
      rimedio: 'restringi il filtro o riduci le righe lette, crea un indice sui campi filtrati/ordinati (la vista Dettagli mostra quelli esistenti); se l\'attesa lunga è prevista, alza il limite con le variabili d\'ambiente CODEDB_QUERY_TIMEOUT_MS e CODEDB_AGGREGATE_TIMEOUT_MS',
    };
  }
  // PostgreSQL: 57014 query_canceled (statement_timeout o annullamento manuale)
  if (code === '57014' || msg.includes('canceling statement due to statement timeout')) {
    return {
      causa: `Query annullata: ha superato il tempo massimo consentito (${msQueryTimeout()} ms) oppure è stata interrotta manualmente`,
      rimedio: 'restringi il filtro, aggiungi un indice sulle colonne filtrate/ordinate, oppure alza il limite con la variabile d\'ambiente CODEDB_QUERY_TIMEOUT_MS',
    };
  }
  // MySQL: 3024 max_execution_time, 1317 interrotta (KILL QUERY)
  if (code === 'ER_QUERY_TIMEOUT' || msg.includes('maximum statement execution time exceeded')) {
    return {
      causa: `Query interrotta da MySQL: ha superato il tempo massimo consentito (${msQueryTimeout()} ms)`,
      rimedio: 'restringi il filtro, aggiungi un indice sulle colonne filtrate/ordinate, oppure alza il limite con la variabile d\'ambiente CODEDB_QUERY_TIMEOUT_MS',
    };
  }
  if (code === 'ER_QUERY_INTERRUPTED' || msg.includes('query execution was interrupted')) {
    return {
      causa: 'Query interrotta prima di finire',
      rimedio: 'è quello che succede quando si annulla una query dalla griglia: se non l\'hai annullata tu, può averlo fatto un amministratore del database o un timeout del server',
    };
  }
  // Attese sui lock
  if (code === 'ER_LOCK_WAIT_TIMEOUT' || msg.includes('lock wait timeout exceeded')) {
    return {
      causa: 'Attesa troppo lunga su una riga bloccata da un\'altra transazione',
      rimedio: 'un\'altra sessione sta tenendo un lock sulle stesse righe: aspetta che finisca (o chiudila) e riprova',
    };
  }
  if (code === '55P03' || msg.includes('could not obtain lock')) {
    return {
      causa: 'Impossibile ottenere il lock sulla tabella: è occupata da un\'altra transazione',
      rimedio: 'attendi la fine dell\'operazione concorrente e riprova',
    };
  }
  // Il riconoscimento richiede il CODICE, o in mancanza la frase completa del
  // driver. Cercare la sola parola "deadlock" nel messaggio è una ricerca di
  // sottostringa su un testo che contiene i nomi scelti dall'utente: una
  // tabella `deadlock_log` inesistente produceva la spiegazione del deadlock,
  // e visto che questa regola è terza mentre quella degli oggetti mancanti è
  // sesta, il messaggio giusto non veniva mai raggiunto. È l'unico punto in cui
  // il modulo violava la propria regola: meglio l'errore tecnico che una
  // spiegazione plausibile e sbagliata, che manda a cercare la causa sbagliata.
  if (code === 'ER_LOCK_DEADLOCK' || code === '40P01'
      || msg.includes('deadlock found when trying to get lock')
      || msg.includes('deadlock detected')) {
    return {
      causa: 'Deadlock: due operazioni si aspettano a vicenda e il database ne ha annullata una',
      rimedio: 'riprova l\'operazione; se accade spesso, esegui le scritture nello stesso ordine di tabella oppure a blocchi più piccoli',
    };
  }
  // Timeout di selezione del server MongoDB. Attenzione: il driver avvolge in
  // MongoServerSelectionError anche le cause di rete concrete (porta chiusa,
  // host non risolto), che sono in fondo al messaggio. Quando c'è una causa
  // riconoscibile si lascia la parola alle regole di rete: "connessione
  // rifiutata su localhost:27017" dice cosa fare, "nessun nodo raggiungibile"
  // no — ed è lo stesso testo per due problemi diversi.
  if (nomeDi(err).includes('serverselection') || msg.includes('server selection timed out')) {
    const causaConcreta = /econnrefused|enotfound|getaddrinfo|etimedout|ehostunreach|enetunreach|econnreset/.test(msg);
    if (causaConcreta) return null;
    return {
      causa: 'Nessun nodo MongoDB raggiungibile entro il tempo di attesa',
      rimedio: 'controlla che il server sia avviato e raggiungibile; se è un replica set dietro tunnel SSH, usa la modalità "Parametri" (CodeDB imposta directConnection) invece dell\'URI completa',
    };
  }
  if (msg.includes('timeout exceeded when trying to connect') || msg.includes('pool timeout')
    || code === 'POOL_CLOSED' || msg.includes('queue limit')) {
    return {
      causa: 'Nessuna connessione libera nel pool entro il tempo di attesa',
      rimedio: 'ci sono troppe query lente in corso su questa connessione: attendi che finiscano o annullale dal registro delle query in sospeso',
    };
  }
  // Timeout interni di CodeDB (withTimeout): già leggibili, ma senza rimedio.
  const scaduta = testo(err).match(/^(.+?) scaduta dopo (\d+) ms$/);
  if (scaduta) {
    return {
      causa: `${scaduta[1]} non ha risposto entro ${scaduta[2]} ms`,
      rimedio: 'la connessione potrebbe essere caduta (database fermo o tunnel SSH interrotto): controllala nel pannello Salute delle Connessioni',
    };
  }
  return null;
}

// --- Oggetti mancanti e sintassi -------------------------------------------

function regolaOggetti(err) {
  const code = codiceDi(err);
  const codeName = codeNameDi(err);
  const msg = testo(err);
  const low = msg.toLowerCase();

  if (code === 'ER_NO_SUCH_TABLE' || code === '42P01') {
    // Su PostgreSQL la causa più frequente non è un nome sbagliato: è un nome
    // GIUSTO scritto senza virgolette. Il motore abbassa gli identificatori non
    // quotati, quindi una tabella creata come "Prova" risponde solo a "Prova" —
    // e l'errore, che cita il nome già abbassato ("prova"), sembra dire che la
    // tabella non c'è. Dirlo qui evita mezz'ora di ricerche a vuoto.
    const nome = (/relation "([^"]+)" does not exist/i.exec(msg) || [])[1] || '';
    const forseMaiuscole = code === '42P01' && nome && nome === nome.toLowerCase();
    return {
      causa: 'La tabella indicata non esiste in questo database',
      rimedio: forseMaiuscole
        ? 'se il nome ha delle maiuscole va scritto fra doppi apici — PostgreSQL abbassa gli identificatori non quotati, quindi `FROM schema.Prova` cerca `prova`: scrivi `FROM schema."Prova"`. Controlla poi il nome e ricorda che il livello "database" della sidebar è lo schema'
        : 'controlla il nome (maiuscole comprese: su Linux MySQL le distingue) e che tu sia sul database giusto. Su PostgreSQL ricorda che il livello "database" della sidebar è lo schema',
    };
  }
  if (code === '3D000' || code === 'ER_BAD_DB_ERROR') {
    return {
      causa: 'Il database indicato non esiste',
      rimedio: 'controlla il nome del database nella configurazione della connessione',
    };
  }
  if (code === '3F000') {
    return {
      causa: 'Lo schema PostgreSQL indicato non esiste',
      rimedio: 'su PostgreSQL il livello "database" della sidebar è lo SCHEMA: verifica di averne aperto uno esistente',
    };
  }
  if (code === 'ER_BAD_FIELD_ERROR' || code === '42703') {
    return {
      causa: 'Una colonna citata nella query non esiste',
      rimedio: 'controlla il nome della colonna (la vista Dettagli elenca quelle esistenti); se l\'hai messa fra virgolette doppie su PostgreSQL, il nome diventa sensibile alle maiuscole',
    };
  }
  if (code === 'ER_PARSE_ERROR' || code === '42601') {
    return {
      causa: 'Errore di sintassi SQL: il database non riesce a interpretare la query',
      rimedio: 'controlla il punto segnalato nel dettaglio qui sotto — di solito è una parola chiave scritta male, una parentesi non chiusa o una virgola di troppo prima di FROM',
    };
  }
  if (code === '26' || codeName === 'namespacenotfound') {
    return {
      causa: 'La collection indicata non esiste',
      rimedio: 'controlla il nome (MongoDB distingue maiuscole e minuscole) e il database aperto',
    };
  }
  if (code === 'ER_TABLE_EXISTS_ERROR' || code === '42P07' || code === '48' || codeName === 'namespaceexists') {
    return {
      causa: 'Esiste già un oggetto con questo nome',
      rimedio: 'scegli un altro nome, oppure elimina prima quello esistente',
    };
  }
  if (code === 'ER_DB_CREATE_EXISTS' || code === '42P04') {
    return {
      causa: 'Il database esiste già',
      rimedio: 'scegli un altro nome',
    };
  }
  if (low.includes('unknown column') && low.includes('in \'where clause\'')) {
    return {
      causa: 'Il filtro cita una colonna che non esiste',
      rimedio: 'nel campo filtro delle tabelle SQL si scrive una condizione WHERE (es. stato = \'attivo\'): controlla i nomi delle colonne',
    };
  }
  return null;
}

// --- Vincoli e tipi di dato -------------------------------------------------

function regolaVincoli(err) {
  const code = codiceDi(err);
  const msg = testo(err);
  const low = msg.toLowerCase();

  if (code === 'ER_DUP_ENTRY' || code === '23505' || code === '11000'
    || low.includes('duplicate key error')) {
    return {
      causa: 'Valore duplicato: un vincolo di unicità impedisce di inserire questo dato',
      rimedio: 'esiste già una riga con lo stesso valore nella colonna (o nell\'indice) unica indicata nel dettaglio: cambia il valore, oppure modifica la riga esistente invece di inserirne una nuova',
    };
  }
  if (code === 'ER_NO_REFERENCED_ROW' || code === 'ER_NO_REFERENCED_ROW_2' || code === '23503') {
    return {
      causa: 'Chiave esterna non soddisfatta: il valore inserito non esiste nella tabella collegata',
      rimedio: 'inserisci prima la riga nella tabella riferita, oppure usa un valore già presente',
    };
  }
  if (code === 'ER_ROW_IS_REFERENCED' || code === 'ER_ROW_IS_REFERENCED_2') {
    return {
      causa: 'La riga non può essere eliminata: altre tabelle la referenziano',
      rimedio: 'elimina prima le righe collegate, oppure definisci la chiave esterna con ON DELETE CASCADE',
    };
  }
  if (code === 'ER_BAD_NULL_ERROR' || code === '23502') {
    return {
      causa: 'Una colonna obbligatoria è stata lasciata vuota',
      rimedio: 'la colonna indicata nel dettaglio è NOT NULL: inserisci un valore (o dai un DEFAULT alla colonna)',
    };
  }
  if (code === '23514' || code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
    return {
      causa: 'Un vincolo CHECK della tabella rifiuta questo valore',
      rimedio: 'il valore non rispetta la regola definita sulla colonna: guarda il nome del vincolo nel dettaglio',
    };
  }
  if (code === '22P02' || code === 'ER_TRUNCATED_WRONG_VALUE' || code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD') {
    return {
      causa: 'Valore non compatibile con il tipo della colonna',
      rimedio: 'controlla il formato: un testo in una colonna numerica, o una data scritta in un formato che il database non riconosce (usa AAAA-MM-GG)',
    };
  }
  if (code === 'ER_DATA_TOO_LONG' || code === '22001') {
    return {
      causa: 'Il valore è più lungo di quanto la colonna consenta',
      rimedio: 'accorcia il testo oppure allarga la colonna (VARCHAR più capiente, o TEXT)',
    };
  }
  if (code === 'ER_WARN_DATA_OUT_OF_RANGE' || code === '22003') {
    return {
      causa: 'Valore numerico fuori dall\'intervallo ammesso dalla colonna',
      rimedio: 'usa un valore più piccolo o un tipo numerico più capiente (BIGINT, NUMERIC)',
    };
  }
  if (code === '2') { // Mongo BadValue
    return {
      causa: 'MongoDB ha rifiutato un valore della query',
      rimedio: 'controlla la forma del filtro o della pipeline: spesso è un operatore usato dove serve un valore, o un tipo sbagliato (stringa al posto di ObjectId)',
    };
  }
  if (code === '121' || low.includes('document failed validation')) {
    return {
      causa: 'Il documento non rispetta le regole di validazione della collection',
      rimedio: 'la collection ha uno schema di validazione: controlla campi obbligatori e tipi attesi',
    };
  }
  return null;
}

// --- Risorse e limiti -------------------------------------------------------

function regolaRisorse(err) {
  const code = codiceDi(err);
  const low = testo(err).toLowerCase();

  if (code === 'ER_CON_COUNT_ERROR' || code === '53300' || low.includes('too many connections')
    || low.includes('too many clients already')) {
    return {
      causa: 'Il database ha raggiunto il numero massimo di connessioni consentite',
      rimedio: 'chiudi qualche tab o applicazione collegata al database, oppure alza il limite lato server (max_connections)',
    };
  }
  if (code === 'ENOSPC' || code === '53100' || low.includes('no space left')) {
    return {
      causa: 'Spazio su disco esaurito',
      rimedio: 'libera spazio sul disco che ospita il database (o la cartella dei backup) e riprova',
    };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      causa: 'Permessi del file system insufficienti per questa operazione',
      rimedio: 'CodeDB non può leggere o scrivere il file indicato: controlla i permessi della cartella (connessioni salvate, backup o log)',
    };
  }
  if (code === 'EMFILE' || code === 'ENFILE') {
    return {
      causa: 'Troppi file aperti contemporaneamente dal processo',
      rimedio: 'chiudi qualche operazione in corso (backup, import) e riprova',
    };
  }
  if (low.includes('javascript heap out of memory')) {
    return {
      causa: 'Memoria del processo CodeDB esaurita',
      rimedio: 'l\'operazione ha caricato troppi dati in memoria: riduci il numero di righe (LIMIT, filtri) oppure usa la CLI di backup per i volumi grandi',
    };
  }
  if (code === '16389' || low.includes('bsonobj size') || low.includes('object to insert too large')) {
    return {
      causa: 'Documento troppo grande per MongoDB (limite 16 MB)',
      rimedio: 'dividi il documento, oppure sposta i dati voluminosi su GridFS o su un campo separato',
    };
  }
  return null;
}

// --- Tunnel SSH -------------------------------------------------------------

function regolaSsh(err) {
  const msg = testo(err);
  const low = msg.toLowerCase();
  if (!low.includes('ssh') && !low.includes('authentication methods failed')
    && !low.includes('host key')) return null;

  if (low.includes('all configured authentication methods failed')) {
    return {
      causa: 'Il server SSH ha rifiutato tutte le credenziali fornite',
      rimedio: 'controlla utente e password SSH, oppure il percorso della chiave privata e la sua passphrase',
    };
  }
  if (low.includes('host key') || low.includes('impronta')) {
    return {
      causa: 'La chiave del server SSH non corrisponde a quella memorizzata',
      rimedio: 'può essere un server reinstallato — oppure una connessione intercettata. Se il cambiamento è atteso, aggiorna l\'impronta salvata nella connessione; altrimenti non collegarti',
    };
  }
  if (low.includes('ssh') && (low.includes('timed out') || low.includes('timeout'))) {
    return {
      causa: 'Il server SSH non ha risposto entro il tempo di attesa',
      rimedio: 'verifica host e porta SSH (di solito 22) e che il server sia raggiungibile dalla tua rete',
    };
  }
  return null;
}

// --- Stato di CodeDB (vault, sessioni) -------------------------------------

// Messaggi già nostri e già in italiano: non c'è nulla da tradurre, manca solo
// il "cosa fare". `nascondiTecnico` evita di ripetere in coda la stessa frase
// che si legge in testa.
function regolaCodeDb(err) {
  const msg = testo(err);
  const low = msg.toLowerCase();

  if (low.startsWith('nessuna connessione attiva')) {
    return {
      nascondiTecnico: true,
      causa: 'Nessuna connessione attiva per questa scheda',
      rimedio: 'la sessione è caduta (server riavviato o pagina rimasta aperta a lungo): riapri la connessione dalla barra laterale',
    };
  }
  if (low.startsWith('permesso negato')) {
    return {
      nascondiTecnico: true,
      causa: msg.replace(/\.$/, ''),
      rimedio: 'chiedi a chi amministra l\'installazione un permesso più ampio su questa connessione',
    };
  }
  if (low.includes('vault bloccato')) {
    return {
      nascondiTecnico: true,
      causa: msg.replace(/\.$/, ''),
      rimedio: 'inserisci la passphrase nella finestra di sblocco; se l\'hai persa, dalla stessa finestra puoi ripartire con un vault nuovo (le connessioni salvate vengono messe da parte, non cancellate)',
    };
  }
  return null;
}

const REGOLE = [
  regolaCodeDb,
  regolaSsh,
  regolaTimeout,
  regolaAuth,
  regolaRete,
  regolaOggetti,
  regolaVincoli,
  regolaRisorse,
];

/* ---------------------------------------------------------------------------
 * API pubblica
 * ------------------------------------------------------------------------- */

// Riconosce l'errore e ne restituisce le parti, oppure null se non è noto.
function descriviErrore(err, ctx = {}) {
  if (err == null) return null;
  const msg = testo(err);
  if (!msg || msg.includes(MARCATORE)) return null;
  for (const regola of REGOLE) {
    let esito = null;
    try {
      esito = regola(err, ctx);
    } catch {
      esito = null; // una regola difettosa non deve mai sostituire l'errore vero
    }
    if (esito) return { ...esito, tecnico: msg };
  }
  return null;
}

// Errore tecnico → frase parlante. Se l'errore non è riconosciuto, il messaggio
// originale torna indietro immutato: nessuna spiegazione inventata.
function spiegaErrore(err, ctx = {}) {
  const msg = testo(err);
  const d = descriviErrore(err, ctx);
  if (!d) return redigiUri(msg);
  // Il dettaglio tecnico resta in coda: senza, una segnalazione dalla beta
  // arriva senza il codice del driver e non è diagnosticabile. Fa eccezione ciò
  // che era già un messaggio nostro: ripeterlo aggiungerebbe solo rumore.
  const tecnico = d.tecnico && d.tecnico !== d.causa && !d.nascondiTecnico
    ? ` (dettaglio tecnico: ${d.tecnico})` : '';
  return redigiUri(`${d.causa}. ${MARCATORE} ${d.rimedio}.${tecnico}`);
}

module.exports = { spiegaErrore, descriviErrore, redigiUri, MARCATORE };

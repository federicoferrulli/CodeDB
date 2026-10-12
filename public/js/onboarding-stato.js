'use strict';

/* ---------------------------------------------------------------------------
 * Stato dell'onboarding — modulo FOGLIA e puro.
 *
 * Sta a parte dall'interfaccia (`onboarding.js`) per due motivi:
 *
 *  1. è la parte che, sbagliata, si manifesta come una molestia: una guida che
 *     ricompare a ogni avvio, o che NON compare mai dopo un aggiornamento, è un
 *     difetto che si scopre solo settimane dopo su una macchina altrui. Qui è
 *     provabile in Node (`test/unit-onboarding.js`) con uno storage finto;
 *  2. i traguardi vengono segnati da moduli sparsi (connection, colltabs,
 *     query-tab, backupmanager): importare da loro l'intero `onboarding.js`
 *     significherebbe trascinare la UI dentro il ciclo di import già noto di
 *     `utils.js`. Questo file non importa NULLA.
 *
 * Persistenza in `localStorage` (non `sessionStorage`: deve sopravvivere alla
 * chiusura del browser, altrimenti la guida ricomparirebbe ogni giorno).
 * ------------------------------------------------------------------------- */

export const CHIAVE = 'codedb:onboarding';

/** I "primi passi" della checklist. L'ordine è quello in cui si incontrano. */
export const TRAGUARDI = [
  {
    id: 'connessione',
    etichetta: 'Crea la prima connessione',
    aiuto: 'Barra sinistra → ＋ Aggiungi connessione. Le credenziali restano sul server, cifrate nel vault: il browser non le vede mai.',
  },
  {
    id: 'tabella',
    etichetta: 'Apri una tabella o collection',
    aiuto: 'Scegli un database nella barra e clicca una tabella: si apre in una scheda con i suoi dati.',
  },
  {
    id: 'query',
    etichetta: 'Esegui una query',
    aiuto: 'Vista Query & Aggregate: SQL, pipeline MQL o sintassi mongosh. Su MongoDB anche SELECT tradotte.',
  },
  {
    id: 'grafico',
    etichetta: 'Disegna un grafico dai risultati',
    aiuto: 'Nei risultati della query, scheda Grafici: scegli categoria e misura, oppure parti dai grafici suggeriti.',
  },
  {
    id: 'backup',
    etichetta: 'Fai un backup',
    // NB: niente “⋮” nei testi — il font dell'interfaccia non ha quel glifo e
    // in pagina si vede uno spazio vuoto al suo posto.
    aiuto: 'Menu Strumenti & Utility → Backup & Restore: full, incrementale o differenziale, con checksum verificabile.',
  },
];

/**
 * Novità per versione, dalla più recente. Vengono mostrate DOPO un
 * aggiornamento a chi ha già visto l'onboarding: solo le voci con versione
 * maggiore di quella vista l'ultima volta.
 *
 * Manutenzione: aggiungere qui una voce quando si alza `version` in
 * package.json. Un elenco vuoto (o una versione già vista) = nessuna modale.
 */
export const NOVITA = [
  {
    versione: '0.2.0-beta.1',
    punti: [
      "Componenti Arc UI integrati nei pulsanti, campi, selettori, calendari e finestre dell’app. Navigatore, schede e apertura dei pannelli hanno transizioni coordinate, con supporto alla preferenza di movimento ridotto. Arc UI Components compare anche nell’elenco delle librerie con la relativa licenza.",
      "Schermate e strumenti ridisegnati: stato iniziale «Esplora i dati», dettagli delle tabelle, modifica delle connessioni, Backup & Restore, Sessioni, Salute, palette dei comandi e guida introduttiva. Anche le mappe dei risultati e delle geometrie selezionate hanno comandi e riepiloghi riorganizzati.",
      "Query & Aggregate riorganizzata: editor, risultati e Schema Browser hanno controlli più leggibili e stati di esecuzione distinti. Si possono eseguire query anche su database o schemi senza tabelle; la destinazione può essere il solo database. Corretti apertura, scelta e posizionamento del selettore del motore.",
      "Inserimento dei record ridisegnato per MongoDB, MySQL e PostgreSQL: campi specifici per numeri esatti, binari, date, tipi BSON e geometrie, con input nativo per array, intervalli e tipi SQL personalizzati. Valore, NULL e predefinito sono scelte distinte; il passaggio fra modulo e JSON conserva i numeri grandi e le colonne generate restano gestite dal database.",
      "Registro delle query in sospeso riorganizzato con ricerca, filtri per stato e dettaglio leggibile degli errori. Si possono riprendere query e script, copiare il testo esatto e annullare la pulizia del registro; gli elenchi lunghi mantengono la visualizzazione delle sole voci visibili.",
      "Mobile: pannelli, finestre e menu rispettano le aree riservate a notch, bordi e tastiera. Corretto il salto verso l’alto durante lo scorrimento della vista JSON Tree in Chrome: l’aggiornamento delle righe visibili conserva la posizione e il focus.",
      "Grafici su mobile: tipo, categoria, misura e calcolo sono disposti su due colonne. I menu mostrano i nomi lunghi su più righe e offrono opzioni più ampie da toccare. La personalizzazione scorre insieme al grafico e dispone del comando «Torna al grafico», anche in orientamento orizzontale.",
      "Download adattati al browser mobile e al selettore di salvataggio Android: nome e contenuto dei file vengono conservati, con gestione di attesa, annullamento ed errori. Negli import, scegliere un altro file o chiudere la finestra durante la lettura non applica più un risultato precedente; gli errori di lettura sono segnalati anche per connessioni e snapshot.",
      "Conteggi nel navigatore aggiornati dopo le modifiche ai dati: si distinguono conteggio esatto, stima e limite minimo. Una tabella bloccata o troppo grande non ferma l’apertura del database; un conteggio non disponibile viene indicato come tale, senza trasformarlo in zero.",
      "Preproduzione: aggiornate le dipendenze vulnerabili e il runtime Docker a Node 24 LTS. I pacchetti Windows, portatili e Docker includono solo i file necessari all’app, escludendo export locali e materiale di sviluppo. L’immagine Docker richiede autenticazione e TLS quando l’esposizione locale non è dichiarata esplicitamente.",
      "Transazioni SQL affidabili: BEGIN, COMMIT e ROLLBACK conservano la stessa connessione in MySQL e PostgreSQL, anche con script concorrenti e file suddivisi in blocchi. Tabelle temporanee e variabili restano disponibili nello script. Una transazione lasciata aperta alla fine viene annullata con un avviso; una risposta persa durante una riconnessione non causa più la ripetizione automatica dell’operazione.",
      "Corretti COUNT, GROUP BY, DISTINCT e alias SQL su MongoDB. I Virtual JOIN usano le connessioni delle due sorgenti, conservano tutte le corrispondenze e segnalano quando un limite impedisce un risultato completo; le chiavi SQL sono passate come parametri.",
      "Il limite dei risultati conta i byte UTF-8 e comprende anche una prima riga troppo grande. Le revisioni dello schema rilevano modifiche a nomi, tipi e relazioni; la cronologia conserva query con spazi diversi nei letterali e query eseguite su collezioni diverse.",
      "Split-View con comandi completi in ogni riquadro: ricerca, paginazione, selezione delle celle, modifica, inserimento, dettagli e query restano indipendenti. Anche gli aggiornamenti live raggiungono il solo pannello interessato. Bozze, filtri e pagina si conservano durante i cambi di vista; una risposta in ritardo non sovrascrive più un’altra tabella.",
      "Grafo 3D: barra dei comandi ridisegnata, con i comandi di inquadratura sul canvas. «Vista 2D» appiattisce davvero la simulazione, «Rotazione automatica» ora funziona, lo sfondo segue il tema chiaro e «Solo popolate» filtra per numero di righe. Corretta la centratura sui singoli nodi: la telecamera mantiene la distanza dal bersaglio, interrompe il movimento precedente e lascia il controllo al trascinamento manuale, senza sovrapporre animazioni di inquadratura.",
      "Trasferimento dei tipi esteso nei formati CodeDB, SQL e nei backup: BSON grezzo e GridFS su MongoDB; ENUM/SET, binari e geometrie con SRID su MySQL; array, tipi personalizzati, riferimenti a funzioni e Large Object su PostgreSQL. Corrette anche paginazione, identità e cancellazioni incrementali. La consistenza della copia è dichiarata in base al motore e alla snapshot disponibile.",
      "«Importa database» accetta anche dump SQL testuali MySQL e PostgreSQL, inclusi mysqldump e pg_dump plain, con anteprima, verifica e recupero in caso di errore. Il file deve contenere un solo database o schema del motore selezionato; dimensioni e quote vengono controllate prima dell’import. L’export CodeDB di una singola tabella è disponibile dal suo menu.",
      "Export dell’intero database a blocchi nei formati CodeDB e SQL, con file preparato dal server, verifica dei conteggi e checksum prima del download. L’export CSV resta disponibile per le singole tabelle. Il tetto di tempo sulla query libera vale anche sulle scritture, evitando che un UPDATE trattenga una connessione senza limite.",
    ],
  },
  {
    versione: '0.1.5-beta.1',
    punti: [
      "Integrità dei dati SQL: numeri interi grandi conservati alla lettera. Un BIGINT oltre i 9.007.199.254.740.992 veniva arrotondato dal driver MySQL prima ancora di arrivare a CodeDB, quindi griglia, export, import e backup mostravano e scrivevano un numero diverso da quello nel database, senza alcun avviso. Ora il valore resta esatto lungo tutto il percorso, ripristino di un backup compreso.",
      "Una colonna che si chiama davvero _id non viene più sovrascritta: su MySQL e PostgreSQL il suo valore era rimpiazzato dall'identificatore interno di riga e la colonna risultava non modificabile. Le colonne con DEFAULT CURRENT_TIMESTAMP non vengono più scambiate per colonne calcolate — erano escluse da export e backup, e al ripristino le date originali sparivano.",
      "Tabelle con colonne calcolate: il salvataggio della riga intera funziona di nuovo (l'editor includeva quei valori nell'aggiornamento e il database rifiutava la scrittura, quindi modificare un campo qualunque falliva) e l'export in formato SQL non produce più INSERT che al ripristino danno errore.",
      "Palette dei comandi con Ctrl+P: un elenco solo per comandi, connessioni salvate, database e tabelle di tutti i database aperti nella scheda. Si restringe la ricerca con > per i comandi, # per i database, @ per le tabelle.",
      "Filtro rapido nella griglia: si scrive del testo e si cerca in tutte le colonne, senza dover sapere se dietro c'è MongoDB o un motore SQL. La casella di prima resta disponibile come modalità «condizione», per una WHERE o un MQL scritti a mano. Aggiunti anche l'ordinamento su più colonne e la ricerca globale.",
      "Griglia più densa e finalmente coerente: l'altezza di riga ha una sola fonte e la densità passa da 42 a 30 px per riga — da 17 a 26 righe visibili su una finestra da 950 px. Le due barre di schede sovrapposte diventano una sola, e i colori per tipo di dato sono gli stessi in tutte le griglie (nella scheda Query & Aggregate non comparivano affatto).",
      "La selezione di celle in stile foglio di calcolo funziona in ogni griglia, compresi i riquadri della Split-View, ognuno con la propria selezione indipendente. Lo scorrimento della Split-View non scatta più, e una risposta arrivata in ritardo non sovrascrive più righe, conteggio o pagina di una tabella che nel frattempo è cambiata.",
      "Editor geometrico su mappa rifatto: si apre sul tipo che la colonna dichiara (anche MULTIPOLYGON e le altre forme multipart, prima disegnabili solo scrivendo il GeoJSON a mano), i vertici si prendono senza mira fino a 22 px, e ci sono annulla, rifai, inserimento di un vertice in mezzo a un lato ed eliminazione di una parte. Anche una cella geometrica vuota apre la mappa, e le celle geometriche si aprono ora da qualunque griglia.",
      "Grafo 3D: barra dei comandi ridisegnata, con i comandi di inquadratura sul canvas. «Vista 2D» appiattisce davvero la simulazione, «Rotazione automatica» ora funziona (prima scriveva una proprietà che nessuno leggeva), lo sfondo segue il tema chiaro, «Solo popolate» filtra per numero di righe e non più per numero di colonne — su MySQL e PostgreSQL non nascondeva nulla — e i nomi delle tabelle non spariscono più su schemi piccoli.",
      "Diagramma UML interattivo: si compone trascinando le tabelle dal catalogo, si spostano e si collegano i nodi, si annulla gesto per gesto, e il diagramma si salva, si riapre e si esporta in JSON, SVG e PNG. Ogni collegamento dichiara la propria origine — vincolo del database, ipotesi dedotta dai nomi, relazione logica disegnata a mano — e una chiave esterna composta è una freccia sola con tutte le sue colonne. Dal diagramma si consultano i dati reali e le righe collegate. Nessuna interazione del diagramma scrive nel database.",
      "Chiavi esterne: i vincoli composti sono selezionati e mostrati per intero, e il pannello delle chiavi esterne si apre da qualunque griglia.",
      "Interfaccia: le icone sono una famiglia sola invece di un centinaio di emoji che cambiavano forma da un sistema all'altro, non seguivano il tema e venivano lette ad alta voce dai lettori di schermo. Corretti i contrasti sotto la soglia di leggibilità, compresa l'intestazione della griglia, che non è più tutta maiuscola: portava il nome vero della colonna e su PostgreSQL lo falsificava. Nessuna modale sta più sopra una sfocatura a schermo intero, che su una macchina senza accelerazione grafica costava circa 200 ms a ogni apertura.",
      "Le maniglie di ridimensionamento rispondono al dito e alla penna: su un dispositivo tattile la barra delle connessioni, l'albero dei database e lo Schema Browser si vedevano, mostravano il cursore giusto e non facevano nulla.",
      "Import di un intero database e ripristino di un backup passano ora dallo stesso motore, che scrive prima in un'area di appoggio e promuove solo dopo aver verificato: un errore a metà non lascia più una destinazione parziale dichiarata riuscita. I backup dichiarano l'identità stabile delle righe, gli indici MongoDB viaggiano interi (un TTL importato scadeva ancora), e una collection vuota non sparisce più nel ripristino.",
      "Export dell'intero database molto più veloce (metadati letti una volta per tabella, totale calcolato solo al primo blocco, tabelle elaborate in parallelo) e con export CSV. Il tetto di tempo sulla query libera vale ora anche sulle scritture: prima un UPDATE sbagliato teneva una connessione senza alcun limite.",
      "Gateway MCP: nuovo execute_ddl con conferma esplicita, batch multi-operazione in execute_write, upsert e inserimenti multipli su MongoDB, e accettazione di artefatti di grandi dimensioni.",
    ],
  },
  {
    versione: '0.1.4-beta.1',
    punti: [
      'La selezione delle celle scorre da sola: trascinando fino al bordo della griglia — o anche oltre, fuori dalla tabella — il contenuto scorre e la selezione lo segue, senza doversi fermare a metà per rotellare. La velocità cresce con quanto ci si spinge verso il bordo.',
      'Lo stesso gesto funziona col dito: la fascia sensibile al bordo è più larga perché il polpastrello lo copre, il trascinamento parte solo dopo 10 px di movimento (sotto resta una pressione, e la pressione lunga continua ad aprire il menu contestuale) e la selezione non si interrompe più quando lo scorrimento ricostruisce le righe.',
      'Pannello delle chiavi esterne: non copre più la cella in modifica e resta dentro i bordi della finestra anche sulle tabelle larghe o con la griglia scorsa in fondo.',
      'Miglioramento della selezione con scorrimento',
      'Bug Fixes sul duplica riga e miglioramento della usabilità',
      'Query e Aggregate migliorato su encoding database'
    ],
  },
  {
    versione: '0.1.3-beta.1',
    punti: [
      'Split-View: più tabelle o collezioni affiancate nello stesso spazio di lavoro. Si trascina una scheda sul bordo per aprire una nuova area, i separatori si spostano senza scatti e ogni area si può rinominare.',
      'Schede in anteprima come in VS Code: un clic apre la tabella in via provvisoria, il doppio clic la fissa. Sfogliare il database non riempie più la barra delle schede.',
      'Chiavi esterne visibili in griglia: un anello dove il vincolo è dichiarato, ≈ dove è solo un\'ipotesi. Al doppio clic sulla cella un pannello scorre da destra con la riga riferita e l\'elenco cercabile da cui scegliere un altro valore, senza uscire dalla modifica.',
      'IntelliSense che conosce lo schema: dopo FROM le tabelle o le collezioni, dopo un alias le sole colonne di quella tabella, dopo db. le collezioni e i metodi, dopo $ gli operatori. Le proposte seguono il dialetto del motore in uso e i nomi vengono inseriti già quotati dove serve (niente più FROM diego.Prova che su PostgreSQL cerca diego.prova). Ctrl+Spazio apre l\'elenco a richiesta.',
      'JSON/BSON: Ctrl+Shift+F formatta e Ctrl+Shift+M minifica nell\'editor delle query e nelle modali di inserimento e modifica, con gli errori segnalati mentre si scrive su riga e colonna cliccabili. Il formattatore rispetta i numeri alla lettera: un intero oltre i 53 bit non viene arrotondato.',
      'Script SQL e Mongo eseguiti istruzione per istruzione, con pausa, ripresa, stop all\'errore e avanzamento in tempo reale: un caricamento lungo non è più una scatola chiusa.',
      'Cronologia dedicata della tab Query & Aggregate: le query eseguite restano a portata di mano e si rilanciano con un clic.',
      'Scheda Mappa nei risultati della query, che compare da sola quando le righe contengono geometrie — anche dentro sottodocumenti o array.',
      'Grafico della selezione: la voce «Grafico della selezione» nel menu contestuale della griglia disegna al volo le celle selezionate, scegliendo da sé l\'asse e le serie.',
      'Interfaccia che non si blocca più sui grandi risultati: statistiche della selezione e preparazione dei grafici passano su un altro thread oltre le 50.000 celle.',
    ],
  },
  {
    versione: '0.1.2-beta.1',
    punti: [
      'Aggiunto il monitoraggio delle connessioni attive e delle query in esecuzione, con la possibilità di annullare query lunghe o bloccanti',
      'Il pannello Sessioni dice anche chi blocca chi: il verdetto in cima indica la sessione da fermare, non quella che sta subendo il blocco.',
      'Temi chiaro, scuro e personalizzati: menu Impostazioni → Tema. Il tema personalizzato parte da 7 colori guida e avvisa quando il contrasto non è leggibile.',
      '“Automatico” segue le impostazioni del sistema anche mentre l\'app è aperta, per chi passa a scuro al tramonto.',
      'Scorrimento della griglia molto più fluido sui valori grandi: le celle con oggetti o JSON voluminosi non bloccano più il DOM.',
    ],
  },
];

/* --------------------------------- Versioni ------------------------------- */

/**
 * Confronto di versioni in stile semver: >0 se `a` è più recente di `b`.
 * Gemello ESM di `confrontaVersioni` in `electron-aggiornamenti.js` (che gira
 * nel processo principale di Electron, CommonJS, e non è importabile da qui).
 * Le due implementazioni non devono divergere: lo verifica
 * `test/unit-onboarding.js`, come già si fa per i due splitter SQL.
 */
export function confrontaVersioni(a, b) {
  const spezza = (v) => {
    const [core, pre = ''] = String(v || '0').trim().replace(/^v/i, '').split('-');
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const x = spezza(a);
  const y = spezza(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/* ------------------------------ Lettura/scrittura -------------------------- */

function storageDi(storage) {
  if (storage) return storage;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

const STATO_VUOTO = { visto: false, versioneVista: null, traguardi: {}, checklistChiusa: false };

/**
 * Stato persistito. Un contenuto illeggibile o di forma sbagliata (altra
 * versione dell'app, manomissione, quota piena) NON deve rompere l'avvio:
 * si riparte dallo stato vuoto, al massimo si rivede la guida una volta.
 */
export function leggiStato(storage) {
  const st = storageDi(storage);
  if (!st) return { ...STATO_VUOTO };
  try {
    const raw = st.getItem(CHIAVE);
    if (!raw) return { ...STATO_VUOTO };
    const dati = JSON.parse(raw);
    if (!dati || typeof dati !== 'object') return { ...STATO_VUOTO };
    return {
      visto: dati.visto === true,
      versioneVista: typeof dati.versioneVista === 'string' ? dati.versioneVista : null,
      traguardi: (dati.traguardi && typeof dati.traguardi === 'object') ? dati.traguardi : {},
      checklistChiusa: dati.checklistChiusa === true,
    };
  } catch {
    return { ...STATO_VUOTO };
  }
}

export function scriviStato(stato, storage) {
  const st = storageDi(storage);
  if (!st) return stato;
  try { st.setItem(CHIAVE, JSON.stringify(stato)); } catch { /* quota piena: pazienza */ }
  return stato;
}

/** Aggiorna una parte dello stato e lo riscrive. */
export function aggiornaStato(patch, storage) {
  return scriviStato({ ...leggiStato(storage), ...patch }, storage);
}

/**
 * Segna un traguardo raggiunto.
 * @returns {boolean} true SOLO la prima volta — chi chiama lo usa per festeggiare
 *   una volta sola invece che a ogni query eseguita.
 */
export function segnaTraguardo(id, storage) {
  if (!TRAGUARDI.some((t) => t.id === id)) return false;
  const stato = leggiStato(storage);
  if (stato.traguardi[id]) return false;
  stato.traguardi = { ...stato.traguardi, [id]: Date.now() };
  scriviStato(stato, storage);
  // La checklist si ridisegna ascoltando questo evento: i moduli che segnano un
  // traguardo non devono conoscerla né importarla. La notifica è best-effort —
  // il traguardo resta segnato comunque: questa funzione viene chiamata dentro
  // il percorso di operazioni reali (connessione riuscita, backup completato) e
  // non deve poter far fallire nessuna di esse.
  try {
    if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function'
      && typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('codedb:traguardo', { detail: { id } }));
    }
  } catch { /* ambiente senza DOM completo: nulla da aggiornare */ }
  return true;
}

export function completati(stato) {
  return TRAGUARDI.filter((t) => stato && stato.traguardi && stato.traguardi[t.id]).length;
}

export function tuttoFatto(stato) {
  return completati(stato) >= TRAGUARDI.length;
}

/* -------------------------------- Decisioni ------------------------------- */

/** Novità più recenti della versione già vista (le più nuove per prime). */
export function novitaDaMostrare(versioneCorrente, versioneVista, elenco) {
  const voci = elenco || NOVITA;
  if (!versioneVista) return []; // primo avvio in assoluto: si mostra il benvenuto, non le novità
  return voci
    .filter((v) => confrontaVersioni(v.versione, versioneVista) > 0)
    .filter((v) => !versioneCorrente || confrontaVersioni(v.versione, versioneCorrente) <= 0)
    .sort((a, b) => confrontaVersioni(b.versione, a.versione));
}

/**
 * Cosa mostrare all'avvio. Unica funzione che decide: l'interfaccia si limita
 * a eseguire.
 *
 * - `benvenuto` — non ha mai visto la guida;
 * - `novita`    — l'ha vista, ma da allora l'app è stata aggiornata E ci sono
 *                 voci nuove da raccontare (senza voci non si apre nulla: una
 *                 modale vuota dopo ogni aggiornamento è solo un fastidio);
 * - `null`      — niente.
 *
 * @returns {{azione: 'benvenuto'|'novita'|null, novita: Array}}
 */
export function decidiAvvio({ stato, versione, elenco } = {}) {
  const s = stato || { ...STATO_VUOTO };
  if (!s.visto) return { azione: 'benvenuto', novita: [] };
  if (!versione || !s.versioneVista) return { azione: null, novita: [] };
  if (confrontaVersioni(versione, s.versioneVista) <= 0) return { azione: null, novita: [] };
  const nuove = novitaDaMostrare(versione, s.versioneVista, elenco);
  return nuove.length ? { azione: 'novita', novita: nuove } : { azione: null, novita: [] };
}

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
    aiuto: 'Vista ⚡ Query & Aggregate: SQL, pipeline MQL o sintassi mongosh. Su MongoDB anche SELECT tradotte.',
  },
  {
    id: 'grafico',
    etichetta: 'Disegna un grafico dai risultati',
    aiuto: 'Nei risultati della query, scheda Grafici: scegli categoria e misura, oppure parti da 💡 Suggeriti.',
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
    versione: '0.1.4-beta.1',
    punti: [
      'La selezione delle celle scorre da sola: trascinando fino al bordo della griglia — o anche oltre, fuori dalla tabella — il contenuto scorre e la selezione lo segue, senza doversi fermare a metà per rotellare. La velocità cresce con quanto ci si spinge verso il bordo.',
      'Lo stesso gesto funziona col dito: la fascia sensibile al bordo è più larga perché il polpastrello lo copre, il trascinamento parte solo dopo 10 px di movimento (sotto resta una pressione, e la pressione lunga continua ad aprire il menu contestuale) e la selezione non si interrompe più quando lo scorrimento ricostruisce le righe.',
      'Pannello delle chiavi esterne: non copre più la cella in modifica e resta dentro i bordi della finestra anche sulle tabelle larghe o con la griglia scorsa in fondo.',
    ],
  },
  {
    versione: '0.1.3-beta.1',
    punti: [
      'Split-View: più tabelle o collezioni affiancate nello stesso spazio di lavoro. Si trascina una scheda sul bordo per aprire una nuova area, i separatori si spostano senza scatti e ogni area si può rinominare.',
      'Schede in anteprima come in VS Code: un clic apre la tabella in via provvisoria, il doppio clic la fissa. Sfogliare il database non riempie più la barra delle schede.',
      'Chiavi esterne visibili in griglia: 🔗 dove il vincolo è dichiarato, ≈ dove è solo un\'ipotesi. Al doppio clic sulla cella un pannello scorre da destra con la riga riferita e l\'elenco cercabile da cui scegliere un altro valore, senza uscire dalla modifica.',
      'IntelliSense che conosce lo schema: dopo FROM le tabelle o le collezioni, dopo un alias le sole colonne di quella tabella, dopo db. le collezioni e i metodi, dopo $ gli operatori. Le proposte seguono il dialetto del motore in uso e i nomi vengono inseriti già quotati dove serve (niente più FROM diego.Prova che su PostgreSQL cerca diego.prova). Ctrl+Spazio apre l\'elenco a richiesta.',
      'JSON/BSON: Ctrl+Shift+F formatta e Ctrl+Shift+M minifica nell\'editor ⚡ e nelle modali di inserimento e modifica, con gli errori segnalati mentre si scrive su riga e colonna cliccabili. Il formattatore rispetta i numeri alla lettera: un intero oltre i 53 bit non viene arrotondato.',
      'Script SQL e Mongo eseguiti istruzione per istruzione, con pausa, ripresa, stop all\'errore e avanzamento in tempo reale: un caricamento lungo non è più una scatola chiusa.',
      'Cronologia dedicata della tab ⚡: le query eseguite restano a portata di mano e si rilanciano con un clic.',
      'Scheda 🗺 Mappa nei risultati della query, che compare da sola quando le righe contengono geometrie — anche dentro sottodocumenti o array.',
      'Grafico della selezione: 📈 nel menu contestuale della griglia disegna al volo le celle selezionate, scegliendo da sé l\'asse e le serie.',
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

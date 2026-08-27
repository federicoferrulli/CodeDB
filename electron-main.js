'use strict';

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const net = require('net');
const { creaGestoreAggiornamenti } = require('./electron-aggiornamenti');
const { nuovoSegretoIstanza, probeServer } = require('./electron-server-auth');

const APP_NAME = 'CodeDB';
const HOST = '127.0.0.1';
// La porta può cambiare prima dell'avvio: se quella predefinita è occupata da
// un'ALTRA applicazione se ne cerca una libera (vedi scegliPorta). Con `PORT`
// impostata dall'utente la scelta è sua e non viene toccata.
const PORTA_RICHIESTA = Number(process.env.PORT) || 0;
let PORT = PORTA_RICHIESTA || 3030;
const ICON_PATH = path.join(__dirname, 'public', 'codedb.ico');

let mainWindow = null;
// Un orchestratore può fornire lo stesso segreto sia a un server CodeDB già
// avviato sia a Electron: è il solo caso in cui il riuso fra processi è valido.
// Senza valore ricevuto, ogni avvio genera un'identità nuova e non riusa server
// esterni soltanto perché espongono il marker pubblico.
const INSTANCE_SECRET = process.env.CODEDB_ELECTRON_INSTANCE_SECRET || nuovoSegretoIstanza();
delete process.env.CODEDB_ELECTRON_INSTANCE_SECRET;

// Gestore degli aggiornamenti (electron-updater): la finestra gli viene passata
// come funzione perché a questo punto non esiste ancora, e cambia a ogni
// riapertura su macOS (evento `activate`).
const aggiornamenti = creaGestoreAggiornamenti({ getWindow: () => mainWindow });

/* ---------------------------------------------------------------------------
 * Ponte verso il server incorporato (letto da `ponteDesktop()` in server.js).
 *
 * La voce "Controlla aggiornamenti…" esiste nel menu nativo, ma la finestra ha
 * `autoHideMenuBar: true`: la barra compare solo premendo Alt, quindi per chi
 * usa l'applicazione quella voce di fatto non esiste. Deve stare anche nel menu
 * ⋮ dell'interfaccia, insieme alle altre.
 *
 * Non serve alcun IPC per farlo — ed è bene che non serva, perché la finestra è
 * `sandbox: true` senza preload e carica la stessa UI servita via HTTP: un
 * canale IPC sarebbe esposto a qualunque pagina finisse lì dentro. Il server
 * Socket.IO gira invece IN QUESTO processo, quindi gli basta chiamare la
 * funzione. Se il server è esterno (avviato a parte con CodeDB.cmd) questo
 * oggetto non esiste nel suo processo e la voce non viene offerta: giusto così,
 * quella finestra non ha un'installazione da aggiornare.
 * ------------------------------------------------------------------------- */
globalThis.__codedbDesktop = {
  controllaAggiornamenti: () => { aggiornamenti.controlla(true); },
  instanceSecret: INSTANCE_SECRET,
};

// Il nome nel package.json ("mongo-web-gui", storico) determinerebbe altrimenti
// il nome della cartella dati utente (%APPDATA%/mongo-web-gui): forziamo "CodeDB".
app.setName(APP_NAME);

/* ---------------------------------------------------------------------------
 * AppUserModelID (solo Windows)
 *
 * È l'identificativo con cui Windows RAGGRUPPA le finestre nella barra delle
 * applicazioni e le associa a un collegamento appuntato. Deve valere due cose:
 *
 *  1. va impostato PRIMA che esista qualunque finestra — inclusi i `dialog`
 *    di errore, che sono finestre a tutti gli effetti. Stava dentro `main()`,
 *    quindi dopo il ping al server e dopo fino a ~10 s di attesa: qualsiasi
 *    finestra creata prima (o un errore mostrato in quel frattempo) sarebbe
 *    finita in un gruppo separato, con l'icona duplicata nella barra.
 *  2. deve coincidere con l'`appId` dichiarato in package.json → `build.appId`,
 *    perché è quello che l'installer NSIS scrive nel collegamento del menu
 *    Start: se i due valori divergono, Windows tratta il collegamento appuntato
 *    e la finestra aperta come due applicazioni diverse.
 *
 * Nota: i collegamenti creati da `npm run shortcut` puntano a `cmd.exe` e non
 * portano alcun AppUserModelID, quindi non si raggrupperanno mai con la
 * finestra dell'app. È il motivo per cui la distribuzione va fatta con
 * l'installer, non con quello script.
 * ------------------------------------------------------------------------- */
const APP_USER_MODEL_ID = 'com.codedb.app';
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// L'exe pacchettizzato gira da una cartella di sola lettura (es. Program Files):
// connections.ini/backups/log non possono più stare accanto a server.js, quindi
// li spostiamo nella cartella dati utente scrivibile (stessi hook usati dai test
// e2e per isolare connections.ini, vedi CLAUDE.md). In sviluppo (electron:start
// da sorgente) restano invece accanto al repo, come con `npm start`.
if (app.isPackaged) {
  const dataDir = app.getPath('userData');
  process.env.CODEDB_CONNECTIONS_FILE = process.env.CODEDB_CONNECTIONS_FILE
    || path.join(dataDir, 'connections.ini');
  process.env.CODEDB_BACKUPS_DIR = process.env.CODEDB_BACKUPS_DIR
    || path.join(dataDir, 'backups');
  process.env.CODEDB_MCP_AUDIT_FILE = process.env.CODEDB_MCP_AUDIT_FILE
    || path.join(dataDir, 'mcp-audit.log');
  process.env.CODEDB_UI_AUDIT_FILE = process.env.CODEDB_UI_AUDIT_FILE
    || path.join(dataDir, 'ui-audit.log');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Un'altra istanza è già partita: lascia che sia quella a mostrarsi ed esci.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(main).catch((err) => {
    // Anche gli errori fuori dai rami di avvio previsti (per esempio nella
    // creazione della BrowserWindow) devono terminare con un messaggio, non
    // come rejection non gestita lasciando il processo Electron sospeso.
    console.error('[Electron] Avvio non riuscito:', err);
    dialog.showErrorBox(APP_NAME, `Avvio di CodeDB non riuscito: ${err.message || err}`);
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

/**
 * C'è un'istanza di CodeDB in ascolto sulla porta?
 *
 * Si interroga `/handshake-check`, che risponde `{ app: 'codedb' }` (CDB-38).
 * Prima bastava che QUALUNQUE cosa rispondesse sulla porta: se 3030 era occupata
 * da un altro progetto in sviluppo, l'app desktop non avviava il proprio server
 * e apriva una finestra su quell'altra applicazione — con la barra del titolo
 * di CodeDB. Ora, in quel caso, l'avvio prosegue e l'errore di porta occupata
 * arriva dal server, che sa spiegarlo.
 */
function pingServer(timeout) {
  return probeServer({ host: HOST, port: PORT, secret: INSTANCE_SECRET, timeout });
}

function waitForServer(retries, delay) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tick = async () => {
      if (await pingServer(delay)) return resolve();
      attempts++;
      if (attempts >= retries) return reject(new Error(`CodeDB non risponde su http://${HOST}:${PORT} dopo l'avvio.`));
      setTimeout(tick, delay);
    };
    tick();
  });
}

/** La porta è libera per un nuovo ascolto? */
function portaLibera(porta) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(porta, HOST);
  });
}

/**
 * Sceglie la porta del server incorporato.
 *
 * Il caso da evitare: la 3030 occupata da un'ALTRA applicazione (un progetto in
 * sviluppo, un altro server). `server.js` reagisce a `EADDRINUSE` con
 * `process.exit(1)` — fatale, perché qui gira dentro il processo di Electron —
 * e all'utente resterebbe una finestra che non mostra CodeDB, senza spiegazione.
 *
 * Se la porta è stata scelta esplicitamente con `PORT` non si cambia nulla: è
 * una decisione dell'utente, e spostarla di nascosto romperebbe i client MCP e
 * i segnalibri configurati su quel numero. Altrimenti si cercano le successive.
 *
 * @returns {Promise<number|null>} la porta da usare, o null se non se ne trova
 */
async function scegliPorta() {
  if (await portaLibera(PORT)) return PORT;
  if (PORTA_RICHIESTA) return null; // scelta dall'utente: non la si scavalca
  for (let p = PORT + 1; p <= PORT + 20; p++) {
    if (await portaLibera(p)) return p;
  }
  return null;
}

async function main() {
  // L'AppUserModelID è già impostato a livello di modulo (vedi sopra): qui
  // sarebbe troppo tardi, perché prima si attende il server e si possono aprire
  // finestre di dialogo.
  Menu.setApplicationMenu(buildMenu());

  // Se un server già in ascolto dimostra di possedere LA STESSA identità
  // ricevuta dall'orchestratore, lo si può riusare. Un CodeDB avviato a parte
  // senza quel segreto è intenzionalmente estraneo quanto qualunque altra app.
  const alreadyRunning = await pingServer(500);
  if (!alreadyRunning) {
    // La porta risponde ma non è CodeDB (pingServer controlla `app: codedb`),
    // oppure è occupata da un processo che non risponde affatto.
    const porta = await scegliPorta();
    if (porta === null) {
      dialog.showErrorBox(APP_NAME, `La porta ${PORT} è occupata da un'altra applicazione.\n\n`
        + (PORTA_RICHIESTA
          ? 'È la porta impostata nella variabile PORT: liberala oppure indicane un\'altra.'
          : 'Sono state provate anche le venti successive senza trovarne una libera.'));
      app.quit();
      return;
    }
    if (porta !== PORT) {
      console.warn(`[CodeDB] Porta ${PORT} occupata da un'altra applicazione: uso la ${porta}.`);
      PORT = porta;
    }
    // Letta da server.js al momento del require: va impostata PRIMA.
    process.env.PORT = String(PORT);

    try {
      // `server.js` mette il proprio avvio dietro `if (require.main === module)`
      // ed esporta `startServer`: caricarlo e basta definisce tutto ma NON apre
      // la porta. Da qui `require.main` è electron-main.js, quindi senza questa
      // chiamata il server incorporato non parte mai — e l'app finiva per
      // funzionare solo quando trovava già in ascolto un server avviato a parte
      // (con il vault e il processo di QUELLA istanza), oppure moriva dopo
      // dieci secondi con "CodeDB non risponde".
      const srv = require('./server.js');
      if (typeof srv.startServer !== 'function') {
        throw new Error('server.js non espone startServer(): versione incompatibile.');
      }
      await srv.startServer();
    } catch (err) {
      dialog.showErrorBox(APP_NAME, `Impossibile avviare il server CodeDB: ${err.message}`);
      app.quit();
      return;
    }

    try {
      await waitForServer(40, 250);
    } catch (err) {
      dialog.showErrorBox(APP_NAME, err.message);
      app.quit();
      return;
    }
  }

  createWindow();

  // Controllo silenzioso: parla solo se c'è davvero una versione nuova
  // (CODEDB_NO_UPDATE_CHECK=1 per disattivarlo).
  aggiornamenti.avviaControlloDifferito();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: ICON_PATH,
    backgroundColor: '#1e1e1e',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.loadURL(`http://${HOST}:${PORT}`);

  // Evita il lampo bianco mostrando la finestra solo a caricamento avvenuto.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // I link che aprirebbero una nuova finestra (es. target=_blank) vanno nel
  // browser di sistema, non in una nuova BrowserWindow senza sandbox.
  //
  // Solo http/https (CDB-37): `shell.openExternal` consegna l'URL al sistema
  // operativo, che lo apre con l'applicazione registrata per quello schema —
  // `file:`, `smb:`, `ms-msdt:` e simili diventano quindi l'esecuzione di
  // qualcosa fuori da Electron, a partire da un link presente in una pagina.
  // La whitelist è sugli schemi, non sui domini: aprire un sito qualsiasi nel
  // browser è legittimo, avviare un programma no.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let schema = '';
    try { schema = new URL(url).protocol; } catch { schema = ''; }
    if (schema === 'http:' || schema === 'https:') {
      shell.openExternal(url).catch((err) => {
        console.warn('[Electron] Impossibile aprire il link esterno: ' + err.message);
      });
    } else {
      console.warn(`[Electron] Apertura esterna rifiutata (schema "${schema || 'sconosciuto'}"): ${url}`);
    }
    return { action: 'deny' };
  });

  // Stessa regola per la NAVIGAZIONE nella finestra: l'unica pagina che CodeDB
  // deve caricare è la propria. Un link che porti altrove va al browser di
  // sistema, altrimenti si finirebbe con una pagina esterna dentro la finestra
  // dell'applicazione, indistinguibile da essa.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const nostra = `http://${HOST}:${PORT}`;
    let destinazione = null;
    try { destinazione = new URL(url); } catch { /* URL non valida: rifiutata sotto */ }
    if (destinazione && destinazione.origin === new URL(nostra).origin) return;
    event.preventDefault();
    const schema = destinazione ? destinazione.protocol : '';
    if (schema === 'http:' || schema === 'https:') {
      shell.openExternal(url).catch((err) => {
        console.warn('[Electron] Impossibile aprire il link esterno: ' + err.message);
      });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        {
          label: 'Controlla aggiornamenti…',
          click: () => aggiornamenti.controlla(true)
        },
        { type: 'separator' },
        { role: 'reload', label: 'Ricarica' },
        { role: 'forceReload', label: 'Ricarica forzata' },
        { role: 'toggleDevTools', label: 'Strumenti sviluppo' },
        { type: 'separator' },
        { role: 'quit', label: 'Esci' }
      ]
    },
    {
      label: 'Vista',
      submenu: [
        { role: 'resetZoom', label: 'Zoom normale' },
        { role: 'zoomIn', label: 'Aumenta zoom' },
        { role: 'zoomOut', label: 'Riduci zoom' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Schermo intero' }
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
}

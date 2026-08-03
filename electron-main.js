'use strict';

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const { creaGestoreAggiornamenti } = require('./electron-aggiornamenti');

const APP_NAME = 'CodeDB';
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3030;
const ICON_PATH = path.join(__dirname, 'public', 'codedb.ico');

let mainWindow = null;

// Gestore degli aggiornamenti (electron-updater): la finestra gli viene passata
// come funzione perché a questo punto non esiste ancora, e cambia a ogni
// riapertura su macOS (evento `activate`).
const aggiornamenti = creaGestoreAggiornamenti({ getWindow: () => mainWindow });

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

  app.whenReady().then(main);

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
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/handshake-check', timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).app === 'codedb');
        } catch {
          resolve(false); // risponde qualcos'altro: non è CodeDB
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
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

async function main() {
  // L'AppUserModelID è già impostato a livello di modulo (vedi sopra): qui
  // sarebbe troppo tardi, perché prima si attende il server e si possono aprire
  // finestre di dialogo.
  Menu.setApplicationMenu(buildMenu());

  // Se il server è già in ascolto (avviato a parte con CodeDB.cmd/codedb.sh, o
  // da un'altra istanza), riusalo: evita il crash di server.js su EADDRINUSE
  // (process.exit(1)), che qui ucciderebbe l'intero processo Electron.
  const alreadyRunning = await pingServer(500);
  if (!alreadyRunning) {
    try {
      require('./server.js');
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
      shell.openExternal(url);
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
    if (url.startsWith(nostra)) return;
    event.preventDefault();
    let schema = '';
    try { schema = new URL(url).protocol; } catch { schema = ''; }
    if (schema === 'http:' || schema === 'https:') shell.openExternal(url);
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

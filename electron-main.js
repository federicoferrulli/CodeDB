'use strict';

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');

const APP_NAME = 'CodeDB';
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3030;
const ICON_PATH = path.join(__dirname, 'public', 'codedb.ico');

let mainWindow = null;

// Il nome nel package.json ("mongo-web-gui", storico) determinerebbe altrimenti
// il nome della cartella dati utente (%APPDATA%/mongo-web-gui): forziamo "CodeDB".
app.setName(APP_NAME);

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

function pingServer(timeout) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/', timeout }, (res) => {
      res.resume();
      resolve(true);
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
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.codedb.app');
  }
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
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

'use strict';

/* ---------------------------------------------------------------------------
 * Aggiornamenti dell'app desktop (Electron) — "Controlla aggiornamenti…"
 *
 * Basato su `electron-updater`: il canale predefinito sono le RELEASE GITHUB
 * del repository (provider `github`, configurato in package.json → build.publish),
 * con la possibilità di puntare a un SERVER STATICO HTTP tramite la variabile
 * d'ambiente `CODEDB_UPDATE_URL` (provider `generic`) — utile per distribuzioni
 * interne che non passano da GitHub.
 *
 * Tre scelte non ovvie:
 *
 *  1. NIENTE IPC, NIENTE PRELOAD. La finestra carica `http://127.0.0.1:<PORT>`,
 *     cioè la stessa UI web servita dal server: esporre lì un canale IPC
 *     significherebbe darlo anche a qualunque pagina che finisse in quella
 *     finestra, e obbligherebbe a spegnere `sandbox: true`. L'intera interazione
 *     usa quindi i `dialog` nativi del processo principale.
 *  2. `autoDownload = false`. Un aggiornamento è un download di decine di MB e
 *     un riavvio: si scarica quando l'utente dice di sì, non alle sue spalle.
 *  3. Il feed personalizzato deve essere HTTPS (loopback escluso, per le prove).
 *     Su HTTP semplice chi sta in mezzo alla rete non "vede" un aggiornamento:
 *     lo SOSTITUISCE, ed è un eseguibile che l'utente lancerà da solo.
 *
 * Nota di distribuzione: l'aggiornamento automatico funziona solo con i pacchetti
 * prodotti da `electron-builder` (npm run build:win/mac/linux), che scrivono
 * `app-update.yml` dentro le risorse. Le cartelle prodotte da `npm run dist:*`
 * (@electron/packager) non contengono quel file: lì il controllo fallisce e
 * viene offerta la pagina delle release. Su macOS l'aggiornamento richiede
 * inoltre un'app FIRMATA: senza firma `electron-updater` rifiuta di installare,
 * e anche in quel caso si ripiega sulla pagina delle release.
 * ------------------------------------------------------------------------- */

const REPO = { owner: 'federicoferrulli', repo: 'CodeDB' };
const URL_RELEASES = `https://github.com/${REPO.owner}/${REPO.repo}/releases`;

// Il controllo silenzioso all'avvio non deve competere con il caricamento della
// finestra e con la connessione ai database: parte dopo, a interfaccia pronta.
const RITARDO_AVVIO_MS = 8000;

/**
 * Feed di aggiornamento personalizzato (server statico HTTP) da variabili
 * d'ambiente. Funzione PURA: nessun accesso a Electron, così è verificabile in
 * Node (`test/unit.js`).
 *
 * @returns {null | {provider:'generic', url:string, channel?:string} | {errore:string}}
 */
function feedPersonalizzato(env) {
  const e = env || process.env;
  const url = String(e.CODEDB_UPDATE_URL || '').trim();
  if (!url) return null;

  let u;
  try { u = new URL(url); } catch {
    return { errore: `CODEDB_UPDATE_URL non è un URL valido: ${url}` };
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    return {
      errore: 'CODEDB_UPDATE_URL deve usare HTTPS: su HTTP semplice chiunque sia '
        + 'in mezzo alla rete può sostituire l\'installer scaricato. '
        + `(valore attuale: ${url})`
    };
  }

  const channel = String(e.CODEDB_UPDATE_CHANNEL || '').trim();
  const feed = { provider: 'generic', url };
  if (channel) feed.channel = channel;
  return feed;
}

/**
 * Confronto di versioni in stile semver, usato SOLO come rete di sicurezza
 * quando `electron-updater` non riporta `isUpdateAvailable`. Ritorna >0 se `a`
 * è più recente di `b`. Le pre-release (`1.2.0-beta.1`) valgono meno della
 * versione finale corrispondente. Funzione PURA.
 */
function confrontaVersioni(a, b) {
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
  if (!x.pre) return 1;   // 1.2.0 > 1.2.0-beta
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** Note di rilascio ridotte a testo semplice e accorciate per un dialog nativo. */
function noteRilascio(info, maxLen) {
  const limite = maxLen || 700;
  let raw = info && info.releaseNotes;
  if (Array.isArray(raw)) raw = raw.map((n) => (n && n.note) || '').join('\n\n');
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const testo = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return testo.length > limite ? `${testo.slice(0, limite)}…` : testo;
}

/**
 * Crea il gestore degli aggiornamenti.
 *
 * @param {object} opts
 * @param {() => Electron.BrowserWindow|null} opts.getWindow finestra principale (per i dialog e la barra di avanzamento)
 * @returns {{controlla: (manuale?: boolean) => Promise<void>, avviaControlloDifferito: () => void}}
 */
function creaGestoreAggiornamenti({ getWindow }) {
  const { app, dialog, shell } = require('electron');
  let inCorso = false;

  const win = () => {
    const w = getWindow && getWindow();
    return w && !w.isDestroyed() ? w : null;
  };
  const msg = (opts) => (win() ? dialog.showMessageBox(win(), opts) : dialog.showMessageBox(opts));

  function caricaUpdater() {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;          // decide l'utente (vedi intestazione)
    autoUpdater.autoInstallOnAppQuit = true;   // se scaricato, si installa alla chiusura
    autoUpdater.logger = console;

    const feed = feedPersonalizzato();
    if (feed && feed.errore) throw new Error(feed.errore);
    if (feed) autoUpdater.setFeedURL(feed);

    return autoUpdater;
  }

  /** Errore del controllo: spiegato, con la pagina delle release come via d'uscita. */
  async function fallito(err, manuale) {
    const testo = String((err && err.message) || err || 'errore sconosciuto');
    console.warn('[Aggiornamenti]', testo);
    if (!manuale) return; // il controllo automatico non disturba l'utente

    let spiegazione;
    if (/app-update\.yml|ENOENT/i.test(testo)) {
      spiegazione = 'Questa copia di CodeDB non contiene le informazioni di aggiornamento '
        + '(succede con la cartella prodotta da "npm run dist:*" invece dell\'installer). '
        + 'Puoi scaricare l\'ultima versione dalla pagina delle release.';
    } else if (/code signature|not signed|Could not get code signature/i.test(testo)) {
      spiegazione = 'L\'aggiornamento automatico su macOS richiede un\'applicazione firmata. '
        + 'Scarica l\'ultima versione dalla pagina delle release.';
    } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|getaddrinfo/i.test(testo)) {
      spiegazione = 'Non è stato possibile contattare il server degli aggiornamenti. '
        + 'Controlla la connessione a Internet (o le impostazioni del proxy) e riprova.';
    } else {
      spiegazione = 'Controllo degli aggiornamenti non riuscito.';
    }

    const r = await msg({
      type: 'warning',
      title: 'CodeDB — Aggiornamenti',
      message: spiegazione,
      detail: `Dettaglio tecnico: ${testo}`,
      buttons: ['Apri la pagina delle release', 'Chiudi'],
      defaultId: 0,
      cancelId: 1
    });
    if (r.response === 0) shell.openExternal(URL_RELEASES);
  }

  /** Scarica l'aggiornamento mostrando l'avanzamento nella barra delle applicazioni. */
  async function scarica(autoUpdater, versione) {
    const w = win();
    const onProgress = (p) => {
      if (w && !w.isDestroyed()) w.setProgressBar(Math.max(0, Math.min(1, (p.percent || 0) / 100)));
    };
    autoUpdater.on('download-progress', onProgress);
    try {
      await autoUpdater.downloadUpdate();
    } finally {
      autoUpdater.removeListener('download-progress', onProgress);
      if (w && !w.isDestroyed()) w.setProgressBar(-1);
    }

    const r = await msg({
      type: 'info',
      title: 'CodeDB — Aggiornamenti',
      message: `CodeDB ${versione} è pronta per essere installata.`,
      detail: 'L\'applicazione si chiuderà per completare l\'installazione. '
        + 'Le connessioni ai database aperte verranno chiuse: se hai uno script in esecuzione, '
        + 'attendine la fine e installa dopo.',
      buttons: ['Riavvia e installa', 'Installa alla chiusura'],
      defaultId: 0,
      cancelId: 1
    });
    if (r.response === 0) {
      setImmediate(() => autoUpdater.quitAndInstall());
    }
  }

  /**
   * Controllo vero e proprio.
   * @param {boolean} manuale true = voce di menu (parla sempre), false = controllo all'avvio (parla solo se c'è un aggiornamento)
   */
  async function controlla(manuale) {
    if (inCorso) {
      if (manuale) {
        await msg({
          type: 'info', title: 'CodeDB — Aggiornamenti',
          message: 'Un controllo degli aggiornamenti è già in corso.', buttons: ['Ok']
        });
      }
      return;
    }

    // In sviluppo (`npm run electron:start`) non esiste nulla da aggiornare:
    // dirlo è più utile che far fallire il controllo con un errore di file
    // mancante, che sembrerebbe un difetto dell'applicazione.
    if (!app.isPackaged) {
      if (manuale) {
        await msg({
          type: 'info',
          title: 'CodeDB — Aggiornamenti',
          message: 'Stai eseguendo CodeDB dai sorgenti.',
          detail: `Gli aggiornamenti automatici sono disponibili solo nell'applicazione installata.\n\nVersione corrente: ${app.getVersion()}`,
          buttons: ['Ok']
        });
      }
      return;
    }

    inCorso = true;
    try {
      const autoUpdater = caricaUpdater();
      const res = await autoUpdater.checkForUpdates();
      const info = res && res.updateInfo;
      const nuova = info && info.version;
      const disponibile = res
        ? (typeof res.isUpdateAvailable === 'boolean'
          ? res.isUpdateAvailable
          : Boolean(nuova) && confrontaVersioni(nuova, app.getVersion()) > 0)
        : false;

      if (!disponibile) {
        if (manuale) {
          await msg({
            type: 'info',
            title: 'CodeDB — Aggiornamenti',
            message: 'CodeDB è aggiornata.',
            detail: `Versione installata: ${app.getVersion()}`,
            buttons: ['Ok']
          });
        }
        return;
      }

      const note = noteRilascio(info);
      const r = await msg({
        type: 'info',
        title: 'CodeDB — Aggiornamenti',
        message: `È disponibile CodeDB ${nuova}.`,
        detail: `Versione installata: ${app.getVersion()}\n${note ? `\nNovità:\n${note}\n` : ''}`,
        buttons: ['Scarica ora', 'Vedi la release', 'Più tardi'],
        defaultId: 0,
        cancelId: 2
      });
      if (r.response === 1) { shell.openExternal(URL_RELEASES); return; }
      if (r.response !== 0) return;

      await scarica(autoUpdater, nuova);
    } catch (err) {
      await fallito(err, manuale);
    } finally {
      inCorso = false;
    }
  }

  /** Controllo silenzioso all'avvio, disattivabile con CODEDB_NO_UPDATE_CHECK=1. */
  function avviaControlloDifferito() {
    if (String(process.env.CODEDB_NO_UPDATE_CHECK || '') === '1') return;
    const t = setTimeout(() => { controlla(false); }, RITARDO_AVVIO_MS);
    if (t.unref) t.unref();
  }

  return { controlla, avviaControlloDifferito };
}

module.exports = {
  creaGestoreAggiornamenti,
  feedPersonalizzato,
  confrontaVersioni,
  noteRilascio,
  URL_RELEASES,
  REPO
};

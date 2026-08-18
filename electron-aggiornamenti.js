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
 *  4. Le PRE-RELEASE sono ammesse ma DICHIARATE: chi installa una beta continua
 *     a ricevere le beta, chi ha una versione stabile no — a meno che non lo
 *     chieda con `CODEDB_UPDATE_PRERELEASE=1` (vedi `permettePreRelease`).
 *
 * PRE-RELEASE, le due metà del problema. `electron-updater` decide da sé:
 * `allowPrerelease` vale `true` solo se la versione INSTALLATA contiene una
 * componente di pre-release. Ci si affida quindi a un valore implicito che
 * sparisce da solo alla prima 1.0.0, e senza alcun modo per chi vuole provare
 * le beta di riceverle: qui la scelta è esplicita e sovrascrivibile.
 * L'altra metà sta nella PUBBLICAZIONE (`tools/pubblica.js`): una beta caricata
 * su GitHub come release normale diventa la `/releases/latest` del repository,
 * cioè viene offerta anche a chi le pre-release non le ha mai volute — la
 * seconda metà è quella che protegge gli utenti stabili, non questa.
 *
 * Nota di distribuzione: l'aggiornamento automatico funziona solo con i pacchetti
 * prodotti da `electron-builder` (npm run build:win/mac/linux), che scrivono
 * `app-update.yml` dentro le risorse. Le cartelle prodotte da `npm run dist:*`
 * (@electron/packager) non contengono quel file: lì il controllo fallisce e
 * viene offerta la pagina delle release. Su macOS l'aggiornamento richiede
 * inoltre un'app FIRMATA: senza firma `electron-updater` rifiuta di installare,
 * e anche in quel caso si ripiega sulla pagina delle release.
 * ------------------------------------------------------------------------- */

// Il repository UFFICIALE, cioè quello a cui punta il remote di git: è da lì
// che arrivano le release, ed è quello che l'EULA cita come sorgente
// ispezionabile. Deve coincidere con `repository` e `build.publish` in
// package.json (lo verifica `npm test`): un feed che punta a un repository
// inesistente non dà errore in fase di build — dà un aggiornamento che non
// viene mai offerto.
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
 * `true` se la versione contiene una componente di pre-release (`1.2.0-beta.1`,
 * `0.1.1-b`), cioè la stessa condizione con cui `electron-updater` decide il
 * proprio `allowPrerelease` predefinito. Funzione PURA.
 */
function versioneDiPreRelease(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  const pre = s.split('+')[0].split('-').slice(1).join('-');
  return pre.length > 0;
}

/**
 * Decide se accettare gli aggiornamenti alle PRE-RELEASE.
 *
 * Regola: la variabile `CODEDB_UPDATE_PRERELEASE` comanda (`1`/`on`/`true`/`si`
 * per accettarle, `0`/`off`/`false`/`no` per rifiutarle); in sua assenza vale il
 * criterio implicito di `electron-updater`, cioè "chi ha installato una beta
 * continua a ricevere le beta". Renderlo esplicito serve a due cose: chi vuole
 * provare le beta partendo da una versione stabile può dirlo, e chi distribuisce
 * l'app a un'azienda può escluderle anche dalle macchine che oggi hanno una beta
 * installata — con il valore implicito nessuna delle due era possibile.
 *
 * Funzione PURA (nessun accesso a Electron), così è verificabile in Node.
 *
 * @param {object} env variabili d'ambiente
 * @param {string} versioneCorrente versione installata (`app.getVersion()`)
 */
function permettePreRelease(env, versioneCorrente) {
  const e = env || process.env;
  const v = String(e.CODEDB_UPDATE_PRERELEASE ?? '').trim().toLowerCase();
  if (v) {
    if (['1', 'on', 'true', 'si', 'sì', 'yes'].includes(v)) return true;
    if (['0', 'off', 'false', 'no'].includes(v)) return false;
    // Un valore non riconosciuto non deve valere "sì" per caso: si ricade sul
    // criterio predefinito, che è quello prudente.
  }
  return versioneDiPreRelease(versioneCorrente);
}

/**
 * Confronto di versioni in stile semver, usato SOLO come rete di sicurezza
 * quando `electron-updater` non riporta `isUpdateAvailable`. Ritorna >0 se `a`
 * è più recente di `b`. Le pre-release (`1.2.0-beta.1`) valgono meno della
 * versione finale corrispondente. Funzione PURA.
 *
 * Le componenti di pre-release si confrontano una per una come vuole semver, e
 * NON come stringhe intere: per confronto testuale `beta.10` verrebbe prima di
 * `beta.9`, cioè la decima beta non verrebbe mai offerta a chi ha la nona —
 * finché le pre-release non erano un canale d'aggiornamento la sfumatura non si
 * vedeva, ora sì.
 */
function confrontaVersioni(a, b) {
  const spezza = (v) => {
    const s = String(v || '0').trim().replace(/^v/i, '').split('+')[0];
    const i = s.indexOf('-');
    const core = i === -1 ? s : s.slice(0, i);
    const pre = i === -1 ? '' : s.slice(i + 1);
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

  const px = x.pre.split('.');
  const py = y.pre.split('.');
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    const ax = px[i];
    const ay = py[i];
    // Meno identificatori = versione minore (1.2.0-beta < 1.2.0-beta.1).
    if (ax === undefined) return -1;
    if (ay === undefined) return 1;
    const nx = /^\d+$/.test(ax) ? parseInt(ax, 10) : null;
    const ny = /^\d+$/.test(ay) ? parseInt(ay, 10) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx > ny ? 1 : -1;
    } else if (nx !== null) {
      return -1;              // numerico < alfanumerico (semver)
    } else if (ny !== null) {
      return 1;
    } else if (ax !== ay) {
      return ax > ay ? 1 : -1;
    }
  }
  return 0;
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

    // Pre-release: scelta ESPLICITA, non il valore implicito di electron-updater
    // (vedi `permettePreRelease` e la nota in testa al file).
    autoUpdater.allowPrerelease = permettePreRelease(process.env, app.getVersion());

    const feed = feedPersonalizzato();
    if (feed && feed.errore) throw new Error(feed.errore);
    if (feed) autoUpdater.setFeedURL(feed);

    // Canale esplicito (`beta`, `alpha`, `latest`…): con il provider GitHub non
    // arriva dal feed, che lì non si imposta, quindi va detto all'updater. Vale
    // anche per PASSARE a un altro canale: assegnare `channel` porta con sé
    // `allowDowngrade = true` (è electron-updater a farlo), altrimenti tornare
    // da una beta al canale stabile non offrirebbe mai nulla — la stabile ha un
    // numero più basso della beta che la precede.
    const canale = String(process.env.CODEDB_UPDATE_CHANNEL || '').trim();
    if (canale) autoUpdater.channel = canale;

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
    if (r.response === 0) {
      await shell.openExternal(URL_RELEASES).catch((err) => {
        console.warn('[Aggiornamenti] Impossibile aprire la pagina delle release: ' + err.message);
      });
    }
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
      // Il canale va detto all'utente: "CodeDB è aggiornata" significa cose
      // diverse a seconda che le pre-release siano incluse o no, e senza questa
      // riga chi ha una beta non ha modo di sapere quale delle due sta leggendo.
      const canale = autoUpdater.allowPrerelease
        ? 'Canale: versioni di prova (pre-release) incluse.'
        : 'Canale: solo versioni stabili.';
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
            detail: `Versione installata: ${app.getVersion()}\n${canale}`,
            buttons: ['Ok']
          });
        }
        return;
      }

      const note = noteRilascio(info);
      const pre = versioneDiPreRelease(nuova)
        ? '\nÈ una VERSIONE DI PROVA (pre-release): può contenere difetti non ancora corretti.'
        : '';
      const r = await msg({
        type: 'info',
        title: 'CodeDB — Aggiornamenti',
        message: `È disponibile CodeDB ${nuova}.`,
        detail: `Versione installata: ${app.getVersion()}${pre}\n${note ? `\nNovità:\n${note}\n` : ''}`,
        buttons: ['Scarica ora', 'Vedi la release', 'Più tardi'],
        defaultId: 0,
        cancelId: 2
      });
      if (r.response === 1) {
        await shell.openExternal(URL_RELEASES).catch((err) => {
          console.warn('[Aggiornamenti] Impossibile aprire la pagina delle release: ' + err.message);
        });
        return;
      }
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
  permettePreRelease,
  versioneDiPreRelease,
  confrontaVersioni,
  noteRilascio,
  URL_RELEASES,
  REPO
};

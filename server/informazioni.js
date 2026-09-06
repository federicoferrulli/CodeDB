'use strict';

// CodeDB — informazioni. Stato e dipendenze appartengono alla singola istanza.
const fs = require('fs');
const path = require('path');

function createModule({ config }) {
  // Versione dichiarata al client dall'evento `app:info` (guida introduttiva).
  // Letta una volta sola all'avvio: non cambia mentre il processo è vivo.
  const APP_VERSION = (() => {
    try { return require('../package.json').version || null; } catch { return null; }
  })();

  /* ---------------------------------------------------------------------------
   * Dati della schermata "Informazioni & Licenza" (evento `app:license`).
   *
   * Le librerie vendorizzate in `public/vendor/` non compaiono in package.json
   * (non passano da npm), quindi vanno dichiarate: sono le uniche due voci
   * scritte a mano, con la licenza letta dall'intestazione dei file distribuiti.
   * ------------------------------------------------------------------------- */
  const VENDORIZZATE = [
    { nome: 'echarts', versione: '6.1.0', licenza: 'Apache-2.0', nota: 'grafici (public/vendor/echarts)' },
    { nome: 'leaflet', versione: '1.9.4', licenza: 'BSD-2-Clause', nota: 'mappe delle geometrie (public/vendor/leaflet)' },
  ];

  /* ---------------------------------------------------------------------------
   * Ponte con il processo principale di Electron.
   *
   * `electron-main.js` incorpora QUESTO server nel proprio processo e vi lascia
   * un oggetto con le azioni che solo il lato desktop può eseguire (per ora il
   * controllo degli aggiornamenti). Se il server gira da solo — `npm start`, la
   * CLI, i test — l'oggetto non c'è e le relative funzioni non vengono offerte
   * all'interfaccia: la voce di menu semplicemente non compare, invece di
   * comparire e poi fallire.
   * ------------------------------------------------------------------------- */
  function ponteDesktop() {
    const p = config.desktop;
    return (p && typeof p.controllaAggiornamenti === 'function') ? p : null;
  }

  function capacitaDesktop() {
    return { desktop: Boolean(process.versions.electron), aggiornamenti: Boolean(ponteDesktop()) };
  }

  let cacheLicenza = null;

  function datiLicenza() {
    if (cacheLicenza) return cacheLicenza;

    const leggi = (f) => { try { return fs.readFileSync(path.join(config.rootDir, f), 'utf8'); } catch { return ''; } };
    const pkg = (() => { try { return require('../package.json'); } catch { return {}; } })();

    // Il campo della licenza ha tre forme storiche in npm: la stringa SPDX
    // (`license`), l'oggetto `{type}` e l'array `licenses[]` — usato ancora oggi
    // da pacchetti diffusi come ssh2. Leggerne una sola significa mostrare "—"
    // accanto a una libreria che la licenza ce l'ha eccome.
    const licenzaDi = (p) => {
      if (typeof p.license === 'string') return p.license;
      if (p.license && typeof p.license.type === 'string') return p.license.type;
      if (Array.isArray(p.licenses) && p.licenses.length) {
        return p.licenses.map((l) => (typeof l === 'string' ? l : l && l.type)).filter(Boolean).join(', ') || '—';
      }
      return '—';
    };

    const dipendenze = Object.keys(pkg.dependencies || {}).sort().map((nome) => {
      try {
        const p = require(`../node_modules/${nome}/package.json`);
        return { nome, versione: p.version || '', licenza: licenzaDi(p) };
      } catch {
        return { nome, versione: '', licenza: '—' };
      }
    });

    cacheLicenza = {
      version: APP_VERSION,
      licenza: pkg.license || 'AGPL-3.0-only',
      autore: pkg.author || '',
      repository: (pkg.repository && pkg.repository.url) || '',
      manleva: leggi('MANLEVA.md'),
      eula: leggi('EULA.md'),
      testoLicenza: leggi('LICENSE.md'),
      dipendenze: [...dipendenze, ...VENDORIZZATE],
    };
    return cacheLicenza;
  }

  return {
    APP_VERSION,
    ponteDesktop,
    capacitaDesktop,
    datiLicenza
  };
}

module.exports = { createModule };

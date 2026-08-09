'use strict';

/* ---------------------------------------------------------------------------
 * Genera `build/license.txt`, la pagina di accettazione mostrata dall'installer
 * NSIS (package.json → build.nsis.license), partendo da `MANLEVA.md` e da
 * `EULA.md`.
 *
 * Perché generarlo invece di scriverlo a mano: quei testi compaiono in due
 * posti — l'installer e la schermata "Informazioni & Licenza" dentro l'app — e
 * due copie scritte a mano divergono alla prima correzione, con il risultato
 * peggiore possibile: due versioni diverse dello stesso impegno legale. Le
 * sorgenti sono i due file markdown (che l'app legge a runtime) e questo script
 * ne ricava la versione per NSIS. `npm test` verifica che il file generato sia
 * allineato, così una modifica senza rigenerazione non passa inosservata.
 *
 * L'EULA sta QUI e non solo nell'app perché l'installer è il punto in cui
 * l'utente lo accetta davvero: mostrare la sola manleva significherebbe
 * chiedere l'accettazione di metà accordo.
 *
 * Due dettagli non ovvi del formato:
 *  - NSIS legge il file come testo semplice: il markdown va tolto, altrimenti
 *    nella finestra dell'installer si leggono gli asterischi e i backtick;
 *  - il testo va scritto in UTF-8 CON BOM, altrimenti NSIS lo interpreta come
 *    ANSI e gli accenti italiani diventano caratteri illeggibili proprio nella
 *    schermata che l'utente deve accettare.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

const RADICE = path.join(__dirname, '..');
const SORGENTE = path.join(RADICE, 'MANLEVA.md');
const SORGENTE_EULA = path.join(RADICE, 'EULA.md');
const USCITA = path.join(RADICE, 'build', 'license.txt');
const COLONNE = 78;

/**
 * Markdown → testo semplice (solo ciò che compare davvero in MANLEVA.md).
 *
 * Prima cosa: **normalizzare i fine riga**. Su Windows `core.autocrlf` consegna
 * `MANLEVA.md` con CRLF, e la divisione dei paragrafi (`/\n{2,}/`) su `\r\n\r\n`
 * non trova due `\n` adiacenti: il testo diventava un unico paragrafo. Non è un
 * difetto teorico — il file generato su Windows era un muro di testo, mentre la
 * stessa esecuzione su Linux produceva la versione corretta, e i due non
 * combaciavano più.
 */
function testoSemplice(md) {
  return md
    .replace(/\r\n?/g, '\n')           // CRLF/CR → LF (vedi sopra)
    .replace(/^#\s+/gm, '')            // titolo di primo livello
    .replace(/^#{2,}\s+/gm, '')        // sottotitoli
    .replace(/\*\*(.+?)\*\*/gs, '$1')  // grassetto
    .replace(/`([^`]+)`/g, '$1');      // codice inline
}

/** Manda a capo un testo continuo, con un rientro sulle righe successive. */
function avvolgi(testo, primaRiga = '', continua = '') {
  const parole = testo.replace(/\s*\n\s*/g, ' ').trim().split(/\s+/);
  const righe = [];
  let riga = '';
  let prefisso = primaRiga;
  for (const p of parole) {
    if (!riga) riga = prefisso + p;
    else if ((riga + ' ' + p).length <= COLONNE) riga += ` ${p}`;
    else { righe.push(riga); prefisso = continua; riga = prefisso + p; }
  }
  if (riga.trim()) righe.push(riga);
  return righe;
}

/**
 * A capo a COLONNE caratteri, conservando i paragrafi e gli ELENCHI puntati:
 * l'EULA ne usa, e fondere le voci in un unico paragrafo renderebbe illeggibile
 * proprio l'elenco degli obblighi da accettare.
 */
function impagina(testo) {
  return testo.split(/\n{2,}/).map((par) => {
    const blocco = par.trim();
    if (/^-\s+/.test(blocco)) {
      return blocco
        .split(/\n(?=-\s+)/)
        .flatMap((voce) => avvolgi(voce.replace(/^-\s+/, ''), '  - ', '    '))
        .join('\r\n');
    }
    return avvolgi(par).join('\r\n'); // CRLF: è un file letto da un installer Windows
  }).join('\r\n\r\n');
}

function contenutoLicenza() {
  const manleva = testoSemplice(fs.readFileSync(SORGENTE, 'utf8'));
  const eula = testoSemplice(fs.readFileSync(SORGENTE_EULA, 'utf8'));
  const corpo = impagina(`${manleva.trim()}\n\n${'-'.repeat(COLONNE)}\n\n${eula.trim()}`);
  return `﻿${corpo}\r\n`;
}

function genera() {
  const testo = contenutoLicenza();
  fs.mkdirSync(path.dirname(USCITA), { recursive: true });
  fs.writeFileSync(USCITA, testo, 'utf8');
  return testo;
}

module.exports = { genera, contenutoLicenza, SORGENTE, SORGENTE_EULA, USCITA };

if (require.main === module) {
  genera();
  console.log(`Generato ${path.relative(RADICE, USCITA)} da ${path.basename(SORGENTE)} + ${path.basename(SORGENTE_EULA)}`);
}

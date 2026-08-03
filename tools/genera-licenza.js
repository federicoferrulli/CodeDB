'use strict';

/* ---------------------------------------------------------------------------
 * Genera `build/license.txt`, la pagina di accettazione mostrata dall'installer
 * NSIS (package.json → build.nsis.license), partendo da `MANLEVA.md`.
 *
 * Perché generarlo invece di scriverlo a mano: il testo della manleva compare
 * in due posti — l'installer e la schermata "Informazioni & Licenza" dentro
 * l'app — e due copie scritte a mano divergono alla prima correzione, con il
 * risultato peggiore possibile: due versioni diverse dello stesso impegno
 * legale. La sorgente è una sola (`MANLEVA.md`, che l'app legge a runtime) e
 * questo script ne ricava la versione per NSIS. `npm test` verifica che il file
 * generato sia allineato, così una modifica alla manleva senza rigenerazione
 * non passa inosservata.
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
const USCITA = path.join(RADICE, 'build', 'license.txt');
const COLONNE = 78;

/** Markdown → testo semplice (solo ciò che compare davvero in MANLEVA.md). */
function testoSemplice(md) {
  return md
    .replace(/^#\s+/gm, '')            // titolo di primo livello
    .replace(/^#{2,}\s+/gm, '')        // sottotitoli
    .replace(/\*\*(.+?)\*\*/gs, '$1')  // grassetto
    .replace(/`([^`]+)`/g, '$1');      // codice inline
}

/** A capo a COLONNE caratteri, conservando i paragrafi. */
function impagina(testo) {
  return testo.split(/\n{2,}/).map((par) => {
    const parole = par.replace(/\s*\n\s*/g, ' ').trim().split(/\s+/);
    const righe = [];
    let riga = '';
    for (const p of parole) {
      if (!riga) riga = p;
      else if ((riga + ' ' + p).length <= COLONNE) riga += ` ${p}`;
      else { righe.push(riga); riga = p; }
    }
    if (riga) righe.push(riga);
    return righe.join('\r\n'); // CRLF: è un file letto da un installer Windows
  }).join('\r\n\r\n');
}

function contenutoLicenza() {
  const md = fs.readFileSync(SORGENTE, 'utf8');
  const corpo = impagina(testoSemplice(md));
  return `﻿${corpo}\r\n`;
}

function genera() {
  const testo = contenutoLicenza();
  fs.mkdirSync(path.dirname(USCITA), { recursive: true });
  fs.writeFileSync(USCITA, testo, 'utf8');
  return testo;
}

module.exports = { genera, contenutoLicenza, SORGENTE, USCITA };

if (require.main === module) {
  genera();
  console.log(`Generato ${path.relative(RADICE, USCITA)} da ${path.basename(SORGENTE)}`);
}

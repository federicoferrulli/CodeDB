'use strict';

// Adattamento del runner ai browser già installati. Le suite originali usano
// chromium.launch() senza percorso: quando richiesto dal laboratorio si usa
// Chrome/Edge locale, senza cambiare il test o i file dell'applicazione.
if (process.env.LAB_BROWSER_EXECUTABLE) {
  const { chromium } = require('playwright');
  const launch = chromium.launch.bind(chromium);
  chromium.launch = options => launch({ ...options, executablePath: process.env.LAB_BROWSER_EXECUTABLE });
}

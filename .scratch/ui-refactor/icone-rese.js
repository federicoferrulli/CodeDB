'use strict';
/* Ogni <i data-lucide> del documento produce davvero un <svg>? */
const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
(async () => {
  const server = await startTestServer({ port: 3493 });
  const b = await chromium.launch(); const page = await b.newPage({viewport:{width:1600,height:950}});
  const errori = []; page.on('pageerror', e => errori.push(e.message));
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid', { state:'attached', timeout: 15000 });
  await page.waitForTimeout(2500);
  console.log(JSON.stringify(await page.evaluate(() => {
    const pascal = (k) => k.split('-').map(p => p[0].toUpperCase()+p.slice(1)).join('');
    const noti = new Set(Object.keys(window.lucide).filter(k=>/^[A-Z]/.test(k)));
    const nomi = [...document.querySelectorAll('[data-lucide]')].map(e=>e.dataset.lucide);
    const sconosciuti = [...new Set(nomi)].filter(n=>!noti.has(pascal(n)));
    // <i> rimasti senza <svg> dentro: l'icona non e' stata disegnata
    const nonResi = [...document.querySelectorAll('i[data-lucide]')]
      .filter(e => !e.querySelector('svg')).map(e => e.dataset.lucide);
    return { totaleNodi: nomi.length, distinti: new Set(nomi).size, sconosciuti,
             nonResi: [...new Set(nonResi)], quantiNonResi: nonResi.length };
  }), null, 1));
  console.log('errori JS:', errori);
  await b.close(); await server.stop();
})();

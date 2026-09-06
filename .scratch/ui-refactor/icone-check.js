'use strict';
/* Verifica quali nomi Lucide esistono davvero nel bundle incluso. */
const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
const nomi = process.argv.slice(2);
(async () => {
  const server = await startTestServer({ port: 3491 });
  const b = await chromium.launch(); const page = await b.newPage();
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.lucide, { timeout: 15000 });
  const res = await page.evaluate((ns) => {
    const pascal = (k) => k.split('-').map(p => p[0].toUpperCase() + p.slice(1)).join('');
    const disponibili = Object.keys(window.lucide).filter(k => /^[A-Z]/.test(k));
    return {
      totale: disponibili.length,
      esito: ns.map(n => [n, disponibili.includes(pascal(n))]),
    };
  }, nomi);
  console.log('icone disponibili nel bundle:', res.totale);
  for (const [n, ok] of res.esito) console.log((ok ? '  OK  ' : '  MANCA ') + n);
  await b.close(); await server.stop();
})();

'use strict';
const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3463 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errori = [];
  page.on('pageerror', (e) => errori.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errori.push('console: ' + m.text()); });
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => document.getElementById('onboarding-overlay')?.remove());

  const res = await page.evaluate(() => {
    const out = {};
    // 1. bottoni icona-only senza nome accessibile
    const nome = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') ||
      el.textContent.trim() || (el.getAttribute('aria-labelledby') ? 'labelledby' : ''));
    out.senzaNome = [...document.querySelectorAll('button')]
      .filter((b) => !nome(b))
      .map((b) => b.id || b.className || b.outerHTML.slice(0, 90));
    // 2. bottoni con solo title (nessun aria-label) e nessun testo
    out.soloTitle = [...document.querySelectorAll('button')]
      .filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label') && b.getAttribute('title'))
      .map((b) => b.id || b.className);
    // 3. input senza label
    out.inputSenzaLabel = [...document.querySelectorAll('input,select,textarea')]
      .filter((i) => i.type !== 'hidden' && !i.getAttribute('aria-label') && !i.getAttribute('aria-labelledby')
        && !document.querySelector(`label[for="${i.id}"]`) && !i.closest('label'))
      .map((i) => i.id || i.name || i.placeholder || i.className);
    return out;
  });
  console.log(JSON.stringify({ errori, ...res }, null, 1));
  await browser.close();
  await server.stop();
})();

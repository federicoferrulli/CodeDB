'use strict';
const fs = require('node:fs');
const { gzipSync } = require('node:zlib');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
(async () => {
  const server = await startTestServer({ port: 3173 });
  const browser = await chromium.launch();
  const samples = [];
  try {
    for (let run = 0; run < 3; run++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      await page.goto(server.url);
      await page.waitForSelector('html[data-arc-ready="true"]');
      await page.waitForTimeout(1800);
      const sample = await page.evaluate(() => ({
        bytes: performance.getEntriesByType('resource').filter(r => new URL(r.name).origin === location.origin && !r.name.includes('/socket.io/?')).reduce((sum, r) => sum + r.encodedBodySize, 0),
        dcl: performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,
        fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
      }));
      const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      samples.push({ run, ...sample, scriptMs: metrics.ScriptDuration * 1000 });
      await page.close();
    }
    const median = key => samples.map(s => s[key]).sort((a, b) => a - b)[1];
    const report = { samples, median: Object.fromEntries(['bytes', 'dcl', 'fcp', 'scriptMs'].map(k => [k, median(k)])),
      bundle: ['public/arc/ui.js', 'public/arc/ui.css'].map(file => { const data = fs.readFileSync(file); return { file, bytes: data.length, gzipBytes: gzipSync(data).length }; }) };
    fs.writeFileSync('test-reports/arc/performance-finale.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

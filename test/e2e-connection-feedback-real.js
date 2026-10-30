'use strict';

// CODEDB_REAL_CONNECTIONS: array JSON di { name, cfg }; credenziali solo in memoria.
// Solo connessioni e lettura dei cataloghi. Il vault appartiene al server usa-e-getta.
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

async function proxyLento(cfg) {
  const sockets = new Set();
  const timers = new Set();
  const proxy = net.createServer(client => {
    const upstream = net.connect({ host: cfg.host, port: Number(cfg.port) });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
    }
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    // Ritarda solo il trasporto: nessun ACK Socket.IO o risultato DB simulato.
    const timer = setTimeout(() => {
      timers.delete(timer);
      client.pipe(upstream); upstream.pipe(client);
    }, 400);
    timers.add(timer);
  });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve);
  });
  return {
    cfg: { ...cfg, host: '127.0.0.1', port: proxy.address().port },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => proxy.close(resolve));
    },
  };
}

(async () => {
  const connections = JSON.parse(process.env.CODEDB_REAL_CONNECTIONS || '[]');
  assert(connections.length, 'Configurare CODEDB_REAL_CONNECTIONS con i database di prova');
  const server = await startTestServer({ port: Number(process.env.E2E_PORT || 3197) });
  let browser;
  const proxies = [];
  const checks = [];
  const dir = 'test-reports/connection-feedback-real';
  fs.mkdirSync(dir, { recursive: true });
  try {
    browser = await chromium.launch();
    for (const connection of connections) {
      const proxy = await proxyLento(connection.cfg);
      proxies.push(proxy);
      for (const mobile of [false, true]) {
        const mode = mobile ? 'mobile' : 'desktop';
        const fixtureName = `${connection.name}-${mode}`;
        const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, serviceWorkers: 'block', reducedMotion: 'no-preference' });
        page.setDefaultTimeout(15000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        if (process.argv.includes('--mutant-progress')) await page.route('**/css/workbench.css', async route => {
          const response = await route.fetch();
          await route.fulfill({ response, body: (await response.text()) + '\n.connection-progress { display: none !important; }' });
        });
        await page.goto(server.url);
        await page.waitForSelector('html[data-arc-ready="true"]');
        await page.locator('#onboarding-overlay [data-azione="chiudi"]').click();
        await page.evaluate(async ({ name, cfg }) => {
          const { socket } = await import('/js/socket.js');
          if (!socket.connected) await new Promise(resolve => socket.once('connect', resolve));
          window.realFeedback = { responses: [], notices: [] };
          document.addEventListener('codedb:toast', event => window.realFeedback.notices.push(event.detail.message));
          // Osserva gli ACK reali senza sostituirli o ritardarli.
          const emit = socket.emit.bind(socket);
          socket.emit = (event, ...args) => {
            if (event === 'mongo:connect') {
              const ack = args.pop();
              args.push(response => { window.realFeedback.responses.push(response); ack(response); });
            }
            return emit(event, ...args);
          };
          for (const [suffix, fields] of [['ok', cfg], ['errore', { ...cfg, username: 'codedb_utente_inesistente_test', password: 'password_errata_di_prova', authSource: 'admin' }]]) {
            const res = await new Promise(resolve => socket.emit('connections:save', { name: `${name}-${suffix}`, cfg: fields }, resolve));
            if (!res.ok) throw new Error('Salvataggio della fixture nel vault isolato non riuscito');
          }
          (await import('/js/connmanager.js')).loadSavedConnections();
        }, { name: fixtureName, cfg: proxy.cfg });
        for (const success of [true, false]) {
          const suffix = success ? 'ok' : 'errore';
          if (mobile) await page.locator('#mobile-nav-conns').click();
          await page.locator('#conn-tree .node-label').filter({ hasText: `${fixtureName}-${suffix}` }).click();
          const progress = page.getByRole('progressbar', { name: 'Connessione in corso' });
          await progress.waitFor();
          assert.equal(await progress.evaluate(el => getComputedStyle(el, '::before').animationName), 'connection-progress');
          await page.waitForFunction(count => window.realFeedback.responses.length === count, success ? 1 : 2);
          const response = await page.evaluate(() => window.realFeedback.responses.at(-1));
          assert.equal(response.ok, success, `${connection.name}/${mode}/${suffix}: esito inatteso`);
          await progress.waitFor({ state: 'detached' });
          if (success) {
            assert(Array.isArray(response.databases), 'Catalogo ricevuto dal DB reale');
            assert(await page.evaluate(async () => (await import('/js/tabs.js')).activeTab().state.connected));
          } else {
            assert(response.error, 'Errore restituito dal driver reale');
            if (mobile) {
              const dialog = page.getByRole('dialog', { name: 'Connessione non riuscita' });
              await dialog.waitFor();
              await page.waitForFunction(() => !document.querySelector('.arc-navigation-sheet'));
              assert(await dialog.isVisible(), 'L’errore reale sopravvive alla chiusura del drawer');
              assert(await dialog.evaluate(el => el.contains(document.activeElement)));
              assert(await dialog.getByText(response.error, { exact: true }).isVisible());
              await page.screenshot({ path: `${dir}/${connection.name}-${mode}-errore.png` });
              await dialog.getByRole('button', { name: 'Ho capito' }).click();
              await dialog.waitFor({ state: 'detached' });
              assert.deepEqual(await page.evaluate(() => window.realFeedback.notices), []);
            } else {
              await page.getByText(response.error, { exact: true }).waitFor();
              assert((await page.evaluate(() => window.realFeedback.notices)).includes(response.error));
              await page.screenshot({ path: `${dir}/${connection.name}-${mode}-errore.png` });
            }
          }
          checks.push(`${connection.name}: ${mode}, ${suffix}, progress ed esito reale verificati`);
          console.log(`OK: ${checks.at(-1)}`);
        }
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify({ checks, trasporto: 'TCP reale, latenza iniziale 400 ms', scrittureDatabase: false }, null, 2));
  } finally {
    await browser?.close();
    for (const proxy of proxies) await proxy.close();
    await server.stop();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

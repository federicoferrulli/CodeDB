'use strict';
// Monitor reale nel browser; letture e terminazioni simulate, nessun client DB interrotto.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { scegliArc, spuntaArc } = require('./arc-controls');
const mutant = process.argv.includes('--mutant');
const mutantToggle = process.argv.includes('--mutant-toggle');
const mutantEntry = process.argv.includes('--mutant-entry');
const checksOnly = process.argv.includes('--checks-only');
const dir = `test-reports/sessioni-design-2026-10-12/${mutant ? 'mutante' : mutantToggle ? 'mutante-toggle' : mutantEntry ? 'mutante-ingresso' : process.argv.includes('--confirm') ? 'conferma' : 'dopo'}`;
(async () => {
  const server = await startTestServer({ port: 3212 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const report = { checks: [], layouts: [], frames: [], errors: [], environment: 'Chromium, sessioni e terminazioni sintetiche' };
  page.setDefaultTimeout(7000);
  page.on('pageerror', e => report.errors.push(e.message));
  fs.mkdirSync(dir, { recursive: true });
  const ok = text => { report.checks.push(text); console.log('OK', text); };
  try {
    await page.addInitScript(version => {
      localStorage.setItem('codedb:tema', 'dark');
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
    }, require('../package.json').version);
    if (mutantToggle || mutantEntry) await page.route('**/js/sessions.js', route => {
      const source = fs.readFileSync('public/js/sessions.js', 'utf8');
      const body = mutantToggle ? source.replace('if (nonAzionabile(s)) return mostraNonAzionabili;', 'if (nonAzionabile(s) && !mostraNonAzionabili) return false;') : source.replace("fill: 'backwards'", "fill: 'none'");
      return route.fulfill({ contentType: 'text/javascript', body });
    });
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      const { tabs, createTab } = await import('/js/tabs.js');
      window.sessionTabs = tabs;
      for (const [id, connName] of [['a', 'PostgreSQL · Produzione'], ['b', 'PostgreSQL · Analisi']]) {
        const t = createTab({ id, connName }); t.dbType = 'postgresql'; t.state.connected = true;
      }
      const base = { id: '71', identita: 'identita-71', utente: 'analista', db: 'contabilita', host: 'reporting.interno.example:5432', stato: 'inattiva', secondi: 75, secondiDi: 'inattivita', transazioneAperta: true, bloccaAltre: 1, blocchi: {}, query: 'UPDATE ordini\nSET stato = \'verificato\'\nWHERE id IN (SELECT ordine_id FROM pagamenti WHERE confermato = true);' };
      window.sessionFixture = { calls: [], kills: [], pending: [], hold: false, fail: false, rows: [
        base,
        { ...base, id: '72', identita: 'identita-72', utente: 'servizio_api', stato: 'in attesa', secondi: 120, secondiDi: 'query', bloccaAltre: 0, bloccataDa: ['71'], blocchi: { connessione: 'Il tuo ruolo permette di annullare la query, ma non di terminare questa connessione.' }, query: 'SELECT o.id, o.stato, c.ragione_sociale\nFROM ordini AS o\nJOIN clienti AS c ON c.id = o.cliente_id\nWHERE o.stato = \'in_attesa\';' },
        { ...base, id: '73', identita: 'identita-73', utente: '<img src=x> & batch', stato: 'inattiva', bloccaAltre: 0, transazioneAperta: false, query: '' },
        { ...base, id: '74', nostra: true, bloccaAltre: 0, transazioneAperta: false, blocchi: { query: 'Connessione aperta da CodeDB.', connessione: 'Connessione aperta da CodeDB.' } },
        { ...base, id: '75', interna: true, bloccaAltre: 0, transazioneAperta: false, blocchi: { query: 'Processo di servizio del server.', connessione: 'Processo di servizio del server.' } },
      ] };
      const fake = { connected: true, on() {}, off() {}, timeout() { return { emit: (name, payload, cb) => fake.emit(name, payload, r => cb(null, r)) }; }, emit(name, payload, cb) {
        const f = window.sessionFixture;
        if (name === 'db:killSession') { f.kills.push(payload); return cb({ ok: true, terminata: true }); }
        if (name !== 'db:sessions') return cb?.({ ok: true, databases: [], collections: [] });
        f.calls.push(payload);
        const rows = structuredClone(f.rows);
        if (payload.tabId === 'b') rows.forEach(r => { r.utente = 'analisi'; });
        const response = f.fail ? { ok: false, error: 'Permesso negato dal server' } : { ok: true, sessioni: rows, capacita: {}, diagnosi: rows.some(r => r.bloccaAltre) ? { livello: 'allarme', titolo: 'Una transazione sta bloccando il database', dettaglio: 'La sessione 71 è inattiva con una transazione aperta. La sessione 72 attende il suo lock.', azione: { id: '71', modo: 'connessione' } } : { livello: 'ok', titolo: 'Nessun blocco rilevato' } };
        if (f.hold) f.pending.push(() => cb(response)); else cb(response);
      } };
      impostaSocket(fake);
    });
    const open = async () => { await page.locator('#btn-sessions').evaluate(el => el.click()); await page.waitForSelector('#modal-sessions[data-arc-dialog="open"]'); await page.waitForTimeout(400); };
    const close = async () => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('modal-sessions').dataset.arcDialog); };
    const refresh = async () => { await page.locator('#btn-refresh-sessions').click(); await page.waitForFunction(() => !document.getElementById('btn-refresh-sessions').disabled); };
    await open();
    await spuntaArc(page, '#sessions-auto-refresh', false);
    assert.equal(await page.locator('.sessions-table thead th').count(), 4);
    assert.equal(await page.locator('.sessions-table tbody tr').count(), 2);
    assert.match(await page.locator('[data-session-id="71"]').textContent(), /transazione aperta/);
    const calls = await page.evaluate(() => window.sessionFixture.calls.length);
    await spuntaArc(page, '#sessions-only-active', false);
    assert.equal(await page.locator('.sessions-table tbody tr').count(), 3);
    assert.equal(await page.locator('#sessions-list img').count(), 0);
    await page.locator('[data-toggle-nascosti]').click();
    assert.equal(await page.locator('.sessions-table tbody tr').count(), 5);
    assert.equal(await page.locator('[data-session-id="74"] [data-kill]').count(), 0);
    assert.equal(await page.evaluate(() => window.sessionFixture.calls.length), calls);
    await page.locator('[data-toggle-nascosti]').click();
    await spuntaArc(page, '#sessions-only-active', true);
    await page.locator('[data-toggle-nascosti]').click();
    assert.equal(await page.locator('.sessions-table tbody tr').count(), 4, 'Mostra include CodeDB e servizi inattivi anche con Solo attive');
    assert.equal(await page.locator('[data-toggle-nascosti]').getAttribute('aria-expanded'), 'true');
    assert(await page.locator('[data-toggle-nascosti]').evaluate(el => document.activeElement === el), 'Focus conservato passando da Mostra a Nascondi');
    await refresh();
    assert.equal(await page.locator('.sessions-table tbody tr').count(), 4, 'La scelta Mostra sopravvive al refresh');
    await page.locator('[data-toggle-nascosti]').click();
    assert.equal(await page.locator('.sessions-table tbody tr').count(), 2, 'Nascondi esclude nuovamente CodeDB e servizi');
    ok('Quattro colonne, filtri locali, transazioni inattive visibili, sessioni protette senza azioni e testo escaped');
    report.entrance = await page.evaluate(async () => {
      window.sessionFixture.rows.push({ ...window.sessionFixture.rows[0], id: '76', identita: 'identita-76' });
      document.getElementById('btn-refresh-sessions').click();
      await new Promise(requestAnimationFrame);
      const row = document.querySelector('[data-session-id="76"]'), animation = row.getAnimations()[0];
      const delay = animation.effect.getTiming().delay;
      animation.pause(); animation.currentTime = delay / 2;
      const opacity = getComputedStyle(row).opacity;
      animation.cancel(); window.sessionFixture.rows.pop();
      return { delay, opacity };
    });
    assert(report.entrance.delay > 0 && Number(report.entrance.opacity) === 0, 'La riga resta nascosta durante il ritardo di ingresso, senza lampeggio');
    await refresh();
    await page.waitForTimeout(450);
    await page.locator('[data-session-query="71"]').focus();
    if (mutant) await page.evaluate(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) { return animate.call(this, frames, this.matches('.sessions-cell-value') ? { ...options, duration: 0 } : options); };
    });
    report.frames = await page.evaluate(async () => {
      const row = document.querySelector('[data-session-id="71"]'), button = document.activeElement;
      window.sessionStable = { row, button };
      window.sessionFixture.rows[0].secondi = 92;
      const frames = [], start = performance.now(); document.getElementById('btn-refresh-sessions').click();
      await new Promise(resolve => { function sample(now) {
        frames.push(getComputedStyle(row.cells[1].firstElementChild).transform);
        if (now - start < 350) requestAnimationFrame(sample); else resolve();
      } requestAnimationFrame(sample); });
      return frames;
    });
    assert(new Set(report.frames).size > 3, 'La durata aggiornata attraversa fotogrammi intermedi');
    assert(await page.evaluate(() => window.sessionStable.row === document.querySelector('[data-session-id="71"]') && document.activeElement === window.sessionStable.button));
    await refresh();
    assert.equal(await page.locator('#sessions-list').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.locator('[data-session-query="71"]').click();
    await page.waitForSelector('#session-query-overlay[data-arc-dialog="open"]');
    assert.equal(await page.locator('#session-query-text').inputValue(), await page.evaluate(() => window.sessionFixture.rows[0].query));
    assert.match(await page.locator('#session-query-context').textContent(), /Produzione/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('session-query-overlay').dataset.arcDialog);
    assert(await page.locator('#modal-sessions').isVisible());
    ok('Aggiornamenti animati solo nelle celle cambiate, identità e focus stabili, query integrale e chiusura del solo lettore');
    page.once('dialog', async dialog => { assert.match(dialog.message(), /Produzione/); await dialog.dismiss(); });
    await page.locator('[data-session-id="72"] [data-kill="query"]').click();
    assert.equal(await page.evaluate(() => window.sessionFixture.kills.length), 0);
    await page.evaluate(() => { window.sessionTabs.activeId = 'b'; });
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-session-id="72"] [data-kill="query"]').click();
    await page.waitForFunction(() => window.sessionFixture.kills.length === 1);
    const kill = await page.evaluate(() => window.sessionFixture.kills[0]);
    assert.equal(kill.tabId, 'a'); assert.equal(kill.id, '72'); assert.equal(kill.identita, 'identita-72'); assert.equal(kill.modo, 'query');
    ok('Conferma annullabile e bersaglio esplicito con identità, indipendente dalla scheda attiva');
    await page.evaluate(() => { window.sessionFixture.hold = true; });
    await refreshPending();
    await scegliArc(page, '#sessions-conn-select', 'b');
    await page.waitForFunction(() => window.sessionFixture.pending.length === 2);
    await spuntaArc(page, '#sessions-only-active', false);
    assert.equal(await page.locator('#sessions-list [data-kill]').count(), 0);
    await page.evaluate(() => { window.sessionFixture.pending.pop()(); });
    await page.waitForSelector('[data-session-id="71"]');
    await page.evaluate(() => { window.sessionFixture.pending.shift()(); window.sessionFixture.hold = false; });
    assert.match(await page.locator('[data-session-id="71"] .sessions-identity').textContent(), /analisi/);
    await scegliArc(page, '#sessions-conn-select', 'a');
    await spuntaArc(page, '#sessions-only-active', true);
    ok('Cambio server immediato senza vecchie azioni e risposta tardiva scartata');
    await page.evaluate(() => { window.sessionFixture.fail = true; });
    await refresh();
    await page.getByText('Sessioni non disponibili', { exact: true }).waitFor();
    assert.equal(await page.locator('#sessions-list [data-kill]').count(), 0);
    assert(!(await page.locator('#sessions-auto-refresh').isChecked()));
    await page.evaluate(() => { window.sessionFixture.fail = false; });
    await page.getByRole('button', { name: 'Riprova', exact: true }).click();
    await page.waitForSelector('[data-session-id="71"]');
    await page.evaluate(() => { window.sessionFixture.saved = window.sessionFixture.rows; window.sessionFixture.rows = [window.sessionFixture.rows[2]]; });
    await refresh();
    await page.getByText('Nessuna sessione corrispondente', { exact: true }).waitFor();
    assert.equal(await page.locator('#sessions-list table').count(), 0, 'Lo stato vuoto sostituisce le righe precedenti');
    await page.getByRole('button', { name: 'Mostra tutte', exact: true }).click();
    assert.equal(await page.locator('.sessions-table tbody tr').count(), 1);
    assert.equal(await page.locator('#sessions-list .data-empty-host').count(), 0, 'Le righe sostituiscono lo stato vuoto');
    await page.evaluate(() => { window.sessionFixture.rows = window.sessionFixture.saved; });
    await refresh();
    await page.locator('[data-toggle-nascosti]').click();
    await spuntaArc(page, '#sessions-only-active', true);
    ok('Errore senza dati azionabili obsoleti, riprova, e stato vuoto fedele ai filtri');
    for (const [width, height, theme] of [[1440, 900, 'dark'], [1440, 900, 'light'], [390, 844, 'dark'], [320, 720, 'light'], [844, 390, 'dark']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.waitForTimeout(450);
      const layout = await page.locator('#modal-sessions .modal').evaluate(el => {
        el.scrollTop = 0;
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, panelWidth: b.width, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, shellWidth: document.documentElement.scrollWidth };
      });
      assert(layout.x >= -1 && layout.x + layout.panelWidth <= width + 1 && layout.y >= -1);
      assert(layout.scrollWidth <= layout.clientWidth + 1 && layout.shellWidth <= width + 1, 'Nessun overflow orizzontale');
      if (width <= 900) {
        assert(await page.locator('#modal-sessions .arc-dialog-sheet').isVisible());
        for (const selector of ['#btn-refresh-sessions', '[data-session-query="71"]', '[data-session-id="71"] [data-kill="connessione"]']) assert((await page.locator(selector).boundingBox()).height >= 44);
      }
      report.layouts.push({ width, height, theme, ...layout });
      const contrast = await page.evaluate(() => {
        const ctx = document.createElement('canvas').getContext('2d');
        const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
        const lum = rgb => { const v = rgb.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4); return .2126 * v[0] + .7152 * v[1] + .0722 * v[2]; };
        return [...document.querySelectorAll('#modal-sessions .sessions-host, #modal-sessions .sessions-alt-off, #modal-sessions .health-err, #modal-sessions .sessions-query, #modal-sessions .sessions-hidden')].filter(el => el.getClientRects().length).map(el => {
          const parents = []; for (let p = el; p; p = p.parentElement) parents.unshift(p);
          let bg = [255, 255, 255]; for (const p of parents) { const c = rgba(getComputedStyle(p).backgroundColor), a = c[3] / 255; bg = bg.map((n, i) => n * (1 - a) + c[i] * a); }
          const fg = rgba(getComputedStyle(el).color), a = fg[3] / 255, l1 = lum(fg.slice(0, 3).map((n, i) => n * a + bg[i] * (1 - a))), l2 = lum(bg);
          return { text: el.textContent.slice(0, 60), ratio: (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05) };
        });
      });
      assert(contrast.every(c => c.ratio >= 4.5), JSON.stringify(contrast.filter(c => c.ratio < 4.5)));
      report.layouts.at(-1).contrast = contrast;
      if (!checksOnly) await page.screenshot({ path: `${dir}/sessioni-${theme}-${width}.png` });
      if (width === 390 || width === 1440 && theme === 'dark') {
        await page.locator('[data-session-query="71"]').click();
        await page.waitForSelector('#session-query-overlay[data-arc-dialog="open"]');
        await page.waitForTimeout(400);
        if (!checksOnly) await page.screenshot({ path: `${dir}/query-${width}.png` });
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('session-query-overlay').dataset.arcDialog);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await page.locator('[data-session-id="71"] [data-kill="connessione"]').click();
    await page.getByRole('button', { name: 'Annulla', exact: true }).click();
    assert.equal(await page.evaluate(() => window.sessionFixture.kills.length), 1);
    await spuntaArc(page, '#sessions-auto-refresh', true);
    await page.evaluate(() => { window.sessionFixture.hold = true; });
    await refreshPending();
    const beforeWait = await page.evaluate(() => window.sessionFixture.calls.length);
    await page.waitForTimeout(5200);
    assert.equal(await page.evaluate(() => window.sessionFixture.calls.length), beforeWait, 'Nessuna richiesta automatica sovrapposta');
    await close();
    await page.evaluate(() => { window.sessionFixture.pending.shift()(); window.sessionFixture.hold = false; });
    await page.waitForTimeout(5200);
    assert.equal(await page.evaluate(() => window.sessionFixture.calls.length), beforeWait, 'Nessun polling dopo la chiusura');
    await open();
    await spuntaArc(page, '#sessions-auto-refresh', false);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => { window.sessionFixture.rows[0].secondi = 120; });
    await refresh();
    assert.equal(await page.locator('#sessions-list').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.evaluate(() => { window.sessionFixture.tabs = [...window.sessionTabs.list]; window.sessionTabs.list.length = 0; });
    await refresh();
    await page.getByText('Nessun server da monitorare', { exact: true }).waitFor();
    await page.evaluate(() => { window.sessionTabs.list.push(...window.sessionFixture.tabs); });
    await refresh();
    assert.equal(await page.locator('#sessions-conn-select option').count(), 2);
    await close();
    assert.deepEqual(report.errors, []);
    ok('Layout desktop/mobile/landscape e temi, lettore mobile, conferma mobile annullabile, polling senza sovrapposizioni, movimento ridotto, recupero connessioni e zero errori JS');
    async function refreshPending() { await page.locator('#btn-refresh-sessions').click(); await page.waitForFunction(() => window.sessionFixture.pending.length > 0); }
  } catch (e) { report.failure = e.stack; throw e; }
  finally { fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); await server.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

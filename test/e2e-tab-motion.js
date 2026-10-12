'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const mutantOverlap = process.argv.includes('--mutant-overlap');
const mutantShift = process.argv.includes('--mutant-shift');
const screenshots = !process.argv.includes('--checks-only');
const dir = `test-reports/tab-motion-2026-10-12/${mutantShift ? 'mutante-shifting' : mutantOverlap ? 'mutante-sovrapposizione' : mutant ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3203 });
  const browser = await chromium.launch();
  const report = { checks: [], motion: [], errors: [] };
  const check = text => { report.checks.push(text); console.log('OK', text); };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => report.errors.push(error.message));
    if (mutantShift) await page.route('**/js/tab-drag.js', async route => {
      const response = await route.fetch(), source = await response.text();
      assert(source.includes('const passo = larghezza +'));
      await route.fulfill({ response, body: source.replace('const passo = larghezza + (parseFloat(getComputedStyle(bar).columnGap) || 0);', 'const passo = 0;') });
    });
    if (mutant || mutantOverlap) await page.route('**/js/tab-motion.js', async route => {
      const response = await route.fetch(), source = await response.text();
      let body = source;
      if (mutantOverlap) {
        assert(source.includes('if (!prima.has(el.dataset.tabId))'));
        body = source.replace('const prima = new Set', 'const rettangoli = new Map([...bar.querySelectorAll(\'[role="tab"]\')].map(el => [el.dataset.tabId, el.getBoundingClientRect()]));\n  const prima = new Set')
          .replace('if (!prima.has(el.dataset.tabId))', 'const p = rettangoli.get(el.dataset.tabId); if (p) anima(el, [{ transform: `translateX(${p.left - el.getBoundingClientRect().left}px)` }, { transform: "none" }], 240);\n        if (!prima.has(el.dataset.tabId))');
      } else {
        assert(source.includes('destinazione && !ridotto.matches'));
        body = source.replace('destinazione && !ridotto.matches', 'false');
      }
      await route.fulfill({ response, body });
    });
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({
      visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true,
    })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const t = await import('/js/tabs.js'), c = await import('/js/colltabs.js');
      const bar = await import('/js/tabbar.js'), workspace = await import('/js/workspace.js');
      const collections = ['Prova', 'clienti', 'ordini_in_anteprima'].map(name => ({ name }));
      const databases = [{ name: 'diego', collections }];
      const docs = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, nome: `Riga ${i + 1}`, stato: 'Attivo' }));
      (await import('/js/socket.js')).impostaSocket({ connected: true, on() {}, off() {}, emit(name, msg, cb) {
        cb?.({ ok: true, databases, collections, docs, data: docs, skip: 0, limit: 2000,
          total: docs.length, columns: ['id', 'nome', 'stato'], fields: [], indexes: [] });
      } });
      for (const [id, label, dbType] of [['mongo', 'mongodb', 'mongodb'], ['postgres', 'Postgresql', 'postgresql'], ['mysql', 'mysql-locale', 'mysql']]) {
        const tab = t.createTab({ id }); tab.label = label; tab.dbType = dbType;
        Object.assign(tab.state, { connected: true, connLabel: label, dbType, databases, limit: 2000 });
        t.tabs.activeId = id; bar.renderTabBar(); workspace.renderWorkspace();
        for (const { name } of collections) {
          c.openCollTab('diego', name, { preview: name === 'ordini_in_anteprima' });
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      t.switchTab('mongo'); c.switchCollTab(t.activeTab().state.collTabs[0].id);
      window.tabFixture = { t, c, bar, workspace };
      (await import('/js/theme.js')).scegliTema('dark');
    });
    const settle = () => page.waitForTimeout(350);
    await settle();
    const sovrapposizioni = await page.evaluate(() => {
      const { t, c } = window.tabFixture;
      t.activeTab().state.collTabs.reverse();
      c.renderCollTabBar();
      const bar = document.getElementById('coll-tab-bar');
      const animazioni = bar.getAnimations({ subtree: true });
      animazioni.forEach(a => a.pause());
      const collisioni = [];
      for (const ms of [0, 40, 80, 120, 180, 240]) {
        animazioni.forEach(a => { a.currentTime = ms; });
        const rects = [...bar.querySelectorAll('[role="tab"]')].map(el => el.getBoundingClientRect());
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
          if (Math.min(rects[i].right, rects[j].right) - Math.max(rects[i].left, rects[j].left) > 1) collisioni.push({ ms, i, j });
        }
      }
      animazioni.forEach(a => a.cancel());
      t.activeTab().state.collTabs.reverse();
      c.renderCollTabBar();
      return collisioni;
    });
    assert.deepEqual(sovrapposizioni, [], 'Le etichette delle tab non devono mai attraversarsi durante il riordino');
    check('Nessuna sovrapposizione delle etichette in sei fotogrammi del riordino');
    await settle();
    const allinea = async selector => {
      const bounds = await page.locator(selector).evaluate(bar => {
        const a = bar.querySelector('[aria-selected="true"]').getBoundingClientRect();
        const i = bar.querySelector('.tab-selection').getBoundingClientRect();
        return [Math.abs(a.left - i.left), Math.abs(a.width - i.width), Math.abs(a.top - i.top)];
      });
      assert(bounds.every(n => n < 1.1), `${selector}: indicatore allineato alla scheda attiva (${bounds})`);
    };
    for (const selector of ['#tab-bar', '#coll-tab-bar']) {
      const sample = await page.locator(selector).evaluate(bar => {
        const next = [...bar.querySelectorAll('[role="tab"]')].find(el => el.getAttribute('aria-selected') === 'false');
        const before = bar.querySelector('.tab-selection').getBoundingClientRect().left;
        next.click();
        const indicator = bar.querySelector('.tab-selection');
        const animation = indicator.getAnimations()[0];
        if (!animation) return { animated: false };
        animation.pause(); animation.currentTime = 0;
        const start = indicator.getBoundingClientRect().left;
        animation.currentTime = 85;
        const middle = indicator.getBoundingClientRect().left;
        animation.currentTime = 280;
        const end = indicator.getBoundingClientRect().left;
        const keys = animation.effect.getKeyframes().map(f => Object.keys(f));
        animation.cancel();
        return { animated: true, before, start, middle, end, keys, active: bar.querySelector('[aria-selected="true"]').dataset.tabId, expected: next.dataset.tabId };
      });
      report.motion.push({ selector, ...sample });
      assert(sample.animated, `${selector}: il cambio scheda deve animare l’indicatore`);
      assert.equal(sample.active, sample.expected, 'La selezione cambia subito');
      assert(Math.abs(sample.before - sample.start) < 1.1, 'L’indicatore parte dalla posizione precedente');
      assert(sample.middle > Math.min(sample.start, sample.end) && sample.middle < Math.max(sample.start, sample.end), 'L’indicatore attraversa una posizione intermedia');
      assert(sample.keys.flat().every(key => ['offset', 'computedOffset', 'easing', 'composite', 'transform', 'opacity'].includes(key)), 'Si animano solo trasformazioni e opacità');
      await settle(); await allinea(selector);
    }
    check('Selezione immediata e indicatore continuo per connessioni e documenti');

    const rapid = await page.evaluate(() => {
      const bar = document.getElementById('tab-bar');
      const tabs = [...bar.querySelectorAll('[role="tab"]')];
      tabs[0].click();
      const old = bar.querySelector('.tab-selection').getAnimations()[0];
      old.pause(); old.currentTime = 70;
      const before = bar.querySelector('.tab-selection').getBoundingClientRect().left;
      bar.querySelectorAll('[role="tab"]')[2].click();
      const next = bar.querySelector('.tab-selection').getAnimations()[0];
      next.pause(); next.currentTime = 0;
      const after = bar.querySelector('.tab-selection').getBoundingClientRect().left;
      next.play();
      return { before, after };
    });
    report.motion.push({ interrupted: rapid });
    assert(Math.abs(rapid.before - rapid.after) < 1.1, `Un cambio interrotto riparte dal fotogramma corrente: ${JSON.stringify(rapid)}`);
    await page.evaluate(() => { for (let i = 0; i < 15; i++) document.querySelectorAll('#tab-bar [role="tab"]')[i % 3].click(); });
    await settle(); await allinea('#tab-bar'); await allinea('#coll-tab-bar');
    assert.equal(await page.locator('.tab-selection').count(), 2);
    assert.equal(await page.locator('#tab-bar, #coll-tab-bar').evaluateAll(bars => bars.flatMap(bar => bar.getAnimations({ subtree: true })).length), 0, 'Nessuna animazione residua');
    check('Cambi rapidi e interruzioni senza salti o animazioni residue');

    const overflow = await page.evaluate(() => {
      const { t, c } = window.tabFixture;
      const st = t.activeTab().state, list = st.collTabs, active = st.activeCollId;
      const bar = document.getElementById('coll-tab-bar'), issues = [];
      st.collTabs = Array.from({ length: 16 }, (_, i) => ({ ...list[0], id: `overflow-${i}`, coll: `eventi_audit_archivio_${i}` }));
      bar.style.maxWidth = '420px';
      try {
        for (const i of [15, 0, 7, 15, 2]) {
          st.activeCollId = st.collTabs[i].id;
          c.renderCollTabBar();
          const animations = bar.getAnimations({ subtree: true });
          animations.forEach(a => a.pause());
          for (const ms of [0, 60, 140, 280]) {
            animations.forEach(a => { a.currentTime = ms; });
            const rects = [...bar.querySelectorAll('[role="tab"]')].map(el => el.getBoundingClientRect());
            if (rects.some((r, j) => j > 0 && r.left < rects[j - 1].right - 1)) issues.push({ i, ms });
          }
          const a = bar.querySelector('[aria-selected="true"]').getBoundingClientRect(), b = bar.getBoundingClientRect();
          if (a.left < b.left - 1 || a.right > b.right + 1) issues.push({ i, offscreen: true });
          animations.forEach(a => a.cancel());
        }
      } finally {
        st.collTabs = list; st.activeCollId = active;
        bar.style.maxWidth = '';
        c.renderCollTabBar();
      }
      return issues;
    });
    assert.deepEqual(overflow, [], 'Scroll automatico con sedici tab: nessun testo sovrapposto o selezione fuori vista');
    await settle();
    await page.evaluate(() => {
      const bar = document.getElementById('coll-tab-bar');
      const nodes = [...bar.querySelectorAll('[role="tab"]')], from = nodes[0], to = nodes.at(-1);
      const transfer = new DataTransfer();
      const first = from.getBoundingClientRect(), last = to.getBoundingClientRect();
      const fixture = window.dragFixture = { bar, nodes, from, transfer, first, last, order: window.tabFixture.t.activeTab().state.collTabs.slice() };
      transfer.setDragImage = canvas => { fixture.preview = { width: canvas.width, height: canvas.height, alpha: canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] }; };
      from.dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, clientX: first.left + 24, clientY: first.top + first.height / 2 }));
      bar.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: last.right - 8, clientY: first.top + first.height / 2 }));
    });
    await page.waitForTimeout(230);
    const drag = await page.evaluate(() => {
      const { bar, nodes, from, first, preview } = window.dragFixture;
      return { preview, gap: parseFloat(getComputedStyle(bar).columnGap), width: first.width,
        shifts: nodes.slice(1).map(n => new DOMMatrix(getComputedStyle(n).transform).m41),
        sourceShift: new DOMMatrix(getComputedStyle(from).transform).m41,
        opaque: getComputedStyle(from).opacity, count: bar.querySelectorAll('[role="tab"]').length,
        payload: JSON.parse(window.dragFixture.transfer.getData('application/codedb-tab')) };
    });
    assert.deepEqual(drag.preview, { width: 1, height: 1, alpha: 0 }, 'Il trascinamento non duplica la tab sotto il puntatore');
    assert(drag.shifts.every(dx => Math.abs(dx + drag.width + drag.gap) < 1), 'Le tab vicine aprono tutto lo spazio della scheda trascinata');
    assert(drag.sourceShift > 100 && drag.opaque === '1' && drag.count === 3, 'Una sola tab opaca segue il puntatore');
    assert(drag.payload.db && drag.payload.coll, 'Il payload per la split view rimane disponibile');
    if (screenshots) await page.screenshot({ path: `${dir}/riordino-in-corso.png`, clip: { x: 240, y: 40, width: 950, height: 95 } });
    await page.evaluate(() => {
      const { bar, transfer, first, last } = window.dragFixture;
      bar.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: last.right - 8, clientY: first.top + first.height / 2 }));
    });
    await settle();
    assert(await page.evaluate(() => {
      const { bar, nodes } = window.dragFixture;
      return bar.querySelector('[role="tab"]:last-of-type')?.dataset.tabId === nodes[0].dataset.tabId
        && !document.querySelector('.dragging, .tab-reordering, .split-dragging');
    }), 'Il rilascio conferma il riordino e ripulisce gli stati transitori');
    await page.evaluate(() => {
      window.tabFixture.t.activeTab().state.collTabs = window.dragFixture.order;
      window.tabFixture.c.renderCollTabBar();
      delete window.dragFixture;
    });
    await settle();
    check('Sedici tab, scroll automatico e riordino con spazio reale, tab opaca e payload split conservato');

    const reversibile = await page.evaluate(async () => {
      const risultati = [];
      const aspetta = () => new Promise(resolve => setTimeout(resolve, 220));
      for (const id of ['tab-bar', 'coll-tab-bar']) {
        const bar = document.getElementById(id), nodes = [...bar.querySelectorAll('[role="tab"]')];
        const from = nodes.at(-1), first = nodes[0].getBoundingClientRect(), last = from.getBoundingClientRect();
        const transfer = new DataTransfer(), y = first.top + first.height / 2;
        const invia = (target, type, x, clientY = y) => target.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: x, clientY }));
        invia(from, 'dragstart', last.left + last.width / 2);
        invia(bar, 'dragover', first.left + 4);
        await aspetta();
        const shifts = nodes.slice(0, -1).map(n => new DOMMatrix(getComputedStyle(n).transform).m41);
        invia(bar, 'dragover', last.left + last.width / 2);
        await aspetta();
        const tornate = nodes.every(n => Math.abs(new DOMMatrix(getComputedStyle(n).transform).m41) < 1);
        invia(from, 'dragend', last.left);
        risultati.push({ id, shifts, passo: last.width + parseFloat(getComputedStyle(bar).columnGap), tornate,
          pulito: !bar.querySelector('.dragging') && !bar.classList.contains('tab-reordering') });
      }
      const bar = document.getElementById('coll-tab-bar');
      const order = [...bar.querySelectorAll('[role="tab"]')].map(n => n.dataset.tabId);
      bar.style.maxWidth = '360px'; bar.scrollLeft = 0;
      const from = bar.querySelector('[role="tab"]'), r = from.getBoundingClientRect(), b = bar.getBoundingClientRect();
      const transfer = new DataTransfer();
      from.dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, clientX: r.left + 24, clientY: r.top + r.height / 2 }));
      bar.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: b.right - 3, clientY: r.top + r.height / 2 }));
      await aspetta();
      const scroll = bar.scrollLeft;
      window.tabFixture.c.renderCollTabBar();
      const annullato = !document.querySelector('.dragging, .tab-reordering, .split-dragging');
      const invariato = order.join() === [...bar.querySelectorAll('[role="tab"]')].map(n => n.dataset.tabId).join();
      bar.style.maxWidth = ''; bar.scrollLeft = 0;
      return { risultati, scroll, annullato, invariato };
    });
    for (const r of reversibile.risultati) {
      assert(r.shifts.every(dx => Math.abs(dx - r.passo) < 1), `${r.id}: apertura del varco anche verso sinistra`);
      assert(r.tornate && r.pulito, `${r.id}: inversione e annullamento senza segni residui`);
    }
    assert(reversibile.scroll > 40 && reversibile.annullato && reversibile.invariato, 'Scroll continuo al bordo e ri-render durante il gesto senza cambiare ordine');
    check('Riordino in entrambe le direzioni, inversione, annullamento, auto-scroll e ri-render durante il gesto');

    await page.locator('#tab-bar [aria-selected="true"]').press('Home');
    await page.locator('#tab-bar [aria-selected="true"]').press('ArrowRight');
    assert.equal(await page.locator('#tab-bar [aria-selected="true"]').getAttribute('data-tab-id'), 'postgres');
    assert(await page.locator('#tab-bar [aria-selected="true"]').evaluate(el => el === document.activeElement));
    await page.locator('#coll-tab-bar [aria-selected="true"]').press('Home');
    await page.locator('.view-tab[data-view="query"]').click();
    const draft = 'SELECT * FROM "diego"."Prova"; -- bozza conservata';
    await page.locator('#query-editor-input').fill(draft);
    await page.locator('#coll-tab-bar [role="tab"]').nth(1).click();
    await page.locator('#coll-tab-bar [role="tab"]').first().click();
    assert.equal(await page.locator('#query-editor-input').inputValue(), draft);
    await page.locator('#coll-tab-bar .coll-tab-pin').click();
    await settle();
    assert.equal(await page.locator('#coll-tab-bar .preview').count(), 0);
    await allinea('#coll-tab-bar');
    const order = await page.locator('#coll-tab-bar [role="tab"]').evaluateAll(els => els.map(el => el.dataset.tabId));
    await page.locator('#coll-tab-bar [role="tab"]').first().dragTo(page.locator('#coll-tab-bar [role="tab"]').last());
    await settle();
    const reordered = await page.locator('#coll-tab-bar [role="tab"]').evaluateAll(els => els.map(el => el.dataset.tabId));
    assert.equal(reordered.at(-1), order[0], 'Il trascinamento riordina le schede');
    await allinea('#coll-tab-bar');
    await page.locator('#query-editor-input').fill(`${draft}\n-- modifica appena scritta`);
    await page.locator('#tab-bar [data-tab-id="mysql"] .conn-tab-close').click();
    await page.waitForFunction(() => !document.querySelector('#tab-bar [data-tab-id="mysql"]'));
    assert.equal(await page.locator('#query-editor-input').inputValue(), `${draft}\n-- modifica appena scritta`, 'Chiudere una connessione inattiva conserva la bozza attiva senza ricostruire il workspace');
    await settle(); await allinea('#tab-bar');
    await page.locator('#tab-bar [role="tab"]').first().dragTo(page.locator('#tab-bar [role="tab"]').last());
    await settle(); await allinea('#tab-bar');
    assert.equal(await page.locator('#tab-bar [role="tab"]').last().getAttribute('data-tab-id'), 'mongo', 'Il riordino delle connessioni conserva la selezione');
    check('Tastiera, bozze, anteprime, riordino e chiusura di una connessione inattiva');

    report.performance = await page.evaluate(async () => {
      const clicks = [], frames = [];
      let running = true, last;
      const frame = time => { if (last) frames.push(time - last); last = time; if (running) requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      for (let i = 0; i < 12; i++) {
        const start = performance.now();
        document.querySelectorAll('#coll-tab-bar [role="tab"]')[i % 3].click();
        clicks.push(performance.now() - start);
        await new Promise(resolve => setTimeout(resolve, 90));
      }
      await new Promise(resolve => setTimeout(resolve, 350));
      running = false;
      const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
      return { switches: clicks.length, rowsPerDocument: 2000, clickMedianMs: percentile(clicks, .5), clickP95Ms: percentile(clicks, .95), frameMedianMs: percentile(frames, .5), frameP95Ms: percentile(frames, .95), framesOver50Ms: frames.filter(ms => ms > 50).length };
    });
    await allinea('#coll-tab-bar');
    check('Misurati dodici cambi con 2.000 righe per documento');

    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await settle();
      await allinea('#tab-bar'); await allinea('#coll-tab-bar');
      for (const theme of ['dark', 'light']) {
        await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme); await settle();
        if (screenshots) await page.screenshot({ path: `${dir}/tabs-${theme}-${width}.png`, clip: { x: 0, y: 0, width, height: 260 } });
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#tab-bar [role="tab"]').first().click();
    await page.locator('#coll-tab-bar [role="tab"]').last().click();
    assert.equal(await page.locator('#tab-bar, #coll-tab-bar').evaluateAll(bars => bars.flatMap(bar => bar.getAnimations({ subtree: true })).length), 0);
    await allinea('#tab-bar'); await allinea('#coll-tab-bar');
    await page.setViewportSize({ width: 390, height: 844 }); await settle();
    assert(await page.locator('#tab-bar').isHidden() && await page.locator('#coll-tab-bar').isHidden(), 'Su mobile rimane il drawer Schede');
    await page.locator('#documents-open').click();
    await page.locator('#documents-panel').waitFor({ state: 'visible' }); await settle();
    if (screenshots) await page.screenshot({ path: `${dir}/schede-mobile.png` });
    await page.locator('#documents-panel .document-row').nth(2).locator('button').first().click();
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 1440, height: 900 }); await settle();
    await allinea('#tab-bar'); await allinea('#coll-tab-bar');
    check('Due temi, resize, movimento ridotto e passaggio mobile/desktop con drawer Schede');
    const primaEscape = await page.locator('#coll-tab-bar [role="tab"]').evaluateAll(nodes => nodes.map(n => n.dataset.tabId));
    const sourceBox = await page.locator('#coll-tab-bar [role="tab"]').first().boundingBox();
    const targetBox = await page.locator('#coll-tab-bar [role="tab"]').last().boundingBox();
    await page.mouse.move(sourceBox.x + 24, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + 42, sourceBox.y + sourceBox.height / 2, { steps: 3 });
    await page.mouse.move(targetBox.x + targetBox.width - 8, targetBox.y + targetBox.height / 2, { steps: 5 });
    assert.equal(await page.locator('.tab-reordering .dragging').count(), 1);
    assert.equal(await page.locator('.tab-reordering [role="tab"]').first().evaluate(n => getComputedStyle(n).transitionDuration), '0s');
    await page.keyboard.press('Escape');
    await page.mouse.up(); await settle();
    assert.deepEqual(await page.locator('#coll-tab-bar [role="tab"]').evaluateAll(nodes => nodes.map(n => n.dataset.tabId)), primaEscape);
    assert.equal(await page.locator('.dragging, .tab-reordering, .split-dragging').count(), 0);
    check('Escape durante un trascinamento reale e movimento ridotto senza transizioni residue');
    const workspaceBox = await page.locator('#workspace').boundingBox();
    await page.locator('#coll-tab-bar [role="tab"]').first().dragTo(page.locator('#workspace'), {
      targetPosition: { x: workspaceBox.width - 20, y: workspaceBox.height / 2 },
    });
    await page.waitForFunction(() => document.querySelectorAll('.split-pane').length === 2);
    assert.equal(await page.locator('.dragging, .tab-reordering, .split-dragging').count(), 0);
    check('Trascinamento reale fuori dalla barra: tabella aperta nella split view');
    assert.deepEqual(report.errors, []);
  } finally {
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

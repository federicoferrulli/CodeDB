'use strict';

// Nessun database: eventi reali sulla selezione condivisa e stili dell'app.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    if (process.argv.includes('--mutant')) await page.route('**/css/style.css*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replaceAll('tr:has(> td.cell-focus)', 'tr:has(> td.focus-inesistente)') });
    });
    await page.goto(server.url);
    await page.evaluate(async () => {
      const { creaSelezioneCelle } = await import('/js/cellselect.js');
      document.body.replaceChildren();
      window.griglie = [];
      for (const nome of ['grid', 'split']) {
        const wrap = document.createElement('div');
        const table = document.createElement('table');
        if (nome === 'grid') table.id = nome;
        else table.className = 'pane-grid';
        table.innerHTML = '<thead><tr><th></th><th>id</th><th>nome</th><th>valore</th></tr></thead><tbody></tbody>';
        const tbody = table.tBodies[0];
        const righe = Array.from({ length: 4 }, (_, id) => ({ id, nome: 'Esempio', valore: 42 }));
        const disegna = () => {
          tbody.innerHTML = righe.map((doc, r) => `<tr class="${r % 2 === 0 ? 'grid-row-even' : ''}"><td>□</td>${Object.values(doc).map((v, c) => `<td data-r="${r}" data-c="${c}">${v}</td>`).join('')}</tr>`).join('');
        };
        disegna();
        wrap.append(table); document.body.append(wrap);
        const stato = { anchor: null, focus: null, cells: new Set() };
        const ist = creaSelezioneCelle({
          nome, tbody, thead: () => table.tHead, contenitore: () => wrap,
          info: () => null, righe: () => righe, colonne: () => ['id', 'nome', 'valore'],
          bersaglio: () => ({ dbType: 'mysql' }), stato: () => stato,
          visibile: () => true, assicuraRiga: () => {},
          contesto: () => ({}), ricarica: () => {}, modificaRiga: () => {},
          eliminaRighe: () => {}, motivoNoScrittura: () => null,
        });
        window.griglie.push({ tbody, ist, disegna });
      }
    });
    const cella = (r, c = 1) => page.locator(`#grid td[data-r="${r}"][data-c="${c}"]`);
    const aspetto = () => page.evaluate(() => {
      const tbody = window.griglie[0].tbody;
      const riga = tbody.querySelector('tr:has(.cell-focus)');
      const td = riga?.querySelector('td[data-c="2"]');
      const css = td && getComputedStyle(td);
      return {
        sfondo: css?.backgroundColor,
        segno: riga && getComputedStyle(riga.cells[0]).boxShadow,
        bordo: riga && getComputedStyle(riga).outlineStyle,
        altezza: riga?.getBoundingClientRect().height,
        attiva: tbody.querySelector('.cell-focus')?.dataset.r,
        contornoCella: tbody.querySelector('.cell-focus') && getComputedStyle(tbody.querySelector('.cell-focus')).outlineWidth,
      };
    });
    await cella(0).click();
    const prima = await aspetto();
    assert.notEqual(prima.sfondo, 'rgba(0, 0, 0, 0)', 'La riga intera ha un fondo tenue');
    assert.match(prima.segno, /inset/, 'Indicatore geometrico oltre al colore');
    assert.equal(prima.contornoCella, '2px', 'La cella attiva rimane distinta');
    assert.equal(await page.locator('.pane-grid .cell-focus').count(), 0, 'Split-View indipendente');
    await page.keyboard.press('ArrowDown');
    assert.equal((await aspetto()).attiva, '1', 'La riga segue la tastiera');
    await page.keyboard.press('Shift+ArrowDown');
    assert.equal((await aspetto()).attiva, '2', 'La selezione multipla segue il punto attivo');
    await page.evaluate(() => { const g = window.griglie[0]; g.disegna(); g.ist.applica(); });
    assert.equal((await aspetto()).segno, prima.segno, 'Il render virtuale conserva il riferimento');
    assert.equal((await aspetto()).altezza, prima.altezza, 'Nessuno spostamento del layout');
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const ratios = await page.evaluate(() => {
        const row = document.querySelector('#grid tr:has(.cell-focus)');
        const css = getComputedStyle(row.cells[3]);
        // Il canvas compone le trasparenze come il browser, senza arrotondamenti manuali.
        const ctx = document.createElement('canvas').getContext('2d');
        const rgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        ctx.fillStyle = getComputedStyle(document.body).backgroundColor; ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = getComputedStyle(row).backgroundColor; ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = css.backgroundColor; ctx.fillRect(0, 0, 1, 1);
        const bg = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        const lum = color => color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
        const contrast = color => { const a = lum(rgb(color)), b = lum(bg); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
        return { testo: contrast(css.color), segno: contrast(css.getPropertyValue('--fg-dim')) };
      });
      assert(ratios.testo >= 4.5, `${theme}: contrasto del testo ${ratios.testo}`);
      assert(ratios.segno >= 3, `${theme}: contrasto del segno ${ratios.segno}`);
      console.log(`${theme}: testo ${ratios.testo.toFixed(2)}:1, indicatore ${ratios.segno.toFixed(2)}:1`);
    }
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    assert.equal((await aspetto()).bordo, 'solid', 'Alto contrasto: contorno della riga con colori di sistema');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#grid tr:has(.cell-focus)').count(), 0);
    assert(await page.locator('#grid tbody tr').evaluateAll(rows => rows.every(tr => getComputedStyle(tr.cells[0]).boxShadow === 'none')), 'Escape rimuove ogni segno');
    await page.locator('.pane-grid td[data-r="1"][data-c="1"]').click();
    assert.equal(await page.locator('.pane-grid tr:has(.cell-focus)').evaluate(tr => getComputedStyle(tr).outlineStyle), 'solid', 'Stessa evidenziazione nella Split-View');
    console.log('OK: riga attiva, tastiera, selezione multipla, render, isolamento, temi e alto contrasto');
  } finally {
    await browser.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

const assert = require('node:assert/strict');

// Il tocco attraversa il normale hit testing del browser. Solo l'azione finale
// viene intercettata: controlliamo anche Elimina senza modificare i dati.
async function verificaTocchi(page, root, nome) {
  const controls = root.locator('button, [role="button"], [role="combobox"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [role="tab"], input:not([type="hidden"]), textarea, select, a[href], [tabindex="0"], .schema-node-label, .fk-voce, .query-history-text, tr[data-riga]');
  const results = [];
  await root.evaluate(el => [el, ...el.querySelectorAll('*')].filter(n => n.scrollHeight > n.clientHeight).forEach(n => { n.dataset.testScroll = String(n.scrollTop); }));
  await page.evaluate(() => {
    window.__tocchi = { clicks: [], click(event) { window.__tocchi.clicks.push(event.target); event.preventDefault(); event.stopImmediatePropagation(); }, pointer(event) { event.stopImmediatePropagation(); } };
    window.addEventListener('click', window.__tocchi.click, true);
    window.addEventListener('dblclick', window.__tocchi.click, true);
    window.addEventListener('pointerdown', window.__tocchi.pointer, true);
  });
  try {
    for (const control of await controls.all()) {
      if (!await control.isVisible() || !await control.isEnabled()) continue;
      // Arc conserva gli input nativi nascosti per il form: si prova invece il
      // controllo accessibile che li sostituisce (combobox, checkbox, switch).
      const info = await control.evaluate(el => ({ label: el.id || el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim().slice(0, 65), disabled: !!el.closest('[inert], [aria-hidden="true"]') || el.getAttribute('aria-disabled') === 'true' }));
      if (info.disabled) continue;
      await control.scrollIntoViewIfNeeded();
      const geometry = await control.evaluate(el => {
        const r = el.getBoundingClientRect();
        const points = [[.5, .5], [.2, .5], [.8, .5]].map(([x, y]) => {
          const px = r.x + x * r.width, py = r.y + y * r.height;
          const hit = document.elementFromPoint(px, py);
          return { x: px, y: py, ok: el.contains(hit), blocker: hit && `${hit.tagName}#${hit.id}.${String(hit.className).slice(0, 100)}` };
        });
        return { points, width: r.width, height: r.height };
      });
      const entry = { panel: nome, label: info.label, ...geometry };
      results.push(entry);
      if (geometry.points.some(p => !p.ok)) continue;
      const point = geometry.points[0];
      await page.touchscreen.tap(point.x, point.y);
      // Il campo espande il drawer al focus: il clic può finire sulla vecchia
      // posizione, ma il campo deve comunque essere pronto per la scrittura.
      entry.clicked = await control.evaluate(el => el.matches('input:not([type="checkbox"]):not([type="radio"]), textarea') ? document.activeElement === el : el.contains(window.__tocchi.clicks.at(-1)));
      if (!entry.clicked) entry.actual = await page.evaluate(() => window.__tocchi.clicks.at(-1)?.outerHTML.slice(0, 240));
    }
  } finally {
    await page.evaluate(() => {
      window.removeEventListener('click', window.__tocchi.click, true);
      window.removeEventListener('dblclick', window.__tocchi.click, true);
      window.removeEventListener('pointerdown', window.__tocchi.pointer, true);
      delete window.__tocchi;
    });
    await root.evaluate(el => [el, ...el.querySelectorAll('[data-test-scroll]')].forEach(n => { if (n.dataset.testScroll != null) { n.scrollTop = Number(n.dataset.testScroll); delete n.dataset.testScroll; } }));
  }
  return results;
}

function assertTocchi(results) {
  const failures = results.filter(r => r.points.some(p => !p.ok) || !r.clicked);
  assert.deepEqual(failures, [], 'Ogni controllo visibile deve ricevere il tocco, anche dopo lo scorrimento');
}

module.exports = { verificaTocchi, assertTocchi };

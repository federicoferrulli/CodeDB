'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): nessun testo dell'interfaccia sotto la soglia di contrasto,
 * in tutte le viste e in ENTRAMBI i temi.
 *
 * PERCHÉ NON BASTA `unit-tema.js`
 * Quello prova le COPPIE di token dichiarate: dice che `--fg` su `--bg` regge.
 * Non può però sapere quale token finisce davvero sopra quale superficie, e i
 * difetti stavano tutti lì — l'intestazione della griglia usava `--fg-muted`
 * (il token del disabilitato) su `--bg-3`, cioè 2.36:1; l'accento #6366f1 era
 * usato sia come riempimento sotto testo bianco (4.47:1) sia come testo su
 * fondo scuro (3.87:1), due usi che un solo valore non può servire. Nessuna
 * delle due coppie era dichiarata da nessuna parte: nascevano dall'incontro fra
 * una regola CSS e l'elemento su cui capitava di applicarsi.
 *
 * Qui si misura il RESO: per ogni elemento con testo proprio si risale al primo
 * fondo opaco e si calcola il rapporto vero, con la soglia che dipende dal
 * corpo e dal peso del carattere (WCAG 2.1 1.4.3).
 *
 * Uso: node test/e2e-contrasto-viste.js
 * ------------------------------------------------------------------------- */

const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

const VISTE = ['view-data', 'view-details', 'view-uml', 'view-graph3d', 'view-query'];

let falliti = 0;
const ok = (cond, etichetta, dettaglio = '') => {
  if (cond) console.log(`  \x1b[32m✔ OK\x1b[0m   ${etichetta}`);
  else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m ${etichetta}${dettaglio ? `\n${dettaglio}` : ''}`);
    falliti++;
  }
};

/** Misura eseguita nella pagina: torna gli elementi sotto soglia. */
function misuraNellaPagina(vista) {
  const lum = (r, g, b) => {
    const c = [r, g, b].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const parse = (s) => {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  };
  // Il fondo VERO: il primo antenato con un colore sostanzialmente opaco.
  const fondo = (el) => {
    let n = el;
    while (n && n.nodeType === 1) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a >= 0.95) return c;
      n = n.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) || { r: 13, g: 17, b: 23, a: 1 };
  };
  const visibile = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };

  const res = [];
  for (const el of document.querySelectorAll('#workspace *, header *, #conn-sidebar *, #sidebar *')) {
    if (!visibile(el)) continue;
    // Solo elementi con testo PROPRIO: altrimenti si misurerebbe il colore
    // ereditato di un contenitore sopra un fondo che non è il suo.
    const testo = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
    if (!testo) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = fondo(el);
    const a = fg.a === undefined ? 1 : fg.a;
    const mix = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
    const L1 = lum(mix.r, mix.g, mix.b);
    const L2 = lum(bg.r, bg.g, bg.b);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize);
    const grassetto = parseInt(cs.fontWeight, 10) >= 700;
    const soglia = (px >= 24 || (px >= 18.66 && grassetto)) ? 3 : 4.5;
    if (ratio < soglia) {
      res.push({
        vista,
        sel: el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.')}`,
        testo: testo.slice(0, 28),
        ratio: +ratio.toFixed(2),
        soglia,
        px: +px.toFixed(1),
        colore: cs.color,
      });
    }
  }
  return res;
}

(async () => {
  console.log('--- E2E: contrasto del testo reso, nelle viste e nei due temi ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_CONTRASTO_PORT, 10) || 3153 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1500);

    // Righe vere: la griglia vuota non ha né celle né colori per tipo, cioè
    // proprio gli elementi in cui stavano i difetti.
    await page.evaluate(async () => {
      const { state } = await import('/js/state.js');
      const { renderGrid } = await import('/js/grid.js');
      document.getElementById('onboarding-overlay')?.remove();
      document.getElementById('welcome').classList.add('hidden');
      document.getElementById('tab-body').classList.remove('hidden');
      document.getElementById('workspace').classList.remove('hidden');
      document.getElementById('placeholder').classList.add('hidden');
      document.getElementById('coll-tab-bar').classList.remove('hidden');
      state.docs = Array.from({ length: 40 }, (_, i) => ({
        _id: i + 1, nome: `riga ${i}`, quantita: i, attivo: i % 2 === 0,
        vuoto: null, quando: { $date: new Date().toISOString() },
      }));
      state.columns = ['_id', 'nome', 'quantita', 'attivo', 'vuoto', 'quando'];
      state.total = 40;
      renderGrid();
    });

    for (const tema of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), tema);
      const sotto = [];
      for (const v of VISTE) {
        await page.evaluate((vista) => {
          for (const p of document.querySelectorAll('#workspace .view-panel')) p.classList.add('hidden');
          document.getElementById(vista).classList.remove('hidden');
        }, v);
        await page.waitForTimeout(250);
        sotto.push(...await page.evaluate(misuraNellaPagina, v));
      }
      const visti = new Set();
      const unici = sotto.filter((r) => {
        const k = `${r.sel}|${r.testo}`;
        if (visti.has(k)) return false;
        visti.add(k);
        return true;
      }).sort((a, b) => a.ratio - b.ratio);

      ok(unici.length === 0,
        `tema ${tema}: nessun testo sotto la soglia di contrasto`,
        unici.map((r) => `         ${r.ratio}:1 (serve ${r.soglia}) — ${r.vista} ${r.sel} «${r.testo}» ${r.px}px ${r.colore}`).join('\n'));
    }

    ok(errori.length === 0, 'nessun errore JavaScript durante la misura', `         ${errori.join('\n         ')}`);
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Contrasto: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- Contrasto: tutti i test superati ---');
})();

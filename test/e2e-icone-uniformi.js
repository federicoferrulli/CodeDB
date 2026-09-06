'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium) + controllo statico: le icone dell'interfaccia sono quelle
 * DELL'APPLICAZIONE, e vengono davvero disegnate.
 *
 * PERCHÉ ESISTE
 * L'interfaccia usava due sistemi insieme: le icone Lucide (`js/lucide.min.js`,
 * il sistema dell'applicazione) e un centinaio di emoji sparse nel markup e
 * nelle stringhe JavaScript. Un'emoji non è un'icona: cambia forma, colore e
 * larghezza da un sistema operativo all'altro — quindi i controlli non si
 * allineano — non eredita `currentColor`, quindi non segue il tema, e un
 * lettore di schermo la PRONUNCIA, così che il nome accessibile di «Elimina»
 * diventava «cestino Elimina».
 *
 * Ci sono due modi di sbagliare, e servono due controlli diversi:
 *
 *  1. usare un nome di icona che non esiste. Lucide non protesta: lascia
 *     l'elemento vuoto, cioè un buco silenzioso al posto dell'icona;
 *  2. inserire `<i data-lucide>` con innerHTML e dimenticare
 *     `refreshLucideIcons`. Anche qui: nessun errore, solo il buco.
 *
 * Il controllo statico prende il secondo caso anche sui rami che una prova
 * senza database non può raggiungere (il catalogo dei backup, lo storico
 * pieno): se un file EMETTE markup con `data-lucide`, deve anche disegnarlo.
 *
 * Uso: node test/e2e-icone-uniformi.js
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

let falliti = 0;
const ok = (cond, etichetta, dettaglio = '') => {
  if (cond) console.log(`  \x1b[32m✔ OK\x1b[0m   ${etichetta}`);
  else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m ${etichetta}${dettaglio ? `\n         ${dettaglio}` : ''}`);
    falliti++;
  }
};

const DIR_JS = path.join(__dirname, '..', 'public', 'js');

/**
 * Emoji ancora presenti nel CODICE (non nei commenti) dei moduli del frontend.
 * I commenti restano liberi: lì «la tab ⚡» è prosa che spiega, non interfaccia.
 */
function emojiNelCodice() {
  const EMOJI = /\p{Extended_Pictographic}/u;
  const trovate = [];
  for (const f of fs.readdirSync(DIR_JS).filter((n) => n.endsWith('.js'))) {
    const righe = fs.readFileSync(path.join(DIR_JS, f), 'utf8').split('\n');
    let inBlocco = false;
    righe.forEach((riga, i) => {
      const t = riga.trim();
      const eraBlocco = inBlocco || t.startsWith('/*');
      if (t.startsWith('/*')) inBlocco = true;
      if (t.includes('*/')) inBlocco = false;
      if (eraBlocco || t.startsWith('//') || t.startsWith('*')) return;
      // Anche il commento a FINE riga è un commento: senza toglierlo, una riga
      // di codice con accanto una nota che NOMINA un simbolo risultava
      // colpevole di usarlo.
      // Si parte dalla riga GIÀ ripulita (`t`): alcuni file hanno terminatori
      // CRLF, e con il `\r` in coda `$` non è mai raggiunto — lo strip non
      // scattava proprio sulle righe che avrebbe dovuto ripulire.
      let codice = t.replace(/\s+\/\/.*$/, '');
      // L'attribuzione di OpenStreetMap è un obbligo della licenza delle tile,
      // non un'icona dell'interfaccia: il simbolo di copyright deve restare, e
      // l'eccezione è scritta qui invece di essere un mistero.
      codice = codice.replace(/©/g, '');
      if (EMOJI.test(codice)) trovate.push(`${f}:${i + 1}  ${t.slice(0, 90)}`);
    });
  }
  return trovate;
}

/** Moduli che producono markup con `data-lucide` ma non lo disegnano mai. */
function emetteSenzaDisegnare() {
  const colpevoli = [];
  for (const f of fs.readdirSync(DIR_JS).filter((n) => n.endsWith('.js'))) {
    const s = fs.readFileSync(path.join(DIR_JS, f), 'utf8');
    const emette = /ICO\(|lucideIconHtml\(|dataset\.lucide|data-lucide=/.test(s);
    if (!emette) continue;
    // L'import non conta come disegno: conta la CHIAMATA.
    const senzaImport = s.replace(/^import[^;]*;/gm, '');
    if (!/refreshLucideIcons\s*\(/.test(senzaImport)) colpevoli.push(f);
  }
  return colpevoli;
}

(async () => {
  console.log('--- E2E: le icone sono quelle dell\'applicazione, e sono disegnate ---');

  /* --- 1. Controlli statici, senza browser ----------------------------- */

  const emoji = emojiNelCodice();
  ok(emoji.length === 0,
    `nessuna emoji nel codice dei moduli del frontend (${emoji.length})`,
    emoji.slice(0, 12).join('\n         '));

  const colpevoli = emetteSenzaDisegnare();
  ok(colpevoli.length === 0,
    'ogni modulo che EMETTE `data-lucide` chiama anche `refreshLucideIcons`',
    `senza disegno: ${colpevoli.join(', ')} — un <i> non disegnato e' un buco silenzioso`);

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const senzaCommenti = html.replace(/<!--[\s\S]*?-->/g, '');
  const emojiHtml = [...senzaCommenti.matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]);
  ok(emojiHtml.length === 0,
    `nessuna emoji nel markup di index.html (${emojiHtml.length})`,
    `trovate: ${[...new Set(emojiHtml)].join(' ')}`);

  /* --- 2. Nel browser: i nomi esistono e le icone compaiono ------------ */

  const server = await startTestServer({ port: parseInt(process.env.E2E_ICONE_PORT, 10) || 3157 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Si aprono TUTTE le modali del documento: molte costruiscono il proprio
    // contenuto poco prima di aprirsi, ed è lì che il disegno si dimentica.
    const apertura = await page.evaluate(async () => {
      const { openModal, showToast, showContextMenu } = await import('/js/utils.js');
      document.getElementById('onboarding-overlay')?.remove();
      const aperte = [];
      for (const el of document.querySelectorAll('.overlay')) {
        if (!el.id) continue;
        openModal(el);
        aperte.push(el.id);
      }
      showToast('prova', 'success');
      showContextMenu(20, 20, [
        { icona: 'trash-2', label: 'Elimina', action: () => {} },
        { icona: 'square-pen', label: 'Modifica', action: () => {} },
        '---',
        { label: 'Voce senza icona', action: () => {} },
      ]);
      return aperte.length;
    });
    await page.waitForTimeout(600);

    const resa = await page.evaluate(() => {
      const pascal = (k) => k.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
      const noti = new Set(Object.keys(window.lucide).filter((k) => /^[A-Z]/.test(k)));
      const nomi = [...document.querySelectorAll('[data-lucide]')].map((e) => e.dataset.lucide);
      // Un <i> rimasto <i>: Lucide sostituisce il nodo con un <svg> quando
      // disegna, quindi ogni <i data-lucide> ancora nel documento è un'icona
      // che non è stata disegnata.
      const nonResi = [...document.querySelectorAll('i[data-lucide]')].map((e) => e.dataset.lucide);
      return {
        totale: nomi.length,
        distinti: [...new Set(nomi)].length,
        sconosciuti: [...new Set(nomi)].filter((n) => !noti.has(pascal(n))),
        nonResi: [...new Set(nonResi)],
      };
    });

    ok(apertura > 0, `le modali del documento si aprono (${apertura})`);
    ok(resa.totale > 100, `il documento porta le icone dell'applicazione (${resa.totale} nodi, ${resa.distinti} distinte)`);
    ok(resa.sconosciuti.length === 0,
      'nessun nome di icona inesistente',
      `sconosciuti: ${resa.sconosciuti.join(', ')} — Lucide non protesta, lascia il posto vuoto`);
    ok(resa.nonResi.length === 0,
      'nessuna icona rimasta non disegnata',
      `non disegnate: ${resa.nonResi.join(', ')} — manca un refreshLucideIcons sul contenitore`);

    // Il menu contestuale: l'icona è un campo della voce, e l'etichetta NON la
    // contiene più. È la proprietà che rende leggibile il nome accessibile.
    const menu = await page.evaluate(() => {
      const voci = [...document.querySelectorAll('#context-menu li:not(.separator)')];
      return {
        quante: voci.length,
        conIcona: voci.filter((li) => li.querySelector('svg.lucide')).length,
        testi: voci.map((li) => li.textContent),
        // le etichette partono tutte dalla stessa ascissa, icona o no
        ascisse: [...new Set(voci.map((li) => {
          const r = li.getBoundingClientRect();
          const ultimo = [...li.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim())[0];
          if (!ultimo) return null;
          const range = document.createRange();
          range.selectNodeContents(ultimo);
          return Math.round(range.getBoundingClientRect().left - r.left);
        }).filter((v) => v !== null))],
      };
    });

    ok(menu.conIcona === 2, `le voci che dichiarano un'icona la mostrano (${menu.conIcona} su ${menu.quante})`);
    ok(menu.testi.every((t) => !/\p{Extended_Pictographic}/u.test(t)),
      'nessuna etichetta di menu contiene un pittogramma',
      JSON.stringify(menu.testi));
    ok(menu.ascisse.length === 1,
      `le etichette del menu partono tutte dalla stessa ascissa (${JSON.stringify(menu.ascisse)})`,
      'una voce senza icona non deve rientrare rispetto a quelle che ce l\'hanno');

    ok(errori.length === 0, 'nessun errore JavaScript durante le prove', errori.join('\n         '));
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Icone: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- Icone: tutti i test superati ---');
})();

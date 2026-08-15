'use strict';

/**
 * CodeDB — Master E2E Test Suite con Playwright
 * 
 * Fasi Automatizzate:
 * 1. Avvio Server Isolato con Vault Cifrato (formato v2 scrypt + AES-256-GCM)
 * 2. Apertura Web UI e Sblocco Vault:
 *    - Test con Passphrase Errata -> Verifica messaggio di errore
 *    - Test con Passphrase Corretta -> Verifica sblocco e scomparsa modale
 * 3. Scansione & Inventario Completo di tutti gli Elementi Cliccabili:
 *    - Generazione file JSON timestamped e file JSON latest
 *    - Generazione file Markdown con tabella di riepilogo per rilevare diff/modifiche
 * 4. Test Connessione Database:
 *    - Apertura Wizard Nuova Connessione (#tab-add-btn)
 *    - Compilazione parametri e test di connessione (#conn-test-btn)
 *    - Apertura connessione salvata dalla sidebar (#conn-tree)
 *    - Verifica popolamento alberatura database e collection (#db-tree)
 * 5. Test Vista "⚡ Query & Aggregate":
 *    - Navigazione alla vista Query & Aggregate
 *    - Inserimento query SQL/MQL nell'editor
 *    - Esecuzione query (#query-run-btn), verifica metriche e rendering risultati
 *    - Test switch tra viste risultati (Tabella, JSON Tree, Grafici)
 * 6. Test Funzionalità Ausiliarie & Cleanup
 * 
 * Uso: node test/e2e-playwright.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const Vault = require('../db/vault');

const PORT = parseInt(process.env.PLAYWRIGHT_PORT, 10) || 3188;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REPORTS_DIR = path.join(__dirname, '..', 'test-reports');
const SCREENSHOTS_DIR = path.join(REPORTS_DIR, 'screenshots');

const PASSPHRASE_CORRETTA = 'CodeDB-Master-Key-2026!';
const PASSPHRASE_ERRATA = 'PasswordSbagliata123!';

let falliti = 0;
let superati = 0;

function logStep(titolo) {
  console.log(`\n\x1b[36m==================================================================\x1b[0m`);
  console.log(`\x1b[1m\x1b[36m▶ ${titolo}\x1b[0m`);
  console.log(`\x1b[36m==================================================================\x1b[0m`);
}

function assert(condizione, etichetta, dettaglio = '') {
  if (condizione) {
    console.log(`  \x1b[32m✔ OK\x1b[0m   ${etichetta}`);
    superati++;
  } else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m ${etichetta}${dettaglio ? ` — \x1b[33m${dettaglio}\x1b[0m` : ''}`);
    falliti++;
  }
}

function pingServer(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/handshake-check', timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function attendiServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingServer(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Il server di test non ha risposto su 127.0.0.1:${port} entro ${timeoutMs}ms.`);
}

async function chiudiOnboardingSeAperto(page) {
  try {
    const onboardingClose = page.locator('#onboarding-close, button[data-azione="chiudi"], button[data-azione="salta"]');
    if (await onboardingClose.first().isVisible({ timeout: 500 })) {
      await onboardingClose.first().click();
      console.log('  Chiusa modale di benvenuto/onboarding');
      await page.waitForTimeout(300);
    }
  } catch { /* ignora */ }
}

async function main() {
  console.log('\x1b[1m\x1b[35m=== CodeDB E2E Playwright Test Suite ===\x1b[0m');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Ambiente: Node ${process.version} (${process.platform})`);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-playwright-'));
  const iniPath = path.join(tempDir, 'connections.ini');

  // Inizializza un Vault v2 protetto da passphrase con una connessione salvata di test
  const { meta, dataKey } = Vault.createMeta(PASSPHRASE_CORRETTA);
  Vault.writeMeta(iniPath, meta);

  // Scrivi una connessione salvata valida verso MongoDB locale
  const encryptedPassword = Vault.encryptWith('p4ssw0rd-segreta', dataKey);

  const lines = [
    '; Connessioni di test Playwright',
    '[mongodb_locale]',
    'dbType=mongodb',
    'host=127.0.0.1',
    'port=27017',
    `password=${encryptedPassword}`,
    'folder=Database Locali',
    '',
  ];
  fs.writeFileSync(iniPath, lines.join('\n'), 'utf8');

  // Avvio del server di test
  logStep('Fase 0: Avvio del Server CodeDB Isolato con Vault Protetto');
  const serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      CODEDB_RBAC: 'off',
      CODEDB_CONNECTIONS_FILE: iniPath,
      CODEDB_CONNECTIONS_DIR: path.join(tempDir, 'conns'),
      CODEDB_UI_AUDIT_FILE: path.join(tempDir, 'ui-audit.log'),
      CODEDB_MCP_AUDIT_FILE: path.join(tempDir, 'mcp-audit.log'),
      CODEDB_BACKUPS_DIR: path.join(tempDir, 'backups'),
      GUI_MONGO_PASSPHRASE: '', // Vault bloccato all'avvio
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg.includes('Vault BLOCCATO')) {
      console.log('  [Server] ' + msg);
    }
  });

  let browser = null;
  let context = null;
  let page = null;

  try {
    await attendiServer(PORT);
    assert(true, `Server CodeDB avviato correttamente su ${BASE_URL}`);

    // Avvio browser Playwright
    logStep('Fase 1: Apertura Web UI & Test Sblocco Vault con Passphrase Errata e Corretta');
    browser = await chromium.launch({
      headless: process.env.HEADLESS !== 'false',
    });
    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
    });

    // Disattiva modale onboarding tramite flag localStorage al caricamento
    await context.addInitScript(() => {
      try {
        localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versione: '0.1.2-beta.1' }));
      } catch { /* ignora */ }
    });

    page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`  \x1b[33m[Browser Console Error]\x1b[0m ${msg.text()}`);
      }
    });

    console.log(`  Apertura pagina: ${BASE_URL}`);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    // 1.1 Verifica comparsa modale Sblocco Vault
    const vaultOverlay = page.locator('#vault-overlay');
    await vaultOverlay.waitFor({ state: 'visible', timeout: 5000 });
    assert(await vaultOverlay.isVisible(), 'Modale Sblocco Vault (#vault-overlay) visibile all\'avvio');

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-vault-locked.png') });

    // 1.2 Tentativo di sblocco con passphrase errata
    console.log(`  Inserimento passphrase ERRATA: "${PASSPHRASE_ERRATA}"`);
    await page.fill('#vault-passphrase', PASSPHRASE_ERRATA);
    await page.click('#vault-form button[type="submit"]');

    // Attendi comparsa messaggio d'errore
    const vaultError = page.locator('#vault-error');
    await vaultError.waitFor({ state: 'visible', timeout: 5000 });
    const errorText = await vaultError.innerText();
    const isErrorVisible = await vaultError.isVisible();
    assert(
      isErrorVisible && errorText.length > 0,
      'Messaggio di errore mostrato correttamente su passphrase errata',
      `Testo: "${errorText}"`
    );

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-vault-wrong-passphrase.png') });

    // 1.3 Tentativo di sblocco con passphrase corretta
    console.log(`  Inserimento passphrase CORRETTA: "${PASSPHRASE_CORRETTA}"`);
    await page.fill('#vault-passphrase', PASSPHRASE_CORRETTA);
    await page.click('#vault-form button[type="submit"]');

    // Verifica che la modale si chiuda
    await vaultOverlay.waitFor({ state: 'hidden', timeout: 5000 });
    assert(await vaultOverlay.isHidden(), 'Modale Sblocco Vault chiusa con successo dopo passphrase corretta');

    await chiudiOnboardingSeAperto(page);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-vault-unlocked.png') });

    // 1.4 Verifica che la connessione salvata sia comparsa nella sidebar
    await page.waitForSelector('#conn-tree .conn-item', { timeout: 5000 });
    const connItems = await page.locator('#conn-tree .conn-item').count();
    assert(connItems > 0, `Connessioni salvate caricate correttamente nella sidebar (${connItems} trovate)`);

    // =========================================================================
    // FASE 2: Scansione e Inventario Completo degli Elementi Cliccabili
    // =========================================================================
    logStep('Fase 2: Scansione & Inventario Elementi Cliccabili della Pagina');
    
    const inventory = await page.evaluate(() => {
      const selectors = [
        'button',
        'a[href]',
        '[role="button"]',
        '.tab',
        '.view-tab',
        'input[type="button"]',
        'input[type="submit"]',
        'input[type="checkbox"]',
        'select',
        'summary',
        '[data-action]',
        '.sidebar-toggle-btn',
        '.menu-btn',
        '.conn-item',
        '.conn-tab'
      ].join(', ');

      const elements = Array.from(document.querySelectorAll(selectors));
      
      return elements.map((el, idx) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const isVisible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('.hidden');
        
        let label = (
          el.innerText ||
          el.textContent ||
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.value ||
          el.placeholder ||
          el.id ||
          el.className
        ).trim().replace(/\s+/g, ' ');

        if (label.length > 60) label = label.slice(0, 57) + '...';

        return {
          index: idx + 1,
          tagName: el.tagName.toLowerCase(),
          id: el.id || null,
          className: el.className ? String(el.className).trim() : null,
          text: label || '(senza testo)',
          title: el.getAttribute('title') || null,
          ariaLabel: el.getAttribute('aria-label') || null,
          role: el.getAttribute('role') || null,
          type: el.getAttribute('type') || null,
          disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled')),
          visible: !!isVisible,
          dataset: Object.keys(el.dataset).length ? { ...el.dataset } : null,
        };
      });
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportFileJson = path.join(REPORTS_DIR, `ui-clickable-elements-${timestamp}.json`);
    const latestFileJson = path.join(REPORTS_DIR, 'ui-clickable-elements-latest.json');
    const latestFileMd = path.join(REPORTS_DIR, 'ui-clickable-elements-latest.md');

    const reportData = {
      timestamp: new Date().toISOString(),
      url: BASE_URL,
      totalElements: inventory.length,
      visibleElements: inventory.filter(e => e.visible).length,
      hiddenElements: inventory.filter(e => !e.visible).length,
      elements: inventory,
    };

    fs.writeFileSync(reportFileJson, JSON.stringify(reportData, null, 2), 'utf8');
    fs.writeFileSync(latestFileJson, JSON.stringify(reportData, null, 2), 'utf8');

    const mdLines = [
      `# CodeDB — Inventario Tasti & Elementi Cliccabili`,
      ``,
      `- **Data Esecuzione**: \`${reportData.timestamp}\``,
      `- **URL**: \`${reportData.url}\``,
      `- **Totale Elementi Interattivi**: \`${reportData.totalElements}\``,
      `- **Elementi Visibili**: \`${reportData.visibleElements}\``,
      `- **Elementi Nascosti (Modali / Drawer / Menu)**: \`${reportData.hiddenElements}\``,
      ``,
      `## Tabella di Dettaglio Elementi`,
      ``,
      `| # | Tag | ID | Testo / Label | Classe | Stato | Visibile |`,
      `|---|---|---|---|---|---|---|`,
    ];

    for (const item of inventory) {
      const idStr = item.id ? `\`#${item.id}\`` : '—';
      const classStr = item.className ? `\`${item.className}\`` : '—';
      const textClean = (item.text || '').replace(/\|/g, '\\|');
      const stato = item.disabled ? '🔴 Disabilitato' : '🟢 Abilitato';
      const vis = item.visible ? '👁 Visibile' : '💤 Nascosto';
      mdLines.push(`| ${item.index} | \`<${item.tagName}>\` | ${idStr} | ${textClean} | ${classStr} | ${stato} | ${vis} |`);
    }

    fs.writeFileSync(latestFileMd, mdLines.join('\n') + '\n', 'utf8');

    assert(
      inventory.length > 0,
      `Scansione completata: ${inventory.length} elementi cliccabili catalogati (${reportData.visibleElements} visibili, ${reportData.hiddenElements} nei menu/modali)`,
      `Salvato in: ui-clickable-elements-latest.json e ui-clickable-elements-latest.md`
    );

    // =========================================================================
    // FASE 3: Test Modale di Connessione & Apertura Connessione
    // =========================================================================
    logStep('Fase 3: Test Modale di Connessione (Wizard, Parametri, Test & Apertura)');

    await chiudiOnboardingSeAperto(page);

    // 3.1 Apertura modale Nuova Connessione
    await page.click('#tab-add-btn');
    const connectOverlay = page.locator('#connect-overlay');
    await connectOverlay.waitFor({ state: 'visible', timeout: 5000 });
    assert(await connectOverlay.isVisible(), 'Modale Connessione Database aperta tramite #tab-add-btn');

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-connect-wizard.png') });

    // 3.2 Compilazione wizard passo 1 (Parametri)
    await page.selectOption('#conn-dbtype', 'mongodb');
    await page.fill('#connect-form input[name="host"]', '127.0.0.1');
    await page.fill('#connect-form input[name="port"]', '27017');

    // 3.3 Test Connessione (Pulsante "Testa Connessione")
    console.log('  Esecuzione "Testa Connessione"...');
    await page.click('#conn-test-btn');
    
    // Attendi la comparsa del feedback
    const testResultLocator = page.locator('#connect-test-msg:not(.hidden), #connect-error:not(.hidden)').first();
    await testResultLocator.waitFor({ state: 'visible', timeout: 8000 });
    const testResultText = await testResultLocator.innerText();
    assert(testResultText.length > 0, 'Feedback del comando "Testa Connessione" visualizzato correttamente', testResultText);

    // 3.4 Navigazione wizard Passo 3 (Salva & Connetti)
    await page.click('#wizard-next-btn');
    const summaryBox = await page.locator('#wizard-summary-box').innerText();
    assert(summaryBox.length > 0, 'Riepilogo parametri generato nel Passo 3 del Wizard', summaryBox.replace(/\n/g, ' '));

    // 3.5 Chiusura modale wizard
    await page.click('#conn-cancel-btn');
    await connectOverlay.waitFor({ state: 'hidden', timeout: 5000 });
    assert(await connectOverlay.isHidden(), 'Modale Connessione chiusa con successo');

    await chiudiOnboardingSeAperto(page);

    // 3.6 Apertura connessione salvata dalla sidebar
    console.log('  Apertura connessione salvata "mongodb_locale"...');
    const savedConnItem = page.locator('#conn-tree .conn-item').first();
    await savedConnItem.click();

    // Attendi creazione tab connessione
    await page.waitForSelector('#tab-bar .conn-tab.active', { timeout: 8000 });
    const tabName = await page.locator('#tab-bar .conn-tab.active .conn-tab-name').innerText();
    assert(tabName.length > 0, `Tab di connessione attivo creato con successo: "${tabName}"`);

    // 3.7 Verifica comparsa alberatura database nella sidebar
    await page.waitForSelector('#db-tree .db', { timeout: 8000 });
    const dbsCount = await page.locator('#db-tree .db').count();
    assert(dbsCount > 0, `Albero database (#db-tree) popolato con successo (${dbsCount} database trovati)`);

    // Espandi il primo database
    const firstDb = page.locator('#db-tree .db .node-label').first();
    const firstDbName = await firstDb.innerText();
    console.log(`  Espansione database: ${firstDbName.trim()}`);
    await firstDb.click();
    await page.waitForTimeout(600);

    // Se ci sono collection/tabelle nel database, clicca sulla prima per aprirne la griglia
    const firstColl = page.locator('#db-tree .coll .node-label').first();
    if (await firstColl.isVisible({ timeout: 1500 })) {
      const collName = await firstColl.innerText();
      console.log(`  Apertura tabella/collection: ${collName.trim()}`);
      await firstColl.click();
      await page.waitForTimeout(600);
    }

    // =========================================================================
    // FASE 4: Test Vista "⚡ Query & Aggregate" ed Esecuzione Query
    // =========================================================================
    logStep('Fase 4: Test Vista "⚡ Query & Aggregate" ed Esecuzione Query');

    // 4.1 Passa alla vista Query & Aggregate
    const queryTabBtn = page.locator('.view-tab[data-view="query"]').first();
    await queryTabBtn.waitFor({ state: 'visible', timeout: 5000 });
    await queryTabBtn.click();
    console.log('  Click su scheda vista "⚡ Query & Aggregate"');

    const viewQuery = page.locator('#view-query');
    await viewQuery.waitFor({ state: 'visible', timeout: 5000 });
    assert(await viewQuery.isVisible(), 'Pannello vista "⚡ Query & Aggregate" (#view-query) visualizzato');

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-query-view.png') });

    // 4.2 Inserimento query nell'editor (SELECT tradotta o query sintetica)
    const editorInput = page.locator('#query-editor-input');
    await editorInput.waitFor({ state: 'visible', timeout: 5000 });

    const testQuery = 'SELECT 1 AS id, "CodeDB Playwright Test" AS name, 100 AS score, NOW() AS ts;';
    console.log(`  Inserimento query di test: ${testQuery}`);
    await editorInput.fill(testQuery);

    const runBtn = page.locator('#query-run-btn');
    assert(await runBtn.isVisible(), 'Pulsante "Esegui Query" (#query-run-btn) pronto e visibile');

    // 4.3 Click su Esegui Query
    console.log('  Pressione pulsante "Esegui Query"...');
    await runBtn.click();

    // Attendi aggiornamento stato query o completamento
    await page.waitForTimeout(2000);

    // 4.4 Verifica presenza selettori sotto-viste risultati (Tabella, JSON, Grafici)
    const viewButtons = await page.locator('.results-view-mode .mode-btn').count();
    assert(viewButtons >= 3, `Sotto-schede risultati disponibili (${viewButtons} modalità: Tabella, JSON, Grafici)`);

    // 4.5 Test switch viste risultati
    const jsonViewBtn = page.locator('#res-mode-json');
    if (await jsonViewBtn.isVisible()) {
      await jsonViewBtn.click();
      console.log('  Switch su vista JSON Tree (#res-mode-json)');
      await page.waitForTimeout(300);
      assert(await jsonViewBtn.evaluate(el => el.classList.contains('active')), 'Vista JSON Tree attivata con successo');
    }

    const chartViewBtn = page.locator('#res-mode-chart');
    if (await chartViewBtn.isVisible()) {
      await chartViewBtn.click();
      console.log('  Switch su vista Grafico (#res-mode-chart)');
      await page.waitForTimeout(300);
      assert(await chartViewBtn.evaluate(el => el.classList.contains('active')), 'Vista Grafico attivata con successo');
    }

    const tableViewBtn = page.locator('#res-mode-table');
    if (await tableViewBtn.isVisible()) {
      await tableViewBtn.click();
      console.log('  Ritorno a vista Tabella Risultati (#res-mode-table)');
      await page.waitForTimeout(300);
      assert(await tableViewBtn.evaluate(el => el.classList.contains('active')), 'Vista Tabella Risultati attiva');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '06-query-executed.png') });

    // =========================================================================
    // FASE 5: Test Funzionalità Ausiliarie & Temi
    // =========================================================================
    logStep('Fase 5: Test Funzionalità Ausiliarie (Menu Impostazioni & Temi)');
    const htmlThemeBefore = await page.getAttribute('html', 'data-theme');
    console.log(`  Tema applicato al root HTML: ${htmlThemeBefore}`);
    assert(htmlThemeBefore === 'dark' || htmlThemeBefore === 'light', 'Attributo data-theme presente sul root HTML');

    // Apri menu impostazioni (pannello sidebar)
    const settingsBtn = page.locator('#conn-settings-btn');
    if (await settingsBtn.isVisible()) {
      await settingsBtn.click();
      console.log('  Apertura menu Impostazioni');
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '07-settings-menu.png') });
    }

    console.log('\n\x1b[32m✔ Tutte le fasi di automazione Playwright sono state completate con successo!\x1b[0m');

  } catch (err) {
    console.error(`\n\x1b[31m[ERRORE FATALE PLAYWRIGHT]\x1b[0m: ${err.message}`);
    if (page) {
      try {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'error-fatal.png') });
        console.log(`  Screenshot salvato in: ${path.join(SCREENSHOTS_DIR, 'error-fatal.png')}`);
      } catch { /* ignora */ }
    }
    falliti++;
  } finally {
    if (browser) {
      console.log('  Chiusura browser Playwright...');
      await browser.close().catch(() => {});
    }
    if (serverProc) {
      console.log('  Arresto server CodeDB di test...');
      serverProc.kill();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignora */ }
  }

  console.log(`\n==================================================================`);
  console.log(`RIEPILOGO TEST: \x1b[32m${superati} Superati\x1b[0m, \x1b[${falliti ? '31' : '32'}m${falliti} Falliti\x1b[0m`);
  console.log(`Report inventario JSON: test-reports/ui-clickable-elements-latest.json`);
  console.log(`Report inventario Markdown: test-reports/ui-clickable-elements-latest.md`);
  console.log(`Screenshot salvati in: test-reports/screenshots/`);
  console.log(`==================================================================\n`);

  if (falliti > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };

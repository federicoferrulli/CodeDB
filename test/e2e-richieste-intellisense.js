'use strict';

/*
 * E2E (Chromium): una DDL invalida anche le richieste IntelliSense in volo.
 *
 * Il socket finto trattiene gli acknowledgment di `db:schema`, cosi' il test
 * puo' consegnare la risposta precedente dopo quella partita in seguito
 * all'invalidazione. Nessun database richiesto.
 *
 * Uso: node test/e2e-richieste-intellisense.js
 */

const assert = require('assert');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  console.log('--- E2E: richieste IntelliSense invalidate ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3157 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });

    const esito = await page.evaluate(async () => {
      const { tabs, createTab } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const {
        schemaCorrente, invalidaSchemaIntellisense,
      } = await import('/js/autocomplete.js');

      const richieste = [];
      impostaSocket({
        emit: (evento, payload, acknowledgment) => {
          if (evento === 'db:schema') richieste.push({ payload, acknowledgment });
        },
        on: () => {},
        off: () => {},
      });

      const tab = createTab({ connName: null });
      tabs.activeId = tab.id;
      tab.state.db = 'magazzino_intellisense';

      schemaCorrente();
      invalidaSchemaIntellisense(tab.state.db);
      schemaCorrente();

      if (richieste.length !== 2) {
        throw new Error(`Attese due richieste db:schema, ricevute ${richieste.length}`);
      }

      richieste[1].acknowledgment({
        ok: true,
        collections: [{ name: 'tabella_nuova', fields: [{ name: 'campo_nuovo' }] }],
      });
      await Promise.resolve();
      await Promise.resolve();
      const dopoNuova = schemaCorrente();

      richieste[0].acknowledgment({
        ok: true,
        collections: [{ name: 'tabella_obsoleta', fields: [{ name: 'campo_obsoleto' }] }],
      });
      await Promise.resolve();
      await Promise.resolve();
      const dopoVecchia = schemaCorrente();

      impostaSocket(null);
      return {
        richieste: richieste.map((r) => r.payload),
        dopoNuova,
        dopoVecchia,
      };
    });

    assert.strictEqual(esito.richieste.length, 2,
      'la prima lettura e quella successiva alla DDL devono interrogare entrambe db:schema');
    assert.deepStrictEqual(esito.dopoNuova.tabelle.map((t) => t.nome), ['tabella_nuova']);
    assert.deepStrictEqual(esito.dopoVecchia.tabelle.map((t) => t.nome), ['tabella_nuova'],
      'l\'acknowledgment della generazione precedente non deve ripristinare lo schema obsoleto');
  } finally {
    await browser.close();
    await server.stop();
  }

  console.log('  OK   la risposta tardiva non supera l\'invalidazione');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): selezione delle FK nel form «Nuova riga»
 * (docs/piano-inserimento-foreign-key.md). Nessun database reale: il socket
 * finto risponde a collection:stats, collection:relations, collection:find e
 * doc:insert, e registra i payload. In questo modo il test distingue il difetto
 * preciso (bozza toccata, bersaglio sbagliato, valore arrotondato) da un
 * semplice errore di disegno.
 *
 * Uso: node test/e2e-fk-inserimento.js
 * ------------------------------------------------------------------------- */

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

const ATTESA = 8000;
async function attesaFn(page, fn, ...args) {
  await page.waitForFunction(fn, null, { timeout: ATTESA }, ...args);
}

(async () => {
  console.log('--- E2E: chiavi esterne nel form di inserimento ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3149 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#insert-overlay', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(800);

    /* --- 1. FK semplice: scelta compila il campo, nessuna scrittura ------- */

    await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'tab-ins-a', connName: null });
      tab.dbType = 'mysql';
      tab.state.connected = true;
      tabs.activeId = tab.id;
      window.__tabInsA = tab.id;
      const richieste = [];
      window.__richieste = richieste;
      const scritture = [];
      window.__scritture = scritture;
      impostaSocket({
        emit: (evento, msg, cb) => {
          richieste.push({ evento, msg: structuredClone(msg) });
          if (!cb) return;
          if (evento === 'collection:stats') {
            cb({ ok: true, fields: [
              { name: 'id', types: ['int'], nullable: false, default: null, autoIncrement: true },
              { name: 'cliente_id', types: ['int'], nullable: false, default: null },
              { name: 'nota', types: ['varchar'], nullable: true, default: null },
            ] });
            return;
          }
          if (evento === 'collection:relations') {
            cb({ ok: true, relazioni: [
              { nome: 'fk_ord_cli', campo: 'cliente_id', db: 'anagrafiche', tabella: 'clienti', colonna: 'id', origine: 'vincolo' },
            ] });
            return;
          }
          if (evento === 'collection:find') {
            const righe = [{ id: 10, nome: 'Ada' }, { id: 11, nome: 'Bruna' }];
            const filtrata = msg.filtro && msg.filtro.condizioni
              ? righe.filter((r) => r[msg.filtro.condizioni[0].campo] === msg.filtro.condizioni[0].valore)
              : righe;
            cb({ ok: true, docs: filtrata, columns: ['id', 'nome'], total: filtrata.length });
            return;
          }
          if (evento === 'doc:insert') { scritture.push(structuredClone(msg)); cb({ ok: true }); return; }
          cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });
      const { openInsertDocForContext } = await import('/js/insert.js');
      openInsertDocForContext({ tabId: tab.id, db: 'vendite', coll: 'ordini', dbType: 'mysql', isStillActive: () => false });
    });
    // Righe pronte + pulsante di collegamento accanto al campo.
    await attesaFn(page, () => document.querySelectorAll('#insert-form tbody tr').length === 3);
    await attesaFn(page, () => !!document.querySelector('#insert-form .fk-apri-btn'));
    const semplice = await page.evaluate(async () => {
      const btn = document.querySelector('#insert-form .fk-apri-btn');
      const aria = btn ? btn.getAttribute('aria-label') : '';
      const titolo = btn ? btn.title : '';
      const righe = [...document.querySelectorAll('#insert-form tbody tr')].map((tr) => tr.querySelector('td').textContent);
      // Il focus apre il pannello da solo su desktop, senza rubarlo.
      const { buildInsertDoc } = await import('/js/insert.js');
      const input = [...document.querySelectorAll('#insert-form tbody tr')]
        .find((tr) => tr.querySelector('td').textContent.includes('cliente_id'))
        .querySelector('td.insert-value input');
      const fuocoPrima = document.activeElement;
      // Il campo potrebbe essere già focalizzato dall'apertura: si esce e si
      // rientra per provare davvero l'apertura all'ingresso.
      const altra = [...document.querySelectorAll('#insert-form tbody tr')]
        .find((tr) => tr.querySelector('td').textContent.includes('nota'))
        .querySelector('td.insert-value input');
      altra.focus();
      await new Promise((r) => setTimeout(r, 60));
      const { chiudiPannelloFk } = await import('/js/fk-vista.js');
      chiudiPannelloFk();
      await new Promise((r) => setTimeout(r, 60));
      input.focus();
      await new Promise((r) => setTimeout(r, 150));
      const pannelloAperto = !document.querySelector('#fk-pannello').classList.contains('hidden');
      const titoloP = document.querySelector('#fk-title').textContent;
      const fuocoDopo = document.activeElement;
      const voci = [...document.querySelectorAll('#fk-elenco .fk-voce')];
      const voce11 = voci.find((el) => el.textContent.includes('11'));
      if (voce11) voce11.click();
      const usaAbilitato = !document.querySelector('#fk-usa').disabled;
      document.querySelector('#fk-usa').click();
      await new Promise((r) => setTimeout(r, 60));
      const compilato = input.value;
      let doc = null;
      let docErr = '';
      try { doc = buildInsertDoc(); } catch (e) { docErr = e.message; }
      // Rientro col valore scelto: la riga riferita si legge davvero.
      altra.focus();
      await new Promise((r) => setTimeout(r, 60));
      input.focus();
      await new Promise((r) => setTimeout(r, 150));
      const { chiudiPannelloFk: chiudi } = await import('/js/fk-vista.js');
      chiudi();
      return {
        aria, titolo, righe, pannelloAperto, titoloP, usaAbilitato, compilato,
        doc, docErr,
        fuocoRestato: fuocoDopo === input || fuocoPrima !== document.activeElement,
        scritture: window.__scritture.length,
        rigaRif: window.__richieste.find((r) => r.evento === 'collection:find'
          && r.msg.limit === 1 && r.msg.filtro?.condizioni?.[0]?.valore === 11)?.msg || null,
        tutteFind: window.__richieste.filter((r) => r.evento === 'collection:find').map((r) => r.msg),
        elenco: window.__richieste.find((r) => r.evento === 'collection:find' && r.msg.limit !== 1)?.msg || null,
      };
    });
    ok(/clienti/.test(semplice.aria) && /clienti/.test(semplice.titolo),
      'il pulsante indica destinazione e nome accessibile', JSON.stringify({ aria: semplice.aria, titolo: semplice.titolo }));
    ok(semplice.pannelloAperto, 'il pannello si apre entrando nel campo su desktop');
    ok(semplice.titoloP === 'anagrafiche.clienti.id',
      'il bersaglio qualifica lo schema di destinazione', JSON.stringify(semplice.titoloP));
    ok(semplice.rigaRif && semplice.rigaRif.tabId === 'tab-ins-a'
      && semplice.rigaRif.db === 'anagrafiche' && semplice.rigaRif.coll === 'clienti',
      'riga riferita ed elenco usano tabId e database del vincolo',
      JSON.stringify({ rigaRif: semplice.rigaRif, tutteFind: semplice.tutteFind }));
    ok(semplice.usaAbilitato && semplice.compilato === '11',
      '«Usa questo valore» compila il campo', JSON.stringify({ usa: semplice.usaAbilitato, valore: semplice.compilato }));
    ok(semplice.doc && semplice.doc.cliente_id === 11,
      'la bozza contiene la FK scelta', JSON.stringify(semplice.doc));
    ok(semplice.scritture === 0, 'nessuna scrittura prima di «Inserisci»');

    /* --- 2. Salvataggio: una sola scrittura nel bersaglio congelato -------- */

    // Si cambia tab mentre la modale è aperta: il documento deve finire comunque
    // nella tabella con cui è nato il form.
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const altro = createTab({ id: 'tab-ins-altro', connName: null });
      altro.dbType = 'mysql';
      altro.state.connected = true;
      altro.state.db = 'altrove';
      altro.state.coll = 'altra';
      tabs.activeId = altro.id;
      document.querySelector('#insert-save').click();
      await new Promise((r) => setTimeout(r, 60));
      return { click: true };
    });
    // La chiusura del pannello è una dissolvenza: si attende lo stato, non un tempo.
    await attesaFn(page, () => window.__scritture.length === 1
      && document.querySelector('#insert-overlay').classList.contains('hidden')
      && document.querySelector('#fk-pannello').classList.contains('hidden'));
    const salva = await page.evaluate(() => ({
      scritture: structuredClone(window.__scritture),
      modaleChiusa: document.querySelector('#insert-overlay').classList.contains('hidden'),
      pannelloChiuso: document.querySelector('#fk-pannello').classList.contains('hidden'),
    }));
    ok(salva.scritture.length === 1, '«Inserisci» scrive una sola volta', JSON.stringify(salva.scritture.length));
    ok(salva.scritture[0] && salva.scritture[0].tabId === 'tab-ins-a'
      && salva.scritture[0].db === 'vendite' && salva.scritture[0].coll === 'ordini',
      'la scrittura usa il contesto congelato, non il tab attivo', JSON.stringify(salva.scritture[0]));
    ok(JSON.parse(salva.scritture[0].doc).cliente_id === 11,
      'il payload contiene la FK scelta', salva.scritture[0].doc);
    ok(salva.modaleChiusa && salva.pannelloChiuso,
      'il salvataggio chiude form e pannello di sua proprietà');

    /* --- 3. FK composta: tutte le colonne dalla stessa riga --------------- */

    await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      const { tabs } = await import('/js/tabs.js');
      const tab = tabs.list.find((t) => t.id === 'tab-ins-a');
      tabs.activeId = tab.id;
      const richieste = [];
      window.__richieste = richieste;
      window.__scritture = [];
      impostaSocket({
        emit: (evento, msg, cb) => {
          richieste.push({ evento, msg: structuredClone(msg) });
          if (!cb) return;
          if (evento === 'collection:stats') {
            cb({ ok: true, fields: [
              { name: 'tenant_id', types: ['varchar'], nullable: false, default: null },
              { name: 'codice2', types: ['varchar'], nullable: false, default: null },
            ] });
            return;
          }
          if (evento === 'collection:relations') {
            cb({ ok: true, relazioni: [{
              nome: 'fk_comp', db: 'crm', tabella: 'clienti_comp', origine: 'vincolo',
              coppie: [{ campo: 'tenant_id', colonna: 'tenant', ordine: 1 }, { campo: 'codice2', colonna: 'codice', ordine: 2 }],
            }] });
            return;
          }
          if (evento === 'collection:find') {
            cb({ ok: true, docs: [{ tenant: 'T', codice: 'A' }, { tenant: 'T', codice: 'B' }], columns: ['tenant', 'codice'], total: 2 });
            return;
          }
          if (evento === 'doc:insert') { window.__scritture.push(structuredClone(msg)); cb({ ok: true }); return; }
          cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });
      const { openInsertDocForContext } = await import('/js/insert.js');
      openInsertDocForContext({ tabId: tab.id, db: 'vendite', coll: 'ordini_comp', dbType: 'mysql', isStillActive: () => false });
    });
    await attesaFn(page, () => document.querySelectorAll('#insert-form tbody tr').length === 2);
    await attesaFn(page, () => document.querySelectorAll('#insert-form .fk-apri-btn').length === 2);
    const composta = await page.evaluate(async () => {
      const { buildInsertDoc } = await import('/js/insert.js');
      const perNome = (nome) => [...document.querySelectorAll('#insert-form tbody tr')]
        .find((tr) => tr.querySelector('td').textContent.includes(nome))
        .querySelector('td.insert-value input');
      // Apertura dal SECONDO componente: compila comunque entrambe le colonne.
      perNome('codice2').focus();
      await new Promise((r) => setTimeout(r, 120));
      const voci = [...document.querySelectorAll('#fk-elenco .fk-voce')];
      const testi = voci.map((v) => v.textContent);
      voci[1].click();
      document.querySelector('#fk-usa').click();
      await new Promise((r) => setTimeout(r, 60));
      let doc = null;
      let docErrore = '';
      try { doc = buildInsertDoc(); } catch (e) { docErrore = e.message; }
      return {
        testi,
        tenant: perNome('tenant_id').value,
        codice: perNome('codice2').value,
        doc, docErrore,
      };
    });
    ok(composta.testi[0] === '(T, A)' && composta.testi[1] === '(T, B)',
      'il selettore mostra tutte le componenti ordinate', JSON.stringify(composta.testi));
    ok(composta.tenant === 'T' && composta.codice === 'B',
      'aperta da un componente, compila tutte le colonne dalla stessa riga', JSON.stringify(composta));
    ok(composta.doc && composta.doc.tenant_id === 'T' && composta.doc.codice2 === 'B',
      'la bozza composta è completa', JSON.stringify({ doc: composta.doc, errore: composta.docErrore }));

    // Riga riferita incompleta: nessuna modifica parziale.
    const parziale = await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      impostaSocket({
        emit: (evento, msg, cb) => {
          if (!cb) return;
          if (evento === 'collection:stats') {
            cb({ ok: true, fields: [
              { name: 'tenant_id', types: ['varchar'], nullable: false, default: null },
              { name: 'codice2', types: ['varchar'], nullable: false, default: null },
            ] });
            return;
          }
          if (evento === 'collection:relations') {
            cb({ ok: true, relazioni: [{
              nome: 'fk_comp', db: 'crm', tabella: 'clienti_comp', origine: 'vincolo',
              coppie: [{ campo: 'tenant_id', colonna: 'tenant', ordine: 1 }, { campo: 'codice2', colonna: 'codice', ordine: 2 }],
            }] });
            return;
          }
          if (evento === 'collection:find') {
            // Manca la seconda componente: setDaRelazione deve rifiutare tutto.
            cb({ ok: true, docs: [{ tenant: 'T' }], columns: ['tenant'], total: 1 });
            return;
          }
          cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });
      const { openInsertDocForContext, buildInsertDoc } = await import('/js/insert.js');
      const { tabs } = await import('/js/tabs.js');
      const tab = tabs.list.find((t) => t.id === 'tab-ins-a');
      openInsertDocForContext({ tabId: tab.id, db: 'vendite', coll: 'ordini_comp', dbType: 'mysql', isStillActive: () => false });
      await new Promise((r) => setTimeout(r, 200));
      const perNome = (nome) => [...document.querySelectorAll('#insert-form tbody tr')]
        .find((tr) => tr.querySelector('td').textContent.includes(nome))
        .querySelector('td.insert-value input');
      perNome('tenant_id').value = 'X';
      perNome('tenant_id').dispatchEvent(new Event('input', { bubbles: true }));
      perNome('tenant_id').focus();
      await new Promise((r) => setTimeout(r, 150));
      const voce = document.querySelector('#fk-elenco .fk-voce');
      if (voce) voce.click();
      document.querySelector('#fk-usa').click();
      await new Promise((r) => setTimeout(r, 60));
      // «X» digitato a mano deve restare: dati incompleti non toccano il form.
      return { tenant: perNome('tenant_id').value, codice: perNome('codice2').value };
    });
    ok(parziale.tenant === 'X' && parziale.codice === '',
      'dati riferiti incompleti non modificano parzialmente il form', JSON.stringify(parziale));

    /* --- 4. Valori esatti: BIGINT, zeri iniziali, null --------------------- */

    const esatti = await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      impostaSocket({
        emit: (evento, msg, cb) => {
          if (!cb) return;
          if (evento === 'collection:stats') {
            cb({ ok: true, fields: [
              { name: 'big_id', types: ['bigint'], nullable: false, default: null },
              { name: 'codice_txt', types: ['varchar'], nullable: true, default: null },
              { name: 'annullabile', types: ['varchar'], nullable: true, default: null },
            ] });
            return;
          }
          if (evento === 'collection:relations') {
            cb({ ok: true, relazioni: [
              { nome: 'fk_big', campo: 'big_id', db: 'shop', tabella: 'grandi', colonna: 'id', origine: 'vincolo' },
              { nome: 'fk_txt', campo: 'codice_txt', db: 'shop', tabella: 'codici', colonna: 'code', origine: 'vincolo' },
              { nome: 'fk_null', campo: 'annullabile', db: 'shop', tabella: 'codici', colonna: 'code', origine: 'vincolo' },
            ] });
            return;
          }
          if (evento === 'collection:find') {
            if (msg.coll === 'grandi') {
              cb({ ok: true, docs: [{ id: { $numberLong: '9007199254740993' } }], columns: ['id'], total: 1 });
            } else {
              cb({
                ok: true,
                docs: [{ code: '00123' }, { code: '  AB  ' }, { code: null }, { code: '' }],
                columns: ['code'], total: 4,
              });
            }
            return;
          }
          cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });
      const { openInsertDocForContext, buildInsertDoc } = await import('/js/insert.js');
      const { tabs } = await import('/js/tabs.js');
      const tab = tabs.list.find((t) => t.id === 'tab-ins-a');
      openInsertDocForContext({ tabId: tab.id, db: 'shop', coll: 'ordini', dbType: 'mysql', isStillActive: () => false });
      await new Promise((r) => setTimeout(r, 200));
      const perNome = (nome) => [...document.querySelectorAll('#insert-form tbody tr')]
        .find((tr) => tr.firstChild.textContent.includes(nome))
        .querySelector('td.insert-value input');
      // BIGINT oltre 2^53
      perNome('big_id').focus();
      await new Promise((r) => setTimeout(r, 150));
      document.querySelector('#fk-elenco .fk-voce').click();
      document.querySelector('#fk-usa').click();
      await new Promise((r) => setTimeout(r, 60));
      const bigTesto = perNome('big_id').value;
      // Chiave testuale con zeri iniziali
      perNome('codice_txt').focus();
      await new Promise((r) => setTimeout(r, 150));
      [...document.querySelectorAll('#fk-elenco .fk-voce')].find((v) => v.textContent.includes('00123')).click();
      document.querySelector('#fk-usa').click();
      await new Promise((r) => setTimeout(r, 60));
      // null esplicito (distinto da campo omesso)
      perNome('annullabile').focus();
      await new Promise((r) => setTimeout(r, 150));
      [...document.querySelectorAll('#fk-elenco .fk-voce')].find((v) => v.textContent.includes('null')).click();
      document.querySelector('#fk-usa').click();
      await new Promise((r) => setTimeout(r, 60));
      const doc = buildInsertDoc();
      // Modifica manuale dopo la scelta: vince ciò che si è digitato.
      perNome('codice_txt').value = '999';
      perNome('codice_txt').dispatchEvent(new Event('input', { bubbles: true }));
      const docDopo = buildInsertDoc();
      const jsonTab = (() => {
        document.querySelector('[data-instab="json"]').click();
        return document.querySelector('#insert-json').value;
      })();
      return {
        bigTesto,
        big: doc.big_id,
        txt: doc.codice_txt,
        nullo: 'annullabile' in doc ? doc.annullabile : '<omesso>',
        dopoModifica: docDopo.codice_txt,
        jsonTab,
      };
    });
    ok(esatti.bigTesto === '9007199254740993'
      && esatti.big && esatti.big.$numberLong === '9007199254740993',
      'BIGINT oltre 2^53 senza arrotondamenti', JSON.stringify({ testo: esatti.bigTesto, valore: esatti.big }));
    ok(esatti.txt === '00123', 'chiave testuale senza perdita di zeri', JSON.stringify(esatti.txt));
    ok(esatti.nullo === null, 'null scelto distinto dal campo omesso', JSON.stringify(esatti.nullo));
    ok(esatti.dopoModifica === '999', 'la modifica manuale dopo la scelta vince', JSON.stringify(esatti.dopoModifica));
    ok(/9007199254740993/.test(esatti.jsonTab) && /"codice_txt": "999"/.test(esatti.jsonTab),
      'la scheda JSON include le FK compilate', esatti.jsonTab.slice(0, 200));

    /* --- 5. Riapertura e risposte lente: nessuna contaminazione ------------ */

    const stale = await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      let sblocca = null;
      const attesa = new Promise((r) => { sblocca = r; });
      impostaSocket({
        emit: (evento, msg, cb) => {
          if (!cb) return;
          if (evento === 'collection:stats') {
            if (msg.coll === 'lenta') {
              attesa.then(() => cb({ ok: true, fields: [{ name: 'vecchio', types: ['varchar'], nullable: true, default: null }] }));
            } else {
              cb({ ok: true, fields: [{ name: 'nuovo', types: ['varchar'], nullable: true, default: null }] });
            }
            return;
          }
          if (evento === 'collection:relations') { cb({ ok: true, relazioni: [] }); return; }
          cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });
      const { openInsertDocForContext } = await import('/js/insert.js');
      const { tabs } = await import('/js/tabs.js');
      const tab = tabs.list.find((t) => t.id === 'tab-ins-a');
      openInsertDocForContext({ tabId: tab.id, db: 'shop', coll: 'lenta', dbType: 'mysql', isStillActive: () => false });
      await new Promise((r) => setTimeout(r, 60));
      // Riapertura prima che la prima risposta arrivi.
      openInsertDocForContext({ tabId: tab.id, db: 'shop', coll: 'veloce', dbType: 'mysql', isStillActive: () => false });
      await new Promise((r) => setTimeout(r, 120));
      sblocca();
      await new Promise((r) => setTimeout(r, 120));
      const nomi = [...document.querySelectorAll('#insert-form tbody tr')].map((tr) => tr.firstChild.textContent.trim());
      return { nomi };
    });
    ok(stale.nomi.length === 1 && stale.nomi[0] === 'nuovo',
      'una risposta tardiva non aggiorna il form riaperto', JSON.stringify(stale.nomi));

    /* --- 6. Errore di lettura: messaggio, riprova, inserimento a mano ------ */

    const errore = await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      let tentativi = 0;
      impostaSocket({
        emit: (evento, msg, cb) => {
          if (!cb) return;
          if (evento === 'collection:stats') {
            cb({ ok: true, fields: [{ name: 'cliente_id', types: ['int'], nullable: true, default: null }] });
            return;
          }
          if (evento === 'collection:relations') {
            tentativi += 1;
            if (tentativi === 1) { cb({ ok: false, error: 'permesso negato' }); return; }
            cb({ ok: true, relazioni: [
              { nome: 'fk', campo: 'cliente_id', db: 'shop', tabella: 'clienti', colonna: 'id', origine: 'vincolo' },
            ] });
            return;
          }
          cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });
      const { openInsertDocForContext, buildInsertDoc } = await import('/js/insert.js');
      const { tabs } = await import('/js/tabs.js');
      const tab = tabs.list.find((t) => t.id === 'tab-ins-a');
      // Collection dedicata: la cache delle relazioni è per (tab, db, coll) e i
      // blocchi precedenti hanno già memorizzato il successo per 'ordini'.
      openInsertDocForContext({ tabId: tab.id, db: 'shop', coll: 'ordini_err', dbType: 'mysql', isStillActive: () => false });
      await new Promise((r) => setTimeout(r, 250));
      const bannerVisibile = !document.querySelector('#insert-fk-error').classList.contains('hidden');
      const senzaPulsanti = document.querySelectorAll('#insert-form .fk-apri-btn').length === 0;
      // Inserimento manuale resta possibile.
      const input = document.querySelector('#insert-form tbody tr td.insert-value input');
      input.value = '5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      let manuale = null;
      try { manuale = buildInsertDoc(); } catch (e) { manuale = { errore: e.message }; }
      // Riprova: ora il server risponde.
      document.querySelector('#insert-fk-error button').click();
      await new Promise((r) => setTimeout(r, 250));
      return {
        bannerVisibile, senzaPulsanti, manuale,
        dopoRiprova: document.querySelectorAll('#insert-form .fk-apri-btn').length,
        bannerNascosto: document.querySelector('#insert-fk-error').classList.contains('hidden'),
      };
    });
    ok(errore.bannerVisibile && errore.senzaPulsanti,
      'errore di lettura: messaggio leggibile senza selezioni false', JSON.stringify(errore));
    ok(errore.manuale && errore.manuale.cliente_id === 5,
      'con le relazioni in errore l’inserimento manuale resta utilizzabile', JSON.stringify(errore.manuale));
    ok(errore.dopoRiprova === 1 && errore.bannerNascosto,
      '«Riprova» collega i pulsanti', JSON.stringify(errore));

    /* --- 7. Tastiera: Escape chiude prima il pannello, poi la modale ------- */

    await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      impostaSocket({
        emit: (evento, msg, cb) => {
          if (!cb) return;
          if (evento === 'collection:stats') {
            cb({ ok: true, fields: [{ name: 'cliente_id', types: ['int'], nullable: true, default: null }] });
            return;
          }
          if (evento === 'collection:relations') {
            cb({ ok: true, relazioni: [
              { nome: 'fk', campo: 'cliente_id', db: 'shop', tabella: 'clienti', colonna: 'id', origine: 'vincolo' },
            ] });
            return;
          }
          if (evento === 'collection:find') {
            cb({ ok: true, docs: [{ id: 1 }], columns: ['id'], total: 1 });
            return;
          }
          cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });
      const { openInsertDocForContext } = await import('/js/insert.js');
      const { tabs } = await import('/js/tabs.js');
      const tab = tabs.list.find((t) => t.id === 'tab-ins-a');
      // Collection dedicata (vedi blocco errore: la cache è per coll).
      openInsertDocForContext({ tabId: tab.id, db: 'shop', coll: 'ordini_esc', dbType: 'mysql', isStillActive: () => false });
      await new Promise((r) => setTimeout(r, 250));
    });
    await attesaFn(page, () => !!document.querySelector('#insert-form .fk-apri-btn'));
    await page.evaluate(() => {
      document.querySelector('#insert-form td.insert-value input').focus();
    });
    await attesaFn(page, () => !document.querySelector('#fk-pannello').classList.contains('hidden'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const esc1 = await page.evaluate(() => ({
      pannello: document.querySelector('#fk-pannello').classList.contains('hidden'),
      modale: document.querySelector('#insert-overlay').classList.contains('hidden'),
    }));
    ok(esc1.pannello && !esc1.modale, 'Escape col pannello aperto chiude prima il pannello');
    // Annulla chiude anche un eventuale pannello orfano. Il campo ha già il
    // fuoco dopo Escape: si esce e si rientra per riaprire davvero.
    await page.evaluate(() => {
      document.querySelector('#insert-cancel').focus();
    });
    await page.evaluate(() => {
      document.querySelector('#insert-form td.insert-value input').focus();
    });
    await attesaFn(page, () => !document.querySelector('#fk-pannello').classList.contains('hidden'));
    await page.evaluate(() => document.querySelector('#insert-cancel').click());
    // La chiusura del pannello è una dissolvenza: si attende lo stato, non un tempo.
    await attesaFn(page, () => document.querySelector('#insert-overlay').classList.contains('hidden')
      && document.querySelector('#fk-pannello').classList.contains('hidden'));
    const esc2 = await page.evaluate(() => ({
      pannello: document.querySelector('#fk-pannello').classList.contains('hidden'),
      modale: document.querySelector('#insert-overlay').classList.contains('hidden'),
    }));
    ok(esc2.pannello && esc2.modale, 'la chiusura del form chiude anche il pannello di sua proprietà',
      JSON.stringify(esc2));

    /* --- 8. Mobile: niente apertura automatica, solo dal pulsante -------- */

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    mobile.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await mobile.goto(server.url, { waitUntil: 'domcontentloaded' });
    await mobile.waitForSelector('#insert-overlay', { state: 'attached', timeout: 15000 });
    await mobile.waitForTimeout(800);
    await mobile.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      impostaSocket({
        emit: (evento, msg, cb) => {
          if (!cb) return;
          if (evento === 'collection:stats') {
            cb({ ok: true, fields: [{ name: 'cliente_id', types: ['int'], nullable: true, default: null }] });
            return;
          }
          if (evento === 'collection:relations') {
            cb({ ok: true, relazioni: [
              { nome: 'fk', campo: 'cliente_id', db: 'shop', tabella: 'clienti', colonna: 'id', origine: 'vincolo' },
            ] });
            return;
          }
          if (evento === 'collection:find') {
            cb({ ok: true, docs: [{ id: 3, nome: 'Tre' }], columns: ['id', 'nome'], total: 1 });
            return;
          }
          cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'tab-ins-mob', connName: null });
      tab.dbType = 'mysql';
      tab.state.connected = true;
      tabs.activeId = tab.id;
      const { openInsertDocForContext } = await import('/js/insert.js');
      openInsertDocForContext({ tabId: tab.id, db: 'shop', coll: 'ordini_mob', dbType: 'mysql', isStillActive: () => false });
      await new Promise((r) => setTimeout(r, 300));
    });
    await mobile.waitForFunction(
      () => !!document.querySelector('#insert-form .fk-apri-btn'), null, { timeout: ATTESA });
    await mobile.evaluate(() => document.querySelector('#insert-form td.insert-value input').focus());
    await mobile.waitForTimeout(300);
    const mobAuto = await mobile.evaluate(() => !document.querySelector('#fk-pannello').classList.contains('hidden'));
    await mobile.evaluate(() => document.querySelector('#insert-form .fk-apri-btn').click());
    await mobile.waitForFunction(
      () => !document.querySelector('#fk-pannello').classList.contains('hidden'), null, { timeout: ATTESA });
    const mobBtn = await mobile.evaluate(async () => {
      const { buildInsertDoc } = await import('/js/insert.js');
      document.querySelector('#fk-elenco .fk-voce').click();
      document.querySelector('#fk-usa').click();
      await new Promise((r) => setTimeout(r, 80));
      return { valore: document.querySelector('#insert-form td.insert-value input').value, doc: buildInsertDoc() };
    });
    ok(!mobAuto, 'su mobile il focus non apre il pannello da solo');
    ok(mobBtn.valore === '3' && mobBtn.doc.cliente_id === 3,
      'su mobile il pulsante apre il pannello e la scelta compila', JSON.stringify(mobBtn));
    await mobile.close();

    /* --- 9. Regressione: l’edit inline continua a salvare ----------------- */

    const regressione = await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      const scritture = [];
      impostaSocket({
        emit: (evento, msg, cb) => {
          if (evento === 'doc:update') { scritture.push(structuredClone(msg)); cb({ ok: true }); return; }
          if (evento === 'collection:find') {
            cb({ ok: true, docs: [{ id: 7, nome: 'Sette' }], columns: ['id', 'nome'], total: 1 });
            return;
          }
          cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });
      const { startEdit } = await import('/js/inlineEdit.js');
      const td = document.createElement('td');
      document.body.append(td);
      const relazione = {
        campo: 'cliente_id', db: 'shop', tabella: 'clienti', colonna: 'id',
        origine: 'vincolo', molti: false,
      };
      startEdit(td, { _id: 1, cliente_id: 1 }, 'cliente_id', {
        relazione,
        ctx: { tabId: 'tab-ins-a', db: 'shop', coll: 'ordini', isStillActive: () => false, onSaveSuccess: () => {} },
        sorgente: td, contenitore: td, onRender: () => {},
      });
      await new Promise((r) => setTimeout(r, 150));
      const voce = [...document.querySelectorAll('#fk-elenco .fk-voce')]
        .find((v) => v.textContent.includes('7'));
      if (voce) voce.click();
      document.querySelector('#fk-usa').click();
      await new Promise((r) => setTimeout(r, 120));
      td.remove();
      const { impostaSocket: reset } = await import('/js/socket.js');
      reset(null);
      return { scritture };
    });
    ok(regressione.scritture.length === 1 && regressione.scritture[0].set.cliente_id === 7,
      'la scelta nell’editing continua a salvare', JSON.stringify(regressione.scritture));

    ok(errori.length === 0, 'nessun errore JavaScript durante le prove', errori.join('\n         '));
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- FK in inserimento: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- FK in inserimento: tutti i test superati ---');
})();

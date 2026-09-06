'use strict';

// Browser reale, trasporto simulato: nessun database o configurazione utente.
const assert = require('assert');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3167 });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(server.url, { waitUntil: 'networkidle' });
    const result = await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      const { createTab, tabs } = await import('/js/tabs.js');
      const { emit } = await import('/js/trasporto.js');
      const { openEditDoc, startEdit } = await import('/js/inlineEdit.js');
      const { openInsertDocForContext, buildInsertDoc } = await import('/js/insert.js');
      const { idOf } = await import('/js/righe.js');
      const tab = createTab({ connName: null });
      tabs.activeId = tab.id;
      Object.assign(tab.state, { dbType: 'mysql', db: 'prova', coll: 'righe', connected: true });
      const calls = [];
      const risposta = {
        ok: true, docs: [{ pk: 7, _id: 'dato reale', totale: 42 }], rowIds: [{ pk: 7 }],
        columnMeta: { pk: { type: 'int' }, _id: { type: 'text' }, totale: { type: 'int', generated: true } },
      };
      impostaSocket({ on() {}, off() {}, emit(event, payload, ack) {
        calls.push({ event, payload });
        const res = event === 'collection:find' ? structuredClone(risposta)
          : event === 'collection:stats' ? { ok: true, fields: [
            { name: 'nome', types: ['text'], nullable: false },
            { name: 'totale', types: ['int'], nullable: false, generated: true },
          ] } : { ok: true, matched: 1, modified: 1 };
        queueMicrotask(() => ack?.(res));
      } });
      const res = await emit('collection:find', {});
      const doc = res.docs[0];
      const ctx = { tabId: tab.id, db: 'prova', coll: 'righe', dbType: 'mysql',
        isStillActive: () => true, onSaveSuccess() {} };
      openEditDoc(doc, ctx);
      const editor = document.querySelector('#editdoc-json');
      const documentoEditor = JSON.parse(editor.value);
      editor.value = JSON.stringify({ ...documentoEditor, _id: 'modificato' });
      document.querySelector('#editdoc-save').click();
      await new Promise(resolve => setTimeout(resolve, 50));
      const cell = document.createElement('td');
      document.body.append(cell);
      startEdit(cell, doc, '_id', { ctx, metadato: { type: 'text' } });
      const input = cell.querySelector('input');
      input.value = 'inline';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 50));
      openInsertDocForContext(ctx);
      await new Promise(resolve => setTimeout(resolve, 50));
      const inputs = [...document.querySelectorAll('#insert-form tbody input')];
      inputs.find(input => !input.disabled).value = 'nuovo';
      return { documentoEditor, calls, id: idOf(doc), inserimento: buildInsertDoc(),
        generateDisabilitate: inputs.filter(input => input.disabled).length };
    });
    assert.deepStrictEqual(result.documentoEditor, { pk: 7, _id: 'dato reale' });
    assert.strictEqual(result.id, '{"pk":7}');
    const replace = result.calls.find(c => c.event === 'doc:replace').payload;
    assert.strictEqual(replace.id, '{"pk":7}');
    assert.deepStrictEqual(JSON.parse(replace.doc), { pk: 7, _id: 'modificato' });
    const update = result.calls.find(c => c.event === 'doc:update').payload;
    assert.strictEqual(update.id, '{"pk":7}');
    assert.deepStrictEqual(update.set, { _id: 'inline' });
    assert.deepStrictEqual(result.inserimento, { nome: 'nuovo' });
    assert.strictEqual(result.generateDisabilitate, 1);
    assert.deepStrictEqual(errors, []);
    console.log('OK: browser, _id reale e chiave originale, modifica intera/inline, inserimento con colonna calcolata');
  } finally {
    await browser?.close();
    await server.stop();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });

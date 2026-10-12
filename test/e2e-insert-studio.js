'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const dir = 'test-reports/inserimento-2026-10-12';
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3227 });
  const browser = await chromium.launch();
  const errors = [], layouts = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    if (process.argv.includes('--mutant')) await page.route('**/js/insert.js', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("if (row.mode === 'null') return null;", "if (row.mode === 'null') return undefined;") });
    });
    await page.goto(server.url); await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'insert-studio' }); tab.label = 'PostgreSQL'; tab.dbType = 'postgresql'; tabs.activeId = tab.id;
      Object.assign(tab.state, { connected: true, dbType: 'postgresql', db: 'diego_2', coll: 'Prova' });
      window.insertWrites = [];
      window.fields = [
        { name: 'id', types: ['integer'], nullable: false, autoIncrement: true },
        { name: 'punto', types: ['point'], nullable: true },
        { name: 'poligono', types: ['polygon'], nullable: true },
      ];
      (await import('/js/socket.js')).impostaSocket({ connected: true, on() {}, off() {}, emit(event, payload, cb) {
        if (event === 'collection:stats') return cb({ ok: true, fields: window.fields });
        if (event === 'collection:relations') return cb({ ok: true, relazioni: [] });
        if (event === 'doc:insert') { window.insertWrites.push(payload); return cb({ ok: true }); }
        cb?.({ ok: true });
      } });
      window.openInsert = async (type = 'postgresql') => {
        const { openInsertDocForContext } = await import('/js/insert.js');
        openInsertDocForContext({ tabId: tab.id, db: 'diego_2', coll: 'Prova', dbType: type, isStillActive: () => false });
      };
      await window.openInsert();
    });
    await page.waitForFunction(() => document.querySelectorAll('#insert-form tr').length === 3);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      for (const [width, height] of [[1440, 1000], [390, 844], [320, 640], [844, 390]]) {
        await page.setViewportSize({ width, height }); await page.waitForTimeout(200);
        const layout = await page.locator('.insert-studio').evaluate(el => {
          const b = el.getBoundingClientRect();
          return { width: b.width, left: b.left, right: b.right, overflow: el.scrollWidth > el.clientWidth + 2, icon: el.querySelector('svg').getBoundingClientRect().width, descriptionColor: getComputedStyle(el.querySelector('.insert-description')).color };
        });
        assert(layout.left >= -1 && layout.right <= width + 1 && !layout.overflow, `Layout ${theme} ${width}: ${JSON.stringify(layout)}`);
        assert(layout.icon >= 50);
        const rows = await page.locator('#insert-form tr').evaluateAll(rows => rows.map(row => {
          const [name, type, value, mode] = [...row.children].map(el => el.getBoundingClientRect());
          return { nameWidth: name.width, nameRight: name.right, modeLeft: mode.left, typeBottom: type.bottom, valueTop: value.top, valueWidth: value.width, width: row.clientWidth };
        }));
        assert(rows.every(r => r.nameWidth > 90 && r.nameRight <= r.modeLeft + 1 && r.typeBottom <= r.valueTop + 1 && r.valueWidth >= r.width - 6), `Campi senza sovrapposizioni ${width}: ${JSON.stringify(rows)}`);
        layouts.push({ theme, width, ...layout });
        await page.locator('#insert-save').scrollIntoViewIfNeeded();
        assert(await page.locator('#insert-save').isVisible());
        if (!process.argv.includes('--mutant')) {
          await page.screenshot({ path: `${dir}/${theme}-${width}.png`, animations: 'disabled' });
          if (width === 1440) await page.locator('.insert-studio').screenshot({ path: `${dir}/finestra-${theme}.png`, animations: 'disabled' });
          await page.locator('.insert-studio').evaluate(el => { el.scrollTop = 0; });
          if (width < 600) await page.screenshot({ path: `${dir}/${theme}-${width}-inizio.png`, animations: 'disabled' });
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const functional = await page.evaluate(async () => {
      const { addInsertRow, buildInsertDoc, selectInsertTab, insertRowValue, insertKindOf } = await import('/js/insert.js');
      const text = addInsertRow({ name: 'nome', kind: 'text', dbType: 'postgresql' });
      const setMode = (row, mode) => { row.modeSelect.value = mode; row.modeSelect.dispatchEvent(new Event('change')); };
      setMode(text, 'value');
      const empty = buildInsertDoc().nome;
      setMode(text, 'null'); const nullable = buildInsertDoc().nome;
      setMode(text, 'omit'); const omitted = !Object.hasOwn(buildInsertDoc(), 'nome');
      text.input.value = '  spazi  '; text.input.dispatchEvent(new Event('input'));
      const spaces = buildInsertDoc().nome;
      selectInsertTab('json');
      const editor = document.querySelector('#insert-json');
      editor.value = '{"nome":"nuovo", "punto":"(12345.5,9876.5)","totale":{"$numberDecimal":"123456789012345678901234567890123456789.1"}}';
      editor.dispatchEvent(new Event('input')); selectInsertTab('form');
      const fromJson = buildInsertDoc();
      text.input.value = 'modificato'; text.input.dispatchEvent(new Event('input'));
      selectInsertTab('json'); const roundtrip = JSON.parse(editor.value);
      editor.value = '{"nome":'; editor.dispatchEvent(new Event('input'));
      const blocked = selectInsertTab('form') === false && document.querySelector('#insert-tab-form').classList.contains('hidden');
      editor.value = JSON.stringify(roundtrip); editor.dispatchEvent(new Event('input')); selectInsertTab('form');
      const codec = await import('/js/insert-types.js');
      const inputs = {
        text: '', int: '-2147483648', long: '9223372036854775807', double: '-0', decimal: '1234567890123456789012345678901234', bool: 'false',
        datetime: '9223372036854775807', oid: '0123456789abcdef01234567', json: '{"n":9007199254740993}', geo: '{"type":"Point","coordinates":[12,41]}',
        binary: '{"base64":"AP8=","subType":"00"}', uuid: '12345678-1234-1234-1234-123456789abc', regex: '{"pattern":"^a","options":"i"}', timestamp: '{"t":4294967295,"i":0}',
        code: 'return 1', scope: '{"$code":"return x","$scope":{"x":1}}', symbol: 'simbolo', dbpointer: '{"$ref":"ns","$id":{"$oid":"0123456789abcdef01234567"}}', undefined: '', minkey: '', maxkey: '',
      };
      const values = Object.fromEntries(codec.tipiBson.map(([kind]) => [kind, codec.valoreInserimento(inputs[kind], kind, {}, false)]));
      const bits = codec.valoreInserimento('1'.repeat(64), 'bits', { dbType: 'mysql' }, true);
      const rawJson = '{ "n":9007199254740993, "n":1 }';
      return { empty, nullable, omitted, spaces, fromJson, roundtrip, blocked, values, bits, rawJson: codec.valoreInserimento(rawJson, 'json', {}, true), pg: insertKindOf('point', 'postgresql'), array: insertKindOf('numeric[]', 'postgresql') };
    });
    assert.equal(functional.empty, ''); assert.equal(functional.nullable, null); assert(functional.omitted); assert.equal(functional.spaces, '  spazi  ');
    assert.equal(functional.fromJson.nome, 'nuovo'); assert.equal(functional.fromJson.punto, '(12345.5,9876.5)'); assert.equal(functional.roundtrip.nome, 'modificato'); assert(functional.blocked);
    assert.equal(functional.fromJson.totale.$numberDecimal, '123456789012345678901234567890123456789.1');
    assert.equal(functional.values.long.$numberLong, '9223372036854775807'); assert.equal(functional.values.int.$numberInt, '-2147483648');
    assert.equal(functional.bits.$numberDecimal, '18446744073709551615'); assert.equal(functional.rawJson, '{ "n":9007199254740993, "n":1 }');
    assert.equal(functional.pg, 'pggeo'); assert.equal(functional.array, 'native');
    const bsonDraft = await page.evaluate(async () => {
      window.fields = [
        { name: 'bin', types: ['binary'] }, { name: 're', types: ['bsonregexp'] },
        { name: 'ts', types: ['timestamp'] }, { name: 'data', types: ['date'] },
        { name: 'testo', types: ['string'] }, { name: 'code', types: ['code'] },
      ];
      await window.openInsert('mongodb');
      await new Promise(resolve => setTimeout(resolve, 50));
      const { selectInsertTab, buildInsertDoc } = await import('/js/insert.js');
      selectInsertTab('json');
      const expected = { bin: { $binary: { base64: 'AP8=', subType: '00' } }, re: { $regularExpression: { pattern: '^a', options: 'i' } },
        ts: { $timestamp: { t: 4294967295, i: 1 } }, data: { $date: { $numberLong: '9223372036854775807' } }, testo: 'prima\nseconda', code: { $code: 'return 1;\n// seconda riga' } };
      const editor = document.querySelector('#insert-json'); editor.value = JSON.stringify(expected); editor.dispatchEvent(new Event('input'));
      selectInsertTab('form');
      const visible = {};
      for (const row of document.querySelectorAll('#insert-form tr')) {
        const name = row.querySelector('.insert-name').textContent;
        const input = row.querySelector('.insert-value :is(input,textarea)');
        visible[name] = input.value;
        input.dispatchEvent(new Event('input'));
      }
      return { expected, visible, actual: buildInsertDoc() };
    });
    assert.equal(bsonDraft.visible.data, '9223372036854775807');
    assert.equal(bsonDraft.visible.testo, 'prima\nseconda'); assert.equal(bsonDraft.visible.code, 'return 1;\n// seconda riga');
    assert.deepEqual(bsonDraft.actual, bsonDraft.expected, 'Modifica successiva a JSON→Campi senza involucri doppi o date vuote');
    await page.getByRole('textbox', { name: 'Valore testo', exact: true }).fill('una\ndue\n');
    assert.equal(await page.evaluate(async () => (await import('/js/insert.js')).buildInsertDoc().testo), 'una\ndue\n');
    await page.getByRole('textbox', { name: 'Valore data', exact: true }).fill('2026-10-12T12:34:56.123Z');
    await page.getByRole('button', { name: 'Calendario Valore data', exact: true }).click();
    await page.getByRole('gridcell', { name: 'martedì 13 ottobre 2026', exact: true }).click();
    assert.equal(await page.evaluate(async () => (await import('/js/insert.js')).buildInsertDoc().data.$date), '2026-10-13T12:34:56.123Z', 'Il calendario cambia solo il giorno, conservando ora e millisecondi');
    assert.equal(await page.locator('.insert-emblem-row').evaluate(el => el.getAnimations().length), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    assert.deepEqual(await page.locator('.insert-emblem-row').evaluate(el => el.getAnimations().map(a => a.effect.getTiming().iterations)), [1]);
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${dir}/checks.json`, JSON.stringify({ layouts, functional, bsonDraft, errors }, null, 2));
    console.log('OK: 8 layout, tutti i controlli BSON, NULL/vuoto/default, doppia sincronizzazione JSON, precisione, errori e movimento ridotto.');
  } finally { await browser.close(); await server.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

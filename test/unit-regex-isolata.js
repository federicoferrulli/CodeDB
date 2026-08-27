'use strict';

const assert = require('assert');
const { eseguiRegexIsolata } = require('../db/regexIsolata');

module.exports = (async () => {
  console.log('--- Test unitari isolamento regex ---');

  let timerScattato = false;
  const timer = setTimeout(() => { timerScattato = true; }, 5);
  await assert.rejects(
    eseguiRegexIsolata(/^(a|aa)+$/, 'test', ['a'.repeat(42) + '!'], {
      tempoMs: 20, maxTesto: 5000, maxPattern: 1000, runId: 'run-regex-costosa',
    }),
    /run-regex-costosa.*tempo massimo|tempo massimo.*run-regex-costosa/i
  );
  clearTimeout(timer);
  assert.strictEqual(timerScattato, true, 'il timer del thread principale deve rispondere durante la regex');

  assert.strictEqual(await eseguiRegexIsolata(/^ab+c$/, 'test', ['abbbc']), true);
  assert.deepStrictEqual(await eseguiRegexIsolata('abc-123', 'match', [/\d+/]), ['123']);
  await assert.rejects(eseguiRegexIsolata(/a/, 'test', ['a'.repeat(11)], { maxTesto: 10 }), /testo.*limite/i);
  await assert.rejects(eseguiRegexIsolata(new RegExp('a'.repeat(11)), 'test', ['a'], { maxPattern: 10 }), /pattern.*limite/i);

  console.log('  OK   timeout terminabile, thread responsivo e budget espliciti');
})();

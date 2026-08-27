'use strict';

const assert = require('assert');
const { ConfirmQuota, costoValore } = require('../mcp/ConfirmQuota');

console.log('--- Test quote conferme MCP ---');
const piano = { rows: Array.from({ length: 20 }, (_, i) => ({ id: i, nome: `riga-${i}` })), exec() {} };
assert(costoValore(piano) > 256, 'il costo deve includere piano e chiusura');
const quota = new ConfirmQuota({ principalCount: 2, principalBytes: 5000, globalCount: 3, globalBytes: 8000 });
const a1 = quota.reserve('a', piano);
const a2 = quota.reserve('a', { piccolo: true });
assert.throws(() => quota.reserve('a', { terzo: true }), (err) => err.code === 'MCP_CONFIRM_QUOTA_EXCEEDED');
const b1 = quota.reserve('b', { piccolo: true });
assert.throws(() => quota.reserve('c', { globale: true }), (err) => err.code === 'MCP_CONFIRM_QUOTA_EXCEEDED');
assert.strictEqual(quota.snapshot().global.count, 3);
quota.release(a1);
quota.release(a2);
quota.release(b1);
assert.deepStrictEqual(quota.snapshot(), { global: { count: 0, bytes: 0 }, principals: {} },
  'consumo/scadenza deve liberare immediatamente riferimenti e contabilità');
const reused = quota.reserve('a', piano);
assert.strictEqual(quota.snapshot().global.count, 1, 'la quota deve essere riutilizzabile dopo cleanup');
quota.release(reused);
const quotaByte = new ConfirmQuota({ principalCount: 10, principalBytes: costoValore(piano) - 1, globalCount: 10, globalBytes: 10000 });
assert.throws(() => quotaByte.reserve('grande', piano), (err) => err.code === 'MCP_CONFIRM_QUOTA_EXCEEDED',
  'il limite in byte deve valere anche sotto il limite numerico');
console.log('  OK   limiti per principal/globali, byte contabilizzati e cleanup');

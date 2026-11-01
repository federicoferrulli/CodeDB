'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { SocketFinto } = require('./socket-finto');
const { formattaOutputMutante } = require('./lab/output-mutanti.cjs');
const mutant = process.argv.find(arg => arg.startsWith('--mutant='))?.slice(9) || null;
if (mutant && !['tab', 'retry', 'disconnect'].includes(mutant)) throw new Error('Mutante sconosciuto: ' + mutant);
const modulo = name => pathToFileURL(path.join(__dirname, '../public/js', name)).href;
module.exports = (async () => {
  if (typeof window === 'undefined') globalThis.window = new EventTarget();
  if (typeof document === 'undefined') globalThis.document = { querySelector: () => null };
  const { impostaSocket } = await import(modulo('socket.js'));
  const { emit: reale } = await import(modulo('trasporto.js'));
  const { tabs, createTab, closeTab } = await import(modulo('tabs.js'));
  const emit = (event, payload, options = {}) => reale(event, payload, {
    ...options, ...(mutant === 'tab' ? { bindTab: true } : {}),
    ...(mutant === 'retry' ? { reconnect: true } : {}),
    ...(mutant === 'disconnect' ? { rejectOnDisconnect: false } : {}),
  });
  const independent = { bindTab: false, reconnect: false, rejectOnDisconnect: true };
  let failed = 0;
  async function test(id, action) {
    tabs.list.length = 0; tabs.activeId = null;
    const socket = new SocketFinto(), events = new EventEmitter(); socket.connected = true;
    socket.on = (event, fn) => events.on(event, fn); socket.off = (event, fn) => events.off(event, fn);
    socket.disconnect = () => { socket.connected = false; events.emit('disconnect', 'transport close'); };
    impostaSocket(socket);
    const tab = createTab({ id: 'tab-restore', connName: 'collaudo' }); tabs.activeId = tab.id;
    try { await action({ socket, events, tab }); console.log(formattaOutputMutante(mutant, 'OK ' + id)); }
    catch (error) { failed++; console.error(formattaOutputMutante(mutant, 'FAIL ' + id + ': ' + error.message)); }
  }
  await test('STATO-SENZA-TAB', async ({ socket, tab }) => {
    socket.sospendi('backup:restore:state');
    const request = emit('backup:restore:state', { operationId: 'r1' }, independent);
    closeTab(tab.id); socket.sblocca('backup:restore:state', { ok: true, operation: { operationId: 'r1' } });
    const response = await request;
    assert.equal(socket.ultimoPayload('backup:restore:state').tabId, undefined);
    assert.equal(response._tab, null); assert.equal(response._state, null);
  });
  await test('ACK-DOPO-CHIUSURA-TAB', async ({ socket, tab }) => {
    socket.sospendi('backup:restore');
    const request = emit('backup:restore', { operationId: 'r1', tabId: tab.id }, independent);
    closeTab(tab.id); socket.sblocca('backup:restore', { ok: true, summary: { status: 'completato' } });
    assert.equal((await request).summary.status, 'completato');
    assert.equal(socket.con('backup:restore').length, 1); assert.equal(socket.ultimoPayload('backup:restore').tabId, tab.id);
  });
  await test('NESSUN-RETRY-RESTORE', async ({ socket, tab }) => {
    socket.rispondiA('backup:restore', { ok: false, error: 'Nessuna connessione attiva al database.' });
    socket.rispondiA('mongo:connect', { ok: true }); socket.rispondiA('backup:restore', { ok: true });
    await assert.rejects(emit('backup:restore', { tabId: tab.id }, { reconnect: false }), /Nessuna connessione attiva/);
    assert.equal(socket.con('backup:restore').length, 1); assert.equal(socket.con('mongo:connect').length, 0);
  });
  await test('DISCONNECT-ESITO-INCERTO', async ({ socket, events }) => {
    socket.sospendi('backup:restore');
    const request = emit('backup:restore', { operationId: 'r1' }, independent);
    let settled = false; request.then(() => { settled = true; }, () => { settled = true; });
    socket.disconnect(); await Promise.resolve();
    // Sblocca comunque il mutante: la sensibilità non dipende da un timeout.
    socket.sblocca('backup:restore', { ok: true });
    assert.equal(settled, true, 'La caduta del trasporto risolve l’attesa con esito incerto');
    await assert.rejects(request, error => error.code === 'SOCKET_DISCONNECTED');
    assert.equal(events.listenerCount('disconnect'), 0);
  });
  await test('OFFLINE-NESSUN-ACCODAMENTO', async ({ socket }) => {
    socket.connected = false;
    await assert.rejects(emit('backup:restore', { operationId: 'r1' }, independent), error => error.code === 'SOCKET_DISCONNECTED');
    assert.equal(socket.con('backup:restore').length, 0);
  });
  await test('ACK-RIMUOVE-LISTENER', async ({ socket, events }) => {
    socket.rispondiA('backup:restore', { ok: true, summary: { status: 'completato' } });
    assert.equal((await emit('backup:restore', { operationId: 'r1' }, independent)).summary.status, 'completato');
    assert.equal(events.listenerCount('disconnect'), 0); socket.disconnect();
  });
  await test('TIMEOUT-RIMUOVE-LISTENER', async ({ socket, events }) => {
    socket.sospendi('backup:restore:state');
    await assert.rejects(emit('backup:restore:state', {}, { ...independent, timeoutMs: 10 }), /tempo previsto/);
    assert.equal(events.listenerCount('disconnect'), 0);
  });
  impostaSocket(null);
  if (failed) throw new Error(`${failed} verifiche del trasporto ripristino fallite`);
})();

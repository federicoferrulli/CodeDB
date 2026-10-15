'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isInstallAdmin } = require('../auth/permissions');

function autorizza(session, env = process.env) {
  if (session.strategy?.type !== 'mongodb') throw new Error('mongosh richiede una connessione MongoDB.');
  if (!isInstallAdmin(session.principal, env)) throw new Error('Il runtime mongosh completo accede anche a Node.js e ai file del server: è riservato all’amministratore dell’installazione.');
}
class MongoshRuntime {
  constructor(uri, { timeout = 60000, maxBytes = 32 * 1024 * 1024, onEvent = () => {} } = {}) {
    this.timeout = timeout; this.maxBytes = maxBytes; this.onEvent = onEvent;
    this.pending = new Map(); this.streams = new Map(); this.prompts = new Set(); this.closed = false;
    this.child = fork(path.join(__dirname, 'mongoshProcesso.cjs'), [], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: ['--max-old-space-size=256'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    this.child.stderr.on('data', () => {});
    this.child.on('message', msg => {
      if (msg.event) {
        if (msg.event === 'stream') {
          const old = this.streams.get(msg.id) || { id: msg.id, events: [], omessi: 0 };
          if (msg.document) old.events.push(msg.document);
          Object.assign(old, { status: msg.status, error: msg.error, resumeToken: msg.resumeToken });
          while (old.events.length > 200 || Buffer.byteLength(JSON.stringify(old.events)) > this.maxBytes) { old.events.shift(); old.omessi++; }
          this.streams.set(msg.id, old);
          while (this.streams.size > 20) {
            const finished = [...this.streams].find(([, f]) => ['chiuso', 'errore'].includes(f.status));
            if (!finished) break; this.streams.delete(finished[0]);
          }
        }
        if (msg.event === 'prompt') this.prompts.add(msg.id);
        this.onEvent(msg); return;
      }
      const p = this.pending.get(msg.id); if (!p) return;
      this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), msg.error));
      else {
        if (msg.result?.exited) this.fail(new Error('Chiusura mongosh richiesta.'));
        p.resolve(msg.result);
      }
    });
    this.child.on('error', err => this.fail(err));
    this.child.on('exit', () => this.fail(new Error('Runtime mongosh terminato; variabili, sessioni e stream sono stati chiusi.')));
    this.ready = this.request('init', { options: { uri, maxBytes } });
    this.ready.catch(err => { this.fail(err); this.child.kill(); });
  }
  fail(err) {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear(); this.prompts.clear();
    for (const f of this.streams.values()) if (!['chiuso', 'errore'].includes(f.status)) {
      f.status = 'chiuso'; this.onEvent({ event: 'stream', id: f.id, status: 'chiuso', error: err.message, resumeToken: f.resumeToken });
    }
  }
  request(action, data = {}, ms = this.timeout) {
    if (this.closed) return Promise.reject(new Error('Runtime mongosh chiuso: esegui di nuovo per riaprirlo.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error('Tempo mongosh esaurito: runtime e stream chiusi.')); this.child.kill(); }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, action, ...data }, err => { if (err) this.fail(err); });
    });
  }
  async evaluate(code, db, opHandle) {
    if (this.busy) throw new Error('Una query mongosh è già in esecuzione in questo tab.');
    this.busy = true;
    if (opHandle) opHandle.cancelMongosh = () => this.close();
    try { await this.ready; return await this.request('evaluate', { code, db }); }
    finally { this.busy = false; if (opHandle) delete opHandle.cancelMongosh; }
  }
  answer(id, value) {
    if (!this.prompts.delete(id)) throw new Error('Richiesta mongosh scaduta o appartenente a un altro tab.');
    this.child.send({ action: 'answer', promptId: id, value });
  }
  close() {
    if (!this.closing) this.closing = Promise.resolve().then(() => this.finishClose());
    return this.closing;
  }
  async finishClose() {
    if (this.closed) return;
    // Anche un while(true) deve poter essere fermato dal processo del server.
    if (this.busy) { this.fail(new Error('Esecuzione mongosh annullata: il runtime è stato azzerato.')); this.child.kill(); return; }
    try { await this.request('close', {}, 2000); } catch { this.child.kill(); }
    this.fail(new Error('Runtime mongosh chiuso.'));
  }
}
module.exports = { MongoshRuntime, autorizza };

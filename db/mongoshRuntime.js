'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isInstallAdmin } = require('../auth/permissions');

const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PROCESSI = 3;
const STREAM_MAX_BYTES_CAP = 4 * 1024 * 1024;
const KILL_ESCALATION_MS = 2000;

// Registro globale dei runtime mongosh attivi per impedire la proliferazione di
// processi figli (~90 MB RSS ciascuno) tra tab inattivi.
const processiAttivi = new Set();

function envPulito(sourceEnv = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(sourceEnv)) {
    if (v === undefined) continue;
    // Rimuove segreti e configurazioni interne del server; lascia passare solo
    // le variabili esplicitamente lette dal runtime mongosh (CODEDB_MONGOSH_*).
    if (/^CODEDB_/i.test(k) && !/^CODEDB_MONGOSH_/i.test(k)) continue;
    if (/^(GUI_MONGO_PASSPHRASE|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_STORAGE_CONNECTION_STRING|SLACK_WEBHOOK_URL|GOOGLE_APPLICATION_CREDENTIALS)$/i.test(k)) continue;
    out[k] = v;
  }
  out.ELECTRON_RUN_AS_NODE = '1';
  return out;
}

function autorizza(session, env = process.env) {
  if (session.strategy?.type !== 'mongodb') throw new Error('mongosh richiede una connessione MongoDB.');
  if (!isInstallAdmin(session.principal, env)) throw new Error('Il runtime mongosh completo accede anche a Node.js e ai file del server: è riservato all’amministratore dell’installazione.');
}

class MongoshRuntime {
  constructor(uri, {
    timeout = 60000,
    maxBytes = 32 * 1024 * 1024,
    idleTimeoutMs = Math.max(parseInt(process.env.CODEDB_MONGOSH_IDLE_MS, 10) || DEFAULT_IDLE_MS, 0),
    maxProcesses = Math.max(parseInt(process.env.CODEDB_MAX_MONGOSH_PROCESSES, 10) || DEFAULT_MAX_PROCESSI, 1),
    onEvent = () => {},
  } = {}) {
    // Applica il tetto globale di processi mongosh: se siamo al limite, libera il
    // più vecchio inattivo (non busy e senza change stream aperti).
    if (processiAttivi.size >= maxProcesses) {
      let liberato = false;
      for (const altro of processiAttivi) {
        if (!altro.busy && !altro.haStreamAttivi()) {
          altro.close().catch(() => {});
          liberato = true;
          break;
        }
      }
      if (!liberato && processiAttivi.size >= maxProcesses) {
        throw new Error(`Limite di ${maxProcesses} processi mongosh attivi contemporaneamente raggiunto. Chiudi un tab o uno stream prima di aprirne un altro.`);
      }
    }
    this.timeout = timeout;
    this.maxBytes = maxBytes;
    this.streamMaxBytes = Math.min(maxBytes, STREAM_MAX_BYTES_CAP);
    this.idleTimeoutMs = idleTimeoutMs;
    this.idleTimer = null;
    this.killTimer = null;
    this.onEvent = onEvent;
    this.pending = new Map(); this.streams = new Map(); this.prompts = new Set(); this.closed = false;
    processiAttivi.add(this);
    this.child = fork(path.join(__dirname, 'mongoshProcesso.cjs'), [], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: ['--max-old-space-size=256'], env: envPulito(process.env),
    });
    this.child.stderr.on('data', () => {});
    this.child.on('message', msg => {
      if (msg.event) {
        if (msg.event === 'stream') {
          const old = this.streams.get(msg.id) || { id: msg.id, events: [], _sizes: [], _bytes: 0, omessi: 0 };
          if (msg.document) {
            const sz = Buffer.byteLength(JSON.stringify(msg.document) || '');
            old.events.push(msg.document);
            old._sizes.push(sz);
            old._bytes += sz;
          }
          Object.assign(old, { status: msg.status, error: msg.error, resumeToken: msg.resumeToken });
          while (old.events.length > 200 || (old._bytes > this.streamMaxBytes && old.events.length > 1)) {
            old.events.shift();
            old._bytes -= old._sizes.shift() || 0;
            old.omessi++;
          }
          this.streams.set(msg.id, old);
          while (this.streams.size > 20) {
            const finished = [...this.streams].find(([, f]) => ['chiuso', 'errore'].includes(f.status));
            if (!finished) break; this.streams.delete(finished[0]);
          }
          this.rinnovaIdle();
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
    this.child.on('exit', () => {
      clearTimeout(this.killTimer);
      this.killTimer = null;
      this.fail(new Error('Runtime mongosh terminato; variabili, sessioni e stream sono stati chiusi.'));
    });
    this.ready = this.request('init', { options: { uri, maxBytes } });
    this.ready.then(() => this.rinnovaIdle(), err => { this.fail(err); this.uccidiProcesso(); });
  }
  haStreamAttivi() {
    for (const f of this.streams.values()) {
      if (!['chiuso', 'errore'].includes(f.status)) return true;
    }
    return false;
  }
  rinnovaIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.closed || !this.idleTimeoutMs || this.busy || this.haStreamAttivi()) return;
    this.idleTimer = setTimeout(() => {
      if (!this.closed && !this.busy && !this.haStreamAttivi()) this.close().catch(() => {});
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }
  uccidiProcesso() {
    if (!this.child || this.child.exitCode !== null || this.child.killed) return;
    try { this.child.kill('SIGTERM'); } catch { /* già terminato */ }
    if (!this.killTimer) {
      this.killTimer = setTimeout(() => {
        this.killTimer = null;
        if (this.child && this.child.exitCode === null) {
          try { this.child.kill('SIGKILL'); } catch { /* già terminato */ }
        }
      }, KILL_ESCALATION_MS);
      this.killTimer.unref?.();
    }
  }
  fail(err) {
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    processiAttivi.delete(this);
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
      const timer = setTimeout(() => { this.fail(new Error('Tempo mongosh esaurito: runtime e stream chiusi.')); this.uccidiProcesso(); }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, action, ...data }, err => { if (err) this.fail(err); });
    });
  }
  async evaluate(code, db, opHandle) {
    if (this.busy) throw new Error('Una query mongosh è già in esecuzione in questo tab.');
    this.busy = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (opHandle) opHandle.cancelMongosh = () => this.close();
    try { await this.ready; return await this.request('evaluate', { code, db }); }
    finally { this.busy = false; if (opHandle) delete opHandle.cancelMongosh; this.rinnovaIdle(); }
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
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // Anche un while(true) deve poter essere fermato dal processo del server.
    if (this.busy) { this.fail(new Error('Esecuzione mongosh annullata: il runtime è stato azzerato.')); this.uccidiProcesso(); return; }
    try { await this.request('close', {}, 2000); } catch { this.uccidiProcesso(); }
    this.fail(new Error('Runtime mongosh chiuso.'));
  }
}
module.exports = { MongoshRuntime, autorizza, envPulito };

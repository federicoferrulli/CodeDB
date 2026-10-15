import { socket } from './socket.js';
import { activeTab, tabs, allaChiusura } from './tabs.js';
import { emit, toast } from './utils.js';

const stati = new Map();
const risultati = new Map();
let pronto = false;
export function risultatoMongosh(tabId, result) {
  risultati.set(tabId, {scriptOutput:result.scriptOutput || [],cursorHasMore:result.cursorHasMore});
  if (tabId === activeTab()?.id) renderMongosh();
}
function pannello() {
  let el = document.getElementById('query-mongosh');
  if (!el) {
    el = document.createElement('details'); el.id = 'query-mongosh'; el.open = true;
    el.className = 'query-mongosh';
    document.getElementById('query-results-container')?.prepend(el);
  }
  return el;
}
export function renderMongosh() {
  const el = pannello(), tab = activeTab(), streams = stati.get(tab?.id) || new Map();
  el.hidden = document.getElementById('query-target-engine')?.value !== 'mongosh' && !streams.size;
  el.replaceChildren();
  const summary = document.createElement('summary'); summary.textContent = `mongosh · ${[...streams.values()].filter(f => !['chiuso', 'errore'].includes(f.status)).length} stream attivi`;
  el.append(summary);
  const result = risultati.get(tab?.id);
  if (result?.cursorHasMore) {
    const hint = document.createElement('p'); hint.textContent = 'Il cursore contiene altri risultati: esegui it per il batch successivo, oppure toArray() per richiederli insieme.';
    el.append(hint);
  }
  if (result?.scriptOutput?.length) {
    const output = document.createElement('pre'); output.textContent = result.scriptOutput.join('\n'); el.append(output);
  }
  const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'ghost btn-sm';
  reset.textContent = 'Azzera runtime';
  reset.title = 'Chiude stream e sessioni e cancella le variabili di questo tab.';
  reset.onclick = async () => {
    try { await emit('mongosh:reset', { tabId: tab.id }); stati.delete(tab.id); risultati.delete(tab.id); renderMongosh(); }
    catch (e) { toast(e.message, 'error'); }
  };
  el.append(reset);
  for (const f of streams.values()) {
    const row = document.createElement('details'); row.open = true;
    const head = document.createElement('summary'); head.textContent = `Stream ${f.id.slice(0, 8)} · ${f.status} · ${f.events.length} eventi${f.omessi ? ` · ${f.omessi} precedenti omessi` : ''}`;
    row.append(head);
    if (!['chiuso', 'errore'].includes(f.status)) {
      const close = document.createElement('button'); close.type = 'button'; close.className = 'ghost btn-sm'; close.textContent = 'Chiudi stream';
      close.onclick = () => emit('mongosh:closeStream', { tabId: tab.id, streamId: f.id }).catch(e => toast(e.message, 'error'));
      row.append(close);
    }
    const pre = document.createElement('pre'); pre.textContent = f.error || f.events.map(v => JSON.stringify(v, null, 2)).join('\n'); row.append(pre);
    if (f.resumeToken) {
      const token = document.createElement('details'), title = document.createElement('summary'), text = document.createElement('pre');
      title.textContent = 'Resume token'; text.textContent = JSON.stringify(f.resumeToken); token.append(title, text); row.append(token);
    }
    el.append(row);
  }
}
function domanda(msg) {
  const dialog = document.createElement('dialog'), form = document.createElement('form'); form.method = 'dialog';
  const label = document.createElement('label'); label.textContent = `mongosh · ${msg.question}`;
  const input = document.createElement('input'); input.type = msg.type === 'password' ? 'password' : 'text'; input.autocomplete = 'off'; label.append(input);
  const send = document.createElement('button'); send.textContent = 'Invia'; send.type = 'submit';
  form.append(label, send); dialog.append(form); document.body.append(dialog);
  dialog.addEventListener('close', () => { void emit('mongosh:answer', { tabId: msg.tabId, promptId: msg.id, value: input.value }).catch(e => toast(e.message, 'error')); dialog.remove(); });
  dialog.showModal(); input.focus();
}
export function initMongosh() {
  if (pronto) return; pronto = true;
  socket.on('mongosh:event', msg => {
    if (!tabs.list.some(t => t.id === msg.tabId)) return;
    if (msg.event === 'prompt') { domanda(msg); return; }
    if (msg.event === 'evaluation' || msg.event === 'output') {
      const result = msg.event === 'evaluation' ? {scriptOutput:[]} : risultati.get(msg.tabId) || {scriptOutput:[]};
      if (msg.lines) result.scriptOutput.push(...msg.lines);
      while (result.scriptOutput.length > 1000 || result.scriptOutput.join('\n').length > 2*1024*1024) result.scriptOutput.shift();
      risultatoMongosh(msg.tabId,result);
      return;
    }
    if (msg.event !== 'stream') return;
    const map = stati.get(msg.tabId) || new Map(); stati.set(msg.tabId, map);
    const f = map.get(msg.id) || { id: msg.id, events: [], omessi: 0 };
    if (msg.document) f.events.push(msg.document);
    while (f.events.length > 200 || JSON.stringify(f.events).length > 2 * 1024 * 1024) { f.events.shift(); f.omessi++; }
    Object.assign(f, { status: msg.status, error: msg.error, resumeToken: msg.resumeToken }); map.set(msg.id, f);
    while (map.size > 20) {
      const finished = [...map].find(([, f]) => ['chiuso', 'errore'].includes(f.status));
      if (!finished) break;
      map.delete(finished[0]);
    }
    if (msg.tabId === activeTab()?.id) renderMongosh();
  });
  socket.on('disconnect', () => { for (const streams of stati.values()) for (const f of streams.values()) f.status = 'chiuso'; renderMongosh(); });
  allaChiusura(tab => { const id = typeof tab === 'string' ? tab : tab.id; stati.delete(id); risultati.delete(id); });
}

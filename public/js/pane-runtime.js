import { socket } from './socket.js';
import { tabs, createTab } from './tabs.js';
import { safeUUID } from './valori.js';
import * as pending from './pending-queries.js';
import { azioneDiEvento } from './scorciatoie.js';

export const contestoIncorporato = typeof window !== 'undefined' ? window.frameElement?.codedbPanel : null;

// I controller vanilla conservano variabili di modulo e id DOM: un documento
// incorporato li isola senza duplicare editor, Arc o sessioni del server.
export function creaRuntimePane(pane, slot, onFocus, onClose) {
  const tab = tabs.list.find(t => t.id === pane.tabId);
  if (!tab) return null;
  const frame = document.createElement('iframe');
  frame.className = 'pane-runtime';
  frame.title = `${tab.label} / ${pane.db} / ${pane.coll || 'Query'}`;
  frame.setAttribute('aria-label', frame.title);
  const listeners = [];
  const runs = new Map();
  let disposed = false;
  const bridge = {
    get connected() { return socket.connected; },
    on(event, fn) {
      const wrapped = data => { if (!data?.tabId || data.tabId === pane.tabId) fn(data); };
      listeners.push([event, fn, wrapped]);
      socket.on(event, wrapped);
      return bridge;
    },
    off(event, fn) {
      for (let i = listeners.length - 1; i >= 0; i--) {
        const [name, original, wrapped] = listeners[i];
        if (event === name && (!fn || original === fn)) { socket.off(name, wrapped); listeners.splice(i, 1); }
      }
      return bridge;
    },
    emit(event, payload, ack) {
      if (disposed || !tabs.list.includes(tab)) { ack?.({ ok: false, error: 'La connessione di questo pannello è stata chiusa.' }); return bridge; }
      if (event === 'mongo:disconnect' || event.startsWith('collection:watch') || event === 'collection:unwatch') return bridge;
      if (payload?.runId && (event === 'query:execute' || event === 'script:execute')) runs.set(payload.runId, event);
      const scrittura = /^doc:(insert|update|replace|delete)$/.test(event);
      if (scrittura) tab.state.writesInFlight = (tab.state.writesInFlight || 0) + 1;
      socket.emit(event, { ...payload, tabId: pane.tabId }, res => {
        if (scrittura) tab.state.writesInFlight--;
        if (event === 'query:execute' || event === 'script:abort') runs.delete(payload?.runId);
        if (!disposed) ack?.(res);
      });
      return bridge;
    },
    timeout(ms) {
      return { emit(event, payload, ack) {
        if (disposed || !tabs.list.includes(tab)) { ack(new Error('Connessione chiusa')); return; }
        socket.timeout(ms).emit(event, { ...payload, tabId: pane.tabId }, ack);
      } };
    },
  };
  const descriptor = frame.codedbPanel = {
    id: safeUUID(), tabId: pane.tabId, db: pane.db, coll: pane.coll,
    label: tab.label, dbType: tab.dbType, databases: tab.state.databases,
    query: pane.query || null, socket: bridge, onFocus, pending,
    paneId: pane.id,
    onKey(event) {
      const action = azioneDiEvento(event);
      const global = ['sidebarConnessioni', 'chiudiScheda', 'paletteComandi'].includes(action);
      const splitKey = event.altKey && !event.target?.closest?.('input, textarea, select, [contenteditable="true"], [role="combobox"]');
      if (!global && !splitKey) return false;
      onFocus();
      if (action === 'chiudiScheda') onClose();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, bubbles: true, cancelable: true }));
      return true;
    },
  };
  frame.src = './index.html';
  // Il frame resta sempre montato: spostare un iframe nel DOM ne riavvia il runtime.
  let deck = document.getElementById('pane-runtime-deck');
  if (!deck) {
    deck = document.createElement('div'); deck.id = 'pane-runtime-deck';
    document.getElementById('workspace').append(deck);
  }
  deck.append(frame);
  const allinea = () => {
    const visible = !disposed && slot.isConnected && slot.getClientRects().length && pane.view && pane.view !== 'data';
    frame.hidden = !visible;
    if (!visible) return;
    const rect = slot.getBoundingClientRect();
    const origin = deck.getBoundingClientRect();
    Object.assign(frame.style, { left: `${rect.left - origin.left}px`, top: `${rect.top - origin.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const bounds = slot.closest('.split-container').getBoundingClientRect();
    frame.style.clipPath = `inset(${Math.max(0, bounds.top - rect.top)}px 0 ${Math.max(0, rect.bottom - bounds.bottom)}px 0)`;
  };
  document.addEventListener('scroll', allinea, true);
  const observer = new ResizeObserver(allinea);
  observer.observe(slot);
  const mutazioni = new MutationObserver(allinea);
  mutazioni.observe(document.getElementById('workspace'), { attributes: true, subtree: true, attributeFilter: ['class'] });
  const tema = () => {
    const doc = frame.contentDocument;
    if (!doc?.documentElement || !descriptor.ready) return;
    for (const name of ['data-theme', 'data-theme-custom']) {
      const value = document.documentElement.getAttribute(name);
      if (value) doc.documentElement.setAttribute(name, value); else doc.documentElement.removeAttribute(name);
    }
    const style = doc.getElementById('tema-pannello') || doc.head.appendChild(Object.assign(doc.createElement('style'), { id: 'tema-pannello' }));
    const computed = getComputedStyle(document.documentElement);
    // Si ereditano i colori, non le misure della viewport del documento ospite.
    style.textContent = ':root[data-theme]{' + [...computed].filter(k => k.startsWith('--') && /^(#|rgba?\(|hsla?\(|oklch\(|color-mix\(|transparent)/.test(computed.getPropertyValue(k).trim())).map(k => `${k}:${computed.getPropertyValue(k)};`).join('') + '}';
    doc.dispatchEvent(new CustomEvent('codedb:tema'));
  };
  const themeObserver = new MutationObserver(tema);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-custom', 'style'] });
  themeObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  descriptor.onReady = () => { tema(); descriptor.setView(pane.view || 'query'); allinea(); };
  return {
    frame, allinea,
    setView(view) { pane.view = view; descriptor.setView?.(view); allinea(); },
    snapshot() { return descriptor.snapshot?.() || pane.query || null; },
    dirty() { return !!descriptor.dirty?.(); },
    dispose() {
      disposed = true;
      for (const [runId, event] of runs) socket.emit(event === 'script:execute' ? 'script:abort' : 'query:cancel', { tabId: pane.tabId, runId });
      for (const [event, , fn] of listeners) socket.off(event, fn);
      observer.disconnect(); mutazioni.disconnect(); themeObserver.disconnect(); frame.remove();
      document.removeEventListener('scroll', allinea, true);
    },
  };
}

export function preparaPannelloIncorporato() {
  const ctx = contestoIncorporato;
  if (!ctx) return;
  document.documentElement.classList.add('embedded-panel');
  const tab = createTab({ id: ctx.tabId });
  tab.label = ctx.label; tab.dbType = ctx.dbType;
  Object.assign(tab.state, { connected: true, connLabel: ctx.label, dbType: ctx.dbType,
    db: ctx.db, coll: ctx.coll, databases: ctx.databases,
    activeCollId: ctx.id, collTabs: [{ id: ctx.id, db: ctx.db, coll: ctx.coll, isDbTab: !ctx.coll, snapQuery: ctx.query || undefined }] });
  document.addEventListener('pointerdown', ctx.onFocus);
  document.addEventListener('focusin', ctx.onFocus);
  document.addEventListener('keydown', event => {
    if (ctx.onKey(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
}

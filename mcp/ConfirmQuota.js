'use strict';

const DEFAULTS = Object.freeze({
  principalCount: 20,
  principalBytes: 2 * 1024 * 1024,
  globalCount: 500,
  globalBytes: 32 * 1024 * 1024,
});

function costoValore(value, seen = new Set()) {
  if (value == null) return 4;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') + 8;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (typeof value === 'function') return 256;
  if (typeof value !== 'object') return 16;
  if (seen.has(value)) return 8;
  seen.add(value);
  let bytes = Array.isArray(value) ? 24 : 32;
  for (const [key, child] of Object.entries(value)) {
    bytes += Buffer.byteLength(key, 'utf8') + 8 + costoValore(child, seen);
  }
  return bytes;
}

class ConfirmQuota {
  constructor(limits = {}) {
    this.limits = { ...DEFAULTS, ...limits };
    this.global = { count: 0, bytes: 0 };
    this.principals = new Map();
  }

  reserve(principalId, payload) {
    const id = String(principalId || 'anonimo');
    const bytes = Math.max(1, costoValore(payload));
    const current = this.principals.get(id) || { count: 0, bytes: 0 };
    const overPrincipal = current.count + 1 > this.limits.principalCount
      || current.bytes + bytes > this.limits.principalBytes;
    const overGlobal = this.global.count + 1 > this.limits.globalCount
      || this.global.bytes + bytes > this.limits.globalBytes;
    if (overPrincipal || overGlobal) {
      const err = new Error('Quota conferme MCP superata: consuma o lascia scadere una conferma pendente prima di crearne un’altra.');
      err.code = 'MCP_CONFIRM_QUOTA_EXCEEDED';
      throw err;
    }
    this.principals.set(id, { count: current.count + 1, bytes: current.bytes + bytes });
    this.global.count += 1;
    this.global.bytes += bytes;
    return { principalId: id, bytes };
  }

  release(reservation) {
    if (!reservation || reservation.released) return;
    reservation.released = true;
    const current = this.principals.get(reservation.principalId);
    if (current) {
      current.count = Math.max(0, current.count - 1);
      current.bytes = Math.max(0, current.bytes - reservation.bytes);
      if (!current.count) this.principals.delete(reservation.principalId);
    }
    this.global.count = Math.max(0, this.global.count - 1);
    this.global.bytes = Math.max(0, this.global.bytes - reservation.bytes);
  }

  snapshot() {
    return {
      global: { ...this.global },
      principals: Object.fromEntries([...this.principals].map(([id, usage]) => [id, { ...usage }])),
    };
  }
}

module.exports = { ConfirmQuota, costoValore, DEFAULTS };

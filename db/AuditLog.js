/**
 * CodeDB
 * Copyright (c) 2026 Federico Ferrulli
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
'use strict';

/* ---------------------------------------------------------------------------
 * Audit log condiviso: una riga JSON per evento su un file append-only, con
 * rotazione automatica in generazioni numerate quando supera la soglia. Nato per le
 * scritture del gateway MCP (mcp/McpGateway.js), è ora riusato anche da
 * server.js per tracciare le operazioni critiche/di scrittura della Web UI su
 * un file separato (ui-audit.log). Un solo punto di verità per formato e
 * rotazione, così i due log restano coerenti.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

// Tetto delle voci tenute in RAM per la vista storica. Senza, la cache
// crescerebbe illimitata per tutta la vita del processo (una voce per ogni
// scrittura e lettura utente auditata): su un server long-running è un leak.
// La finestra è limitata anche in byte: aumentare la conservazione su disco
// non deve caricare gigabyte nel processo. Le omissioni sono dichiarate.
const MAX_CACHE_ENTRIES = 50000;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_TRIM_MARGIN = 1000;

// Crea un auditor legato a un file. `audit(entry)` è fire-and-forget: non deve
// mai bloccare né far fallire l'operazione tracciata. `readRecent(filtri)`
// rilegge il log (file ruotato + principale) per la vista storica della UI.
function makeAuditor(filePath, maxBytes = DEFAULT_MAX_BYTES, options = {}) {
  let maxGenerations = Number.isSafeInteger(options.maxGenerations) ? options.maxGenerations : 5;
  const maxCacheEntries = Number.isSafeInteger(options.maxCacheEntries)
    ? options.maxCacheEntries : MAX_CACHE_ENTRIES;
  const maxCacheBytes = options.maxCacheBytes || MAX_CACHE_BYTES;
  let cache = null;
  let cacheSizes = [], cacheBytes = 0;
  let truncated = false;
  let retentionDirty = false;
  let queue = Promise.resolve();
  let pending = 0;
  const health = { ok: true, pending: 0, lastError: null, lastFailureAt: null };

  // Mantiene la cache entro MAX_CACHE_ENTRIES scartando le voci più vecchie.
  // Interviene solo oltre un margine, così l'ammortamento evita uno shift a
  // ogni chiamata (le voci più vecchie restano comunque nel file su disco).
  function trimCache() {
    const margin = Math.min(CACHE_TRIM_MARGIN, Math.max(1, Math.ceil(maxCacheEntries / 10)));
    let remove = cache.length > maxCacheEntries + margin ? cache.length - maxCacheEntries : 0;
    for (let i = 0; i < remove; i++) cacheBytes -= cacheSizes[i];
    while (cacheBytes > maxCacheBytes && remove < cache.length) cacheBytes -= cacheSizes[remove++];
    if (remove) {
      cache.splice(0, remove);
      cacheSizes.splice(0, remove);
      truncated = true;
    }
  }

  // Legge dal fondo a blocchi, senza spezzare una sequenza UTF-8 fra due letture.
  function* newestLines(file) {
    const fd = fs.openSync(file, 'r');
    try {
      let position = fs.fstatSync(fd).size, remainder = Buffer.alloc(0), skip = false;
      while (position > 0) {
        const size = Math.min(65536, position);
        position -= size;
        const block = Buffer.alloc(size);
        fs.readSync(fd, block, 0, size, position);
        const data = Buffer.concat([block, remainder]);
        let end = data.length;
        for (let i = data.length - 1; i >= 0; i--) {
          if (data[i] !== 10) continue;
          if (skip) skip = false;
          else if (end > i + 1) yield data.subarray(i + 1, end).toString('utf8');
          end = i;
        }
        remainder = skip ? Buffer.alloc(0) : Buffer.from(data.subarray(0, end));
        if (remainder.length > maxCacheBytes) { remainder = Buffer.alloc(0); skip = true; truncated = true; }
      }
      if (remainder.length && !skip) yield remainder.toString('utf8');
    } finally { fs.closeSync(fd); }
  }

  function loadCache() {
    cache = [];
    cacheSizes = []; cacheBytes = 0;
    truncated = false;
    const files = [filePath];
    for (let generation = 1; generation <= maxGenerations; generation++) {
      files.push(`${filePath}.${generation}`);
    }
    history: for (const f of files) {
      try {
        for (const line of newestLines(f)) {
          if (!line.trim()) continue;
          const size = Buffer.byteLength(line);
          if (cache.length >= maxCacheEntries || cacheBytes + size > maxCacheBytes) { truncated = true; break history; }
          try {
            cache.push(JSON.parse(line)); cacheSizes.push(size); cacheBytes += size;
          } catch { truncated = true; }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          truncated = true;
          health.ok = false;
          health.lastError = err.message;
          health.lastFailureAt = new Date().toISOString();
        }
      }
    }
    cache.reverse(); cacheSizes.reverse();
  }

  async function ruota() {
    const generations = maxGenerations;
    if (generations < 1) return;
    try { await fs.promises.unlink(`${filePath}.${generations}`); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (let generation = generations - 1; generation >= 1; generation--) {
      try {
        await fs.promises.rename(`${filePath}.${generation}`, `${filePath}.${generation + 1}`);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    try { await fs.promises.rename(filePath, `${filePath}.1`); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // La cache deve avere la stessa conservazione dei file, anche prima del riavvio.
    cache = null;
  }

  async function persisti(fullEntry) {
    while (retentionDirty) {
      // Un aggiornamento durante l'I/O richiede un altro giro, non va perso.
      retentionDirty = false;
      const generations = maxGenerations;
      const directory = path.dirname(filePath), prefix = path.basename(filePath) + '.';
      try {
        for (const name of await fs.promises.readdir(directory)) {
          const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : '';
          if (/^[1-9]\d*$/.test(suffix) && Number(suffix) > generations) {
            await fs.promises.unlink(path.join(directory, name));
          }
        }
      } catch (err) {
        retentionDirty = true;
        throw err;
      }
      cache = null;
    }
    if (cache === null) loadCache();
    const line = JSON.stringify(fullEntry) + '\n';
    let size = 0;
    try { size = (await fs.promises.stat(filePath)).size; } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) await ruota();
    const cachePrima = cache;
    await fs.promises.appendFile(filePath, line, { encoding: 'utf8', flush: true });
    if (cache === null || cache !== cachePrima) loadCache();
    else {
      cache.push(fullEntry);
      cacheSizes.push(Buffer.byteLength(line)); cacheBytes += cacheSizes.at(-1);
      trimCache();
    }
  }

  function audit(entry) {
    const fullEntry = { ts: new Date().toISOString(), ...entry };
    pending += 1;
    health.pending = pending;
    const operation = queue.then(() => persisti(fullEntry));
    queue = operation.then(() => {
      health.ok = true;
      health.lastError = null;
      return { persisted: true };
    }, (err) => {
      health.ok = false;
      health.lastError = err.message;
      health.lastFailureAt = new Date().toISOString();
      return { persisted: false, error: err.message };
    }).finally(() => {
      pending -= 1;
      health.pending = pending;
    });
    return queue;
  }

  function readRecent(filters = {}) {
    if (cache === null) loadCache();
    const { limit = 200, offset = 0, event, db, connection, dbType, status, category, ownerId, userId } = filters;
    let entries = cache;

    // Isolamento multi-tenant: `ownerId`/`userId` non sono filtri di comodo come
    // gli altri ma il confine di visibilità dello Storico Azioni. Le voci prive
    // dell'identità (scritte da versioni precedenti, quando l'attore non veniva
    // registrato) restano visibili solo a chi non pone alcun filtro — cioè al
    // root: non è possibile attribuirle a un tenant, quindi non vanno mostrate.
    if (ownerId) entries = entries.filter((e) => e.ownerId === ownerId);
    if (userId) entries = entries.filter((e) => e.userId === userId);

    if (event) entries = entries.filter((e) => e.event === event);
    if (db) entries = entries.filter((e) => e.db === db);
    if (connection) entries = entries.filter((e) => e.connection === connection);
    if (dbType) entries = entries.filter((e) => e.dbType === dbType);
    if (status) entries = entries.filter((e) => e.status === status);
    if (category) entries = entries.filter((e) => e.category === category);

    const total = entries.length;
    const start = Math.max(0, offset);
    // Inverti per restituire i più recenti in cima
    const sliced = [];
    const end = Math.max(0, total - start);
    const begin = Math.max(0, end - Math.max(1, limit));
    for (let i = end - 1; i >= begin; i--) {
      sliced.push(entries[i]);
    }

    return { entries: sliced, total, truncated };
  }

  function updateOptions(next = {}) {
    const bytes = next.maxBytes ?? maxBytes;
    const generations = next.maxGenerations ?? maxGenerations;
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Dimensione del registro audit non valida.');
    if (!Number.isSafeInteger(generations) || generations < 1 || generations > 100) throw new Error('Numero di generazioni audit non valido.');
    maxBytes = bytes;
    maxGenerations = generations;
    retentionDirty = true;
    cache = null;
    return { maxBytes, maxGenerations };
  }

  async function flush() { await queue; return statoSalute(); }

  function statoSalute() { return { ...health }; }

  return { audit, readRecent, flush, statoSalute, filePath, updateOptions,
    options: () => ({ maxBytes, maxGenerations }) };
}

module.exports = { makeAuditor, DEFAULT_MAX_BYTES };

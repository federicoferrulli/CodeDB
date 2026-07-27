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
 * rotazione automatica in un file .1 quando supera la soglia. Nato per le
 * scritture del gateway MCP (mcp/McpGateway.js), è ora riusato anche da
 * server.js per tracciare le operazioni critiche/di scrittura della Web UI su
 * un file separato (ui-audit.log). Un solo punto di verità per formato e
 * rotazione, così i due log restano coerenti.
 * ------------------------------------------------------------------------- */

const fs = require('fs');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // oltre, si ruota un file .1 per non crescere indefinitamente

// Tetto delle voci tenute in RAM per la vista storica. Senza, la cache
// crescerebbe illimitata per tutta la vita del processo (una voce per ogni
// scrittura e lettura utente auditata): su un server long-running è un leak.
// Il cap copre ampiamente sia la paginazione della UI sia quanto il file
// ruotato (<file> + <file>.1) conserva su disco, quindi non cambia i risultati
// osservabili. Il trim è a lotti per non pagare un O(n) a ogni audit.
const MAX_CACHE_ENTRIES = 50000;
const CACHE_TRIM_MARGIN = 1000;

// Crea un auditor legato a un file. `audit(entry)` è fire-and-forget: non deve
// mai bloccare né far fallire l'operazione tracciata. `readRecent(filtri)`
// rilegge il log (file ruotato + principale) per la vista storica della UI.
function makeAuditor(filePath, maxBytes = DEFAULT_MAX_BYTES) {
  let cache = null;

  // Mantiene la cache entro MAX_CACHE_ENTRIES scartando le voci più vecchie.
  // Interviene solo oltre un margine, così l'ammortamento evita uno shift a
  // ogni chiamata (le voci più vecchie restano comunque nel file su disco).
  function trimCache() {
    if (cache.length > MAX_CACHE_ENTRIES + CACHE_TRIM_MARGIN) {
      cache.splice(0, cache.length - MAX_CACHE_ENTRIES);
    }
  }

  function loadCache() {
    cache = [];
    for (const f of [`${filePath}.1`, filePath]) {
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { cache.push(JSON.parse(line)); } catch { /* riga corrotta: ignora */ }
      }
    }
    trimCache();
  }

  function audit(entry) {
    const fullEntry = { ts: new Date().toISOString(), ...entry };
    if (cache === null) loadCache();
    cache.push(fullEntry);
    trimCache();

    const line = JSON.stringify(fullEntry);
    const append = () => fs.appendFile(filePath, line + '\n', () => { /* l'audit non deve mai bloccare */ });
    fs.stat(filePath, (err, stats) => {
      if (!err && stats.size > maxBytes) {
        fs.rename(filePath, `${filePath}.1`, append);
      } else {
        append();
      }
    });
  }

  function readRecent(filters = {}) {
    if (cache === null) loadCache();
    const { limit = 200, offset = 0, event, db, connection, dbType, status, category } = filters;
    let entries = cache;

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

    return { entries: sliced, total };
  }

  return { audit, readRecent, filePath };
}

module.exports = { makeAuditor, DEFAULT_MAX_BYTES };

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

// Crea un auditor legato a un file. `audit(entry)` è fire-and-forget: non deve
// mai bloccare né far fallire l'operazione tracciata. `readRecent(filtri)`
// rilegge il log (file ruotato + principale) per la vista storica della UI.
function makeAuditor(filePath, maxBytes = DEFAULT_MAX_BYTES) {
  function audit(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    const append = () => fs.appendFile(filePath, line + '\n', () => { /* l'audit non deve mai bloccare */ });
    fs.stat(filePath, (err, stats) => {
      if (!err && stats.size > maxBytes) {
        fs.rename(filePath, `${filePath}.1`, append);
      } else {
        append();
      }
    });
  }

  // Legge le voci applicando filtri opzionali (event/db/connection/dbType/
  // status/category) e paginazione (offset/limit). Legge prima il file ruotato
  // (.1, più vecchio) e poi il principale, così l'ordine cronologico è
  // preservato prima dell'inversione finale (più recenti in cima). Le righe
  // corrotte si saltano. Ritorna `{ entries, total }`: `total` è il numero di
  // voci che soddisfano i filtri (prima della paginazione), utile alla UI per
  // calcolare le pagine.
  function readRecent(filters = {}) {
    const { limit = 200, offset = 0, event, db, connection, dbType, status, category } = filters;
    let entries = [];
    for (const f of [`${filePath}.1`, filePath]) {
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* riga corrotta: ignora */ }
      }
    }
    if (event) entries = entries.filter((e) => e.event === event);
    if (db) entries = entries.filter((e) => e.db === db);
    if (connection) entries = entries.filter((e) => e.connection === connection);
    if (dbType) entries = entries.filter((e) => e.dbType === dbType);
    if (status) entries = entries.filter((e) => e.status === status);
    if (category) entries = entries.filter((e) => e.category === category);
    entries.reverse(); // più recenti in cima
    const total = entries.length;
    const start = Math.max(0, offset);
    return { entries: entries.slice(start, start + Math.max(1, limit)), total };
  }

  return { audit, readRecent, filePath };
}

module.exports = { makeAuditor, DEFAULT_MAX_BYTES };

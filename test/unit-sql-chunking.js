'use strict';

const assert = require('assert');

console.log('--- Test Unitari SqlChunker & USE Statement ---');

(async () => {
  // Mock di File / Blob per l'ambiente Node.js se necessario
  class NodeFakeFile {
    constructor(buffer, name) {
      this.buffer = Buffer.from(buffer);
      this.name = name;
      this.size = this.buffer.length;
    }
    slice(start, end) {
      const sliced = this.buffer.subarray(start, end);
      return {
        size: sliced.length,
        text: async () => sliced.toString('utf8')
      };
    }
  }

  // Importazione dinamica o require se convertito/testato
  const { SqlChunker, formatBytes } = await import('../public/js/sql-chunker.js');

  // Test 1: formatBytes helper
  assert.strictEqual(formatBytes(0), '0 B');
  assert.strictEqual(formatBytes(1024), '1 KB');
  assert.strictEqual(formatBytes(1048576), '1 MB');
  console.log('  OK   formatBytes helper superato');

  // Test 2: SqlChunker con file piccolo (<= 1MB)
  const smallContent = 'CREATE TABLE users (id INT PRIMARY KEY);\nINSERT INTO users VALUES (1);';
  const smallFile = new NodeFakeFile(smallContent, 'test_small.sql');
  const smallChunker = new SqlChunker(smallFile, 1024 * 1024);
  await smallChunker.init();

  assert.strictEqual(smallChunker.getChunkCount(), 1, 'File piccolo deve produrre 1 solo chunk');
  const smallChunk = await smallChunker.readChunk(0);
  assert.strictEqual(smallChunk.text, smallContent, 'Il contenuto del chunk unico deve essere identico');
  console.log('  OK   SqlChunker file piccolo superato');

  // Test 3: SqlChunker con file grande e allineamento al ';'
  // Generiamo un file di ~100 KB con chunk size fittizio di 20 KB per testare il chunking
  let largeText = '';
  for (let i = 0; i < 2000; i++) {
    largeText += `INSERT INTO logs VALUES (${i}, 'log message number ${i} with extra text to expand size');\n`;
  }
  const largeFile = new NodeFakeFile(largeText, 'large_dump.sql');
  const chunkSize = 20 * 1024; // 20 KB chunk
  const largeChunker = new SqlChunker(largeFile, chunkSize);
  await largeChunker.init();

  const count = largeChunker.getChunkCount();
  assert.ok(count > 1, `File grande deve essere suddiviso in più chunk (trovati ${count})`);

  // Verifica che ciascun chunk inizi e finisca su confini puliti (finisca con ';' o '\n')
  for (let i = 0; i < count; i++) {
    const chunk = await largeChunker.readChunk(i);
    assert.ok(chunk.text.length > 0, `Chunk ${i} non deve essere vuoto`);
    if (i < count - 1) {
      const trimmed = chunk.text.trim();
      assert.ok(trimmed.endsWith(';') || trimmed.endsWith('\n'), `Chunk ${i} deve terminare con ';' o newline per preservare la validità SQL`);
    }
  }
  console.log(`  OK   SqlChunker file grande (${count} chunk, allineamento ';') superato`);

  // Test 4: Parsing comandi USE <dbname>
  const useRegex = /^\s*(?:USE|use)\s+[`"]?([a-zA-Z0-9_\-]+)[`"]?\s*;?\s*$/i;
  assert.ok(useRegex.test('USE my_db;'), 'Sintassi "USE my_db;" deve essere riconosciuta');
  assert.ok(useRegex.test('use `my_db`'), 'Sintassi "use `my_db`" deve essere riconosciuta');
  assert.ok(useRegex.test('USE "analytics_db";'), 'Sintassi con doppi apici deve essere riconosciuta');
  const match = 'USE `sales_db`;'.match(useRegex);
  assert.strictEqual(match[1], 'sales_db', 'Deve estrarre il nome del database sales_db');
  console.log('  OK   Riconoscimento ed estrazione comando USE superato');

  console.log('Tutti i test unitari SqlChunker superati!');
})();

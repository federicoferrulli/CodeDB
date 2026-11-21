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
      return new Blob([sliced]);
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
  while (!largeChunker.complete) await largeChunker.ensureChunk(largeChunker.getChunkCount());

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

  // La coda del file da 6 GiB è volutamente inaccessibile. La prima lettura
  // deve riuscire e il costo iniziale deve rimanere indipendente dal totale.
  const bytes = Buffer.from("SELECT 'à🦊';\n".repeat(18000));
  let maxRead = 0;
  const enorme = { name: '6g.sql', size: 6 * 1024 ** 3, slice(start, end) {
    assert(end <= bytes.length, 'Il primo blocco attende la lettura del resto del file');
    maxRead = Math.max(maxRead, end);
    return new Blob([bytes.subarray(start, end)]);
  } };
  const progressivo = new SqlChunker(enorme, 1024 * 1024, 'mysql');
  const [primo, stesso] = await Promise.all([progressivo.readChunk(0), progressivo.readChunk(0), progressivo.init()]);
  assert.deepEqual(primo, stesso);
  assert.equal(maxRead, 64 * 1024);
  assert.equal(progressivo.getChunkCount(), 1);
  assert.equal(primo.totalChunks, null);
  assert.equal(primo.text, bytes.subarray(0, primo.endByte).toString('utf8'));
  console.log(`  OK   Prima anteprima di 6 GiB con letture entro ${formatBytes(maxRead)}`);

  const { splitStatementsDetailed } = require('../db/sqlText');
  const varianti = [
    ['mysql', "DELIMITER //\n" + "SELECT 'x'//\n".repeat(8200) + "DELIMITER ;\n" +
      "CREATE PROCEDURE proc() BEGIN SELECT 'a;b'; SELECT 2; END;\n" +
      "INSERT INTO t VALUES ('" + "è🦊;\n".repeat(18000) + "'); /*!40101 SET @v=1 */;"],
    ['postgresql', "\uFEFFSELECT 1;\nCREATE FUNCTION f() RETURNS text LANGUAGE sql AS $tag$ SELECT '" +
      "à🦊;\n".repeat(18000) + "' $tag$;\n/* annidato /* ; */ ; */\nSELECT 2"],
  ];
  for (const [dbms, sql] of varianti) {
    const opts = { dbms, backslashEscape: dbms === 'mysql' };
    const file = new SqlChunker(new NodeFakeFile(sql, dbms + '.sql'), 64 * 1024, dbms);
    const righe = [], parti = [];
    for (let i = 0; await file.ensureChunk(i); i++) {
      const data = await file.readChunk(i);
      parti.push(data.text);
      if (!data.statements) continue;
      const prefix = data.delimiter !== ';' ? `DELIMITER ${data.delimiter}\n` : '';
      righe.push(...splitStatementsDetailed(prefix + data.text, opts).map(s => s.sql));
    }
    assert.equal(parti.join(''), sql, 'Nessun byte perso o duplicato ai confini UTF-8');
    assert.deepEqual(righe, splitStatementsDetailed(sql, opts).map(s => s.sql),
      'Il driver deve ricevere le stesse istruzioni del file intero');
  }
  const denso = new SqlChunker(new Blob(['SELECT 1;'.repeat(24001)]), 1024 * 1024, 'mysql');
  while (!denso.complete) await denso.ensureChunk(denso.getChunkCount());
  for (const c of denso.chunks) assert(splitStatementsDetailed((await denso.readChunk(c.index)).text).length <= 10000);
  const soloCommenti = new SqlChunker(new Blob(['-- Dump completato\n']), 1024 * 1024, 'mysql');
  assert.equal((await soloCommenti.readChunk(0)).statements, 0);
  const commentoMysql = new SqlChunker(new Blob(['/*!40101 SET @salva=1 */;']), 1024 * 1024, 'mysql');
  assert.equal((await commentoMysql.readChunk(0)).statements, 1);
  const commentoMaria = new SqlChunker(new Blob(['/*M!100100 SET @salva=1 */;']), 1024 * 1024, 'mysql');
  assert.equal((await commentoMaria.readChunk(0)).statements, 1);
  const commentoPg = new SqlChunker(new Blob(['/*! commento */;']), 1024 * 1024, 'postgresql');
  assert.equal((await commentoPg.readChunk(0)).statements, 0);
  console.log('  OK   Istruzioni intere, UTF-8, routine, DELIMITER, commenti e conteggi su MySQL e PostgreSQL');

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

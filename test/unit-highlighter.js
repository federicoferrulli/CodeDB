'use strict';

const assert = require('assert');

console.log('--- Test Unitari Query Syntax Highlighter ---');

(async () => {
  const { highlightQueryCode } = await import('../public/js/query-highlighter.js');

  // Test 1: Evidenziazione Query SQL (DML & Clausole)
  const sql = "SELECT id, name FROM users WHERE status = 'active' AND age >= 18; -- commento";
  const sqlHighlighted = highlightQueryCode(sql, 'mysql');

  assert.ok(sqlHighlighted.includes('<span class="hl-keyword">SELECT</span>'), 'Parola chiave SELECT deve essere evidenziata');
  assert.ok(sqlHighlighted.includes('<span class="hl-keyword">FROM</span>'), 'Parola chiave FROM deve essere evidenziata');
  assert.ok(sqlHighlighted.includes('<span class="hl-string">&#39;active&#39;</span>') || sqlHighlighted.includes('<span class="hl-string">\'active\'</span>') || sqlHighlighted.includes("<span class=\"hl-string\">'active'</span>"), 'Stringa active deve essere evidenziata');
  assert.ok(sqlHighlighted.includes('<span class="hl-comment">-- commento</span>'), 'Commento SQL deve essere evidenziato');
  console.log('  OK   Evidenziazione sintassi SQL DML superata');

  // Test 2: Evidenziazione SQL DDL, Tipi e Funzioni
  const ddlSql = "CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(255), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);";
  const ddlHighlighted = highlightQueryCode(ddlSql, 'mysql');

  assert.ok(ddlHighlighted.includes('<span class="hl-keyword">CREATE</span>'), 'CREATE deve essere evidenziato');
  assert.ok(ddlHighlighted.includes('<span class="hl-keyword">TABLE</span>'), 'TABLE deve essere evidenziato');
  assert.ok(ddlHighlighted.includes('<span class="hl-type">INT</span>'), 'Tipo INT deve essere evidenziato');
  assert.ok(ddlHighlighted.includes('<span class="hl-type">VARCHAR</span>'), 'Tipo VARCHAR deve essere evidenziato');
  assert.ok(ddlHighlighted.includes('<span class="hl-type">TIMESTAMP</span>'), 'Tipo TIMESTAMP deve essere evidenziato');
  assert.ok(ddlHighlighted.includes('<span class="hl-keyword">PRIMARY</span>'), 'PRIMARY deve essere evidenziato');
  assert.ok(ddlHighlighted.includes('<span class="hl-keyword">KEY</span>'), 'KEY deve essere evidenziato');
  console.log('  OK   Evidenziazione sintassi SQL DDL, Tipi e Funzioni superata');

  // Test 3: Evidenziazione MQL (JSON)
  const mql = '[ { "$match": { "age": { "$gte": 18 }, "name": "Mario" } } ]';
  const mqlHighlighted = highlightQueryCode(mql, 'mongodb');

  assert.ok(mqlHighlighted.includes('<span class="hl-mql-op">&quot;$match&quot;</span>'), 'Operatore $match deve essere evidenziato');
  assert.ok(mqlHighlighted.includes('<span class="hl-mql-op">&quot;$gte&quot;</span>'), 'Operatore $gte deve essere evidenziato');
  assert.ok(mqlHighlighted.includes('<span class="hl-key">&quot;age&quot;</span>'), 'Chiave JSON "age" deve essere evidenziata');
  assert.ok(mqlHighlighted.includes('<span class="hl-number">18</span>'), 'Numero 18 deve essere evidenziato');
  console.log('  OK   Evidenziazione sintassi MQL (JSON) superata');

  // Test 4: Evidenziazione MongoShell
  const shell = 'db.users.find({ status: "active" }).sort({ created_at: -1 })';
  const shellHighlighted = highlightQueryCode(shell, 'mongodb');

  assert.ok(shellHighlighted.includes('<span class="hl-shell-db">db</span>'), 'Oggetto db deve essere evidenziato');
  assert.ok(shellHighlighted.includes('<span class="hl-shell-coll">users</span>'), 'Collezione users deve essere evidenziata');
  assert.ok(shellHighlighted.includes('<span class="hl-shell-method">find</span>'), 'Metodo find deve essere evidenziato');
  console.log('  OK   Evidenziazione sintassi MongoShell superata');

  // Test 5: Evidenziazione degli script JavaScript (interprete MongoDB)
  const js = 'const soglia = 10;\nfor (const d of db.c.find({}).toArray()) {\n  if (d.n > soglia) { print(d.n); }\n}';
  const jsHighlighted = highlightQueryCode(js, 'mongodb');

  assert.ok(jsHighlighted.includes('<span class="hl-keyword">const</span>'), 'const deve essere evidenziato');
  assert.ok(jsHighlighted.includes('<span class="hl-keyword">for</span>'), 'for deve essere evidenziato');
  assert.ok(jsHighlighted.includes('<span class="hl-keyword">of</span>'), 'of deve essere evidenziato');
  assert.ok(jsHighlighted.includes('<span class="hl-keyword">if</span>'), 'if deve essere evidenziato');
  assert.ok(jsHighlighted.includes('<span class="hl-function">print</span>'), 'print (funzione dell\'ambiente) deve essere evidenziata');
  // Un identificatore qualsiasi NON deve essere colorato come parola chiave.
  assert.ok(!/<span class="hl-keyword">soglia<\/span>/.test(jsHighlighted), 'un identificatore non è una parola chiave');
  console.log('  OK   Evidenziazione sintassi script JavaScript superata');

  // Test 6: le parole chiave JS sono riconosciute sul testo ESATTO, non in
  // maiuscolo: in JavaScript `LET` è un normale identificatore.
  const maiuscolo = highlightQueryCode('LET x = 1', 'mongodb');
  assert.ok(!/<span class="hl-keyword">LET<\/span>/.test(maiuscolo), 'LET non è una parola chiave JavaScript');
  console.log('  OK   Distinzione fra parole chiave JS e identificatori maiuscoli superata');

  console.log('Tutti i test unitari di Syntax Highlighting superati con successo!');
})();

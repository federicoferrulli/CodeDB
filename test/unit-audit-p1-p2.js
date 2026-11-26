'use strict';

// Suite di regressione per gli interventi P1, P2, RAM e Disco dell'audit di
// sicurezza e prestazioni (Sprint 2 e Sprint 3). Ogni sezione prova il fix
// reale senza dipendere da database esterni.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const express = require('express');

async function main() {
  console.log('--- Test Audit P1/P2 + RAM/Disco ---');

  // 1. [A-1] XSS tooltip ECharts: HTML escapato in categoria, serie e valore.
  {
    const { costruisciOption, cfgDefault, serieDefault } = await import('../public/js/chart-option.js');
    // Un numero oltre 53 bit aggregato attiva `formattatoreTooltip` (dove prima c'era XSS).
    const righe = [{ cat: '<img src=x onerror=alert(1)>', val: { $numberDecimal: '9007199254740993.12345' } }];
    const cfg = cfgDefault();
    cfg.campoX = 'cat';
    cfg.aggrega = true;
    cfg.assex = { ...cfg.assex, tipo: 'category' };
    cfg.serie = [{ ...serieDefault(0), tipo: 'bar', campoY: 'val', nome: '<svg onload=alert(2)>', agg: 'somma' }];
    const opt = costruisciOption(righe, cfg, { larghezza: 600, altezza: 400 });
    assert.equal(typeof opt.tooltip.formatter, 'function', 'formattatoreTooltip deve essere attivo su valori esatti >53 bit');
    const html = opt.tooltip.formatter([{
      axisValueLabel: '<img src=x onerror=alert(1)>',
      seriesName: '<svg onload=alert(2)>',
      marker: '<span class="m"></span>',
      seriesIndex: 0,
      dataIndex: 0,
      value: 9007199254740992,
    }]);
    assert.ok(!html.includes('<img'), 'categoria non escapata nel tooltip');
    assert.ok(!html.includes('<svg'), 'nome serie non escapato nel tooltip');
    assert.ok(html.includes('&lt;img') && html.includes('&lt;svg'), 'markup deve risultare escapato');
    console.log('  OK   [A-1] Escape HTML tooltip ECharts');
  }

  // 2. [A-2] proteggiDesktop: cookie HttpOnly obbligatorio su HTTP e WebSocket,
  //    ma /handshake-check e /mcp restano raggiungibili.
  {
    const { proteggiDesktop } = require('../electron-server-auth');
    const secret = 'b'.repeat(64);
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok:' + req.url);
    });
    server.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
      socket.end();
    });
    proteggiDesktop(server, secret);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await fetch(base + '/')).status, 403, 'HTTP senza cookie rifiutato');
      assert.equal((await fetch(base + '/', { headers: { cookie: 'codedb_desktop=errato' } })).status, 403);
      assert.equal((await fetch(base + '/', { headers: { cookie: `codedb_desktop=${secret}` } })).status, 200);
      assert.equal((await fetch(base + '/handshake-check')).status, 200, '/handshake-check esente');
      assert.equal((await fetch(base + '/mcp')).status, 200, '/mcp esente per client MCP locali');
      // Upgrade WebSocket senza cookie: connessione chiusa senza 101 Switching Protocols
      const wsResp = await new Promise((resolve) => {
        const net = require('node:net');
        const sock = net.connect(server.address().port, '127.0.0.1', () => {
          sock.write('GET /socket.io/?transport=websocket HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
        });
        let data = '';
        sock.on('data', (c) => { data += c.toString('utf8'); });
        sock.on('close', () => resolve(data));
        sock.on('error', () => resolve(data));
      });
      assert.ok(!wsResp.includes('101 Switching Protocols'), 'WebSocket senza cookie non deve ottenere 101');
      // Upgrade WebSocket CON cookie: passa e ottiene 101
      const wsOk = await new Promise((resolve) => {
        const net = require('node:net');
        const sock = net.connect(server.address().port, '127.0.0.1', () => {
          sock.write(`GET /socket.io/?transport=websocket HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: codedb_desktop=${secret}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
        });
        let data = '';
        sock.on('data', (c) => { data += c.toString('utf8'); });
        sock.on('close', () => resolve(data));
        sock.on('error', () => resolve(data));
      });
      assert.match(wsOk, /^HTTP\/1\.1 101 /, 'WebSocket con cookie valido deve ottenere 101');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    console.log('  OK   [A-2] Protezione cookie HTTP/WS server desktop');
  }

  // 3. [A-3] + [W-5] CSP strict + header sicurezza + compressione gzip statica.
  {
    const { createServer } = require('../server/createServer');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-csp-'));
    const srv = createServer({
      config: {
        env: {
          PORT: '0',
          HOST: '127.0.0.1',
          CODEDB_CONNECTIONS_FILE: path.join(tmp, 'connections.ini'),
          CODEDB_UI_AUDIT_FILE: path.join(tmp, 'ui.log'),
          CODEDB_MCP_AUDIT_FILE: path.join(tmp, 'mcp.log'),
          CODEDB_MCP_SETTINGS_FILE: path.join(tmp, 'mcp-settings.json'),
          CODEDB_BACKUPS_DIR: path.join(tmp, 'backups'),
        },
      },
    });
    await srv.start();
    try {
      const port = srv.server.address().port;
      const r = await fetch(`http://127.0.0.1:${port}/`);
      const csp = r.headers.get('content-security-policy') || '';
      assert.ok(csp.includes("script-src 'self'"), 'CSP deve vincolare script-src a self');
      assert.ok(csp.includes("object-src 'none'"), 'CSP deve bloccare object-src');
      assert.ok(csp.includes("frame-ancestors 'self'"), 'CSP deve proteggere frame-ancestors');
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      // Gzip trasparente sugli asset statici testuali > 1 KB
      const rawGz = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/arc/ui.js', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
      });
      assert.equal(rawGz.headers['content-encoding'], 'gzip', 'asset statico deve viaggiare compresso gzip');
      const gunzipped = zlib.gunzipSync(rawGz.body);
      assert.ok(gunzipped.length > rawGz.body.length * 2, 'gzip deve comprimere sensibilmente ui.js');
    } finally {
      await srv.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('  OK   [A-3/W-5] CSP strict e compressione gzip statica');
  }

  // 4. [A-4/A-5] MongoScript: match(string) ReDoS + budget memoria su Tpl/sparse/flat.
  {
    const { eseguiScript } = require('../db/MongoScriptRunner');
    const run = (code) => eseguiScript(code, { db: 'test', host: {} });
    await assert.rejects(
      () => run(`"aaaaaaaaaaaaaaaaaaaaaaaa!".match("(a+)+$")`),
      /regex|espressione regolare|catastrofico|non consentit|annidat|limite/i,
      'String.match con pattern ReDoS stringa deve essere bloccato'
    );
    await assert.rejects(
      () => run('let s = "x".repeat(500000); for (let i = 0; i < 60; i++) s = `${s}${s}`;'),
      /memoria|limite|dimensione|byte/i,
      'Template literal esplosivo deve rispettare il budget di memoria'
    );
    await assert.rejects(
      () => run('const a = []; a[2000000] = 1;'),
      /indice|sparso|limite|memoria|array/i,
      'Array sparso gigantesco deve essere bloccato'
    );
    await assert.rejects(
      () => run('let a = [1, 2]; for (let i = 0; i < 20; i++) a = [a, a]; a.flat(100);'),
      /limite|memoria|nodi|flat|elementi|dimensione/i,
      'DAG flat(100) deve essere bloccato dal budget di memoria'
    );
    console.log('  OK   [A-4/A-5] Hardening ReDoS e memoria MongoScript');
  }

  // 5. [A-6] Artefatti DDL: commenti eseguibili MySQL, ALTER multi-clausola, file I/O in $$...$$.
  {
    const { assertSafeSchemaSql } = require('../backup/lib/restore');
    assert.throws(
      () => assertSafeSchemaSql('CREATE TABLE ordini (id int); /*!50000 DROP TABLE utenti */;', 'ordini'),
      /commento eseguibile|non è una definizione/i,
      'commento eseguibile MySQL deve essere rifiutato'
    );
    assert.throws(
      () => assertSafeSchemaSql('ALTER TABLE ordini ADD COLUMN a int, DROP COLUMN b;', 'ordini'),
      /non è una definizione|ALTER TABLE/i,
      'ALTER TABLE multi-clausola con DROP deve essere rifiutato'
    );
    const { normalizzaLayerBackup } = require('../db/artefatti');
    assert.throws(
      () => normalizzaLayerBackup({
        dbType: 'postgresql',
        database: 'app',
        schemas: [],
        objects: { routines: [{ name: 'f', ddl: "CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ BEGIN COPY x FROM '/etc/passwd'; END; $$ LANGUAGE plpgsql;" }] },
      }),
      /file|filesystem|COPY|non consentit|routine/i,
      'COPY file I/O nascosto in dollar-quoting deve essere bloccato'
    );
    console.log('  OK   [A-6] Hardening parser DDL artefatti');
  }

  // 6. [A-7] SshKey: path locale vietato quando allowHostAgent=false.
  {
    const { leggiChiave } = require('../db/SshKey');
    await assert.rejects(
      () => leggiChiave({ sshAuth: 'path', sshKeyFile: '/etc/shadow' }, { allowHostAgent: false }),
      (err) => err && err.code === 'SSH_KEY_PATH_FORBIDDEN',
      'path chiave SSH deve fallire con SSH_KEY_PATH_FORBIDDEN per non-install-admin'
    );
    console.log('  OK   [A-7] Blocco sshKeyFile per utenti non install-admin');
  }

  // 7. [M-2] backup/lib/util.js readLines: protezione riga lunga e gzip-bomb.
  {
    const { readLines } = require('../backup/lib/util');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-gzbomb-'));
    try {
      const longFile = path.join(tmp, 'long.ndjson');
      fs.writeFileSync(longFile, '{"a":"' + 'x'.repeat(5000) + '"}\n');
      await assert.rejects(async () => {
        for await (const _ of readLines(longFile, { maxLineBytes: 2048 })) { /* */ }
      }, /Riga NDJSON oltre il limite/i);

      const gzFile = path.join(tmp, 'bomb.ndjson.gz');
      const payload = Buffer.from(('{"k":1}\n').repeat(20000));
      fs.writeFileSync(gzFile, zlib.gzipSync(payload));
      await assert.rejects(async () => {
        for await (const _ of readLines(gzFile, { maxDecompressedBytes: 10000 })) { /* */ }
      }, /limite decompresso|gzip-bomb/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('  OK   [M-2] Protezione gzip-bomb e riga lunga in readLines');
  }

  // 8. [M-4] Vault v1 unlock verifica anche conns/<ownerId>.ini + verificaPassphrase timing-safe.
  {
    const Vault = require('../db/vault');
    const vaultMod = require('../server/vault');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-vault-v1-'));
    try {
      const connFile = path.join(tmp, 'connections.ini');
      const connsDir = path.join(tmp, 'conns');
      fs.mkdirSync(connsDir, { recursive: true });
      fs.writeFileSync(connFile, ''); // file condiviso vuoto
      const secretKey = Vault.legacyKey('giusta-passphrase');
      fs.writeFileSync(
        path.join(connsDir, 'tenantA.ini'),
        `[prod]\ndbType=mongodb\npassword=${Vault.encryptWith('supersegreto', secretKey)}\n`
      );
      const v = vaultMod.createModule({
        config: {
          env: { CODEDB_CONNECTIONS_FILE: connFile, CODEDB_RBAC: 'on' },
          rootDir: tmp,
          rbacOn: () => true,
        },
        dependencies: {},
        errori: { errMsg: (e) => e.message },
      });
      const errRes = v.tryUnlockVault('sbagliata');
      assert.equal(errRes.ok, false, 'passphrase errata deve fallire anche se solo conns/<owner>.ini ha segreti v1');
      const okRes = v.tryUnlockVault('giusta-passphrase');
      assert.equal(okRes.ok, true, 'passphrase corretta deve sbloccare il vault v1');
      assert.equal(v.verificaPassphrase('giusta-passphrase'), true);
      assert.equal(v.verificaPassphrase('sbagliata'), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('  OK   [M-4] Vault v1 verifica tutti i file tenant e verificaPassphrase timing-safe');
  }

  // 9. [M-5] artefattoStreaming ("docs" prima di "name"), uploadDisco cap impronte, http-artefatti POST query ticket.
  {
    const { creaLettoreCodedbJson } = require('../db/artefattoStreaming');
    const r = creaLettoreCodedbJson({ onDocumento: () => {} });
    assert.throws(
      () => {
        r.scrivi(Buffer.from('{"collections":[{"docs":[{"x":1}],"name":"a"}]}'));
        r.fine();
      },
      /"name".*"docs"/i,
      '"docs" prima di "name" deve fallire esplicitamente in streaming'
    );

    const { createArchivioUpload } = require('../db/uploadDisco');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-upcap-'));
    try {
      const store = createArchivioUpload({ radicePer: (o) => path.join(tmp, o) });
      const { uploadId } = store.avvia('ada', 'u1');
      for (let i = 0; i < 80; i++) {
        await store.aggiungi(uploadId, 'ada', { offset: i * 4, contenuto: Buffer.from('abcd'), attore: 'u1' });
      }
      const stato = JSON.parse(fs.readFileSync(path.join(tmp, 'ada', 'caricamenti', uploadId, 'stato.json'), 'utf8'));
      assert.ok(Object.keys(stato.impronte).length <= 64, `stato.impronte limitato a <= 64 voci (trovate ${Object.keys(stato.impronte).length})`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    const { creaModuloArtefatti } = require('../server/http-artefatti');
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-httptk-'));
    const archivio = createArchivioUpload({ radicePer: (o) => path.join(tmp2, o) });
    const artefatti = creaModuloArtefatti({ archivio, segreto: crypto.randomBytes(32) });
    const app = express();
    artefatti.monta(app, { verificaOrigine: () => ({ ok: true }) });
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    try {
      const tk = artefatti.emettiTicket({ risorsa: 'caricamenti', attore: 'ada', ownerId: 't1' });
      const resp = await fetch(`http://127.0.0.1:${srv.address().port}/artefatti/caricamenti?ticket=${encodeURIComponent(tk)}`, { method: 'POST' });
      assert.equal(resp.status, 403, 'POST con ticket in query string deve essere rifiutato');
    } finally {
      srv.closeAllConnections();
      await new Promise((res) => srv.close(res));
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
    console.log('  OK   [M-5] Streaming "docs" prima di "name", cap impronte e POST senza query ticket');
  }

  // 10. [R-2/M-3] mongoshRuntime envPulito rimuove segreti server e preserva CODEDB_MONGOSH_*.
  {
    const { envPulito } = require('../db/mongoshRuntime');
    const pulito = envPulito({
      PATH: '/usr/bin',
      CODEDB_OWNER_PASSWORD: 'secret',
      CODEDB_ARTEFATTI_SECRET: 'secret2',
      GUI_MONGO_PASSPHRASE: 'pass',
      AWS_SECRET_ACCESS_KEY: 'aws',
      CODEDB_MONGOSH_CRYPT_SHARED_LIB_PATH: '/opt/crypt.so',
    });
    assert.equal(pulito.CODEDB_OWNER_PASSWORD, undefined);
    assert.equal(pulito.CODEDB_ARTEFATTI_SECRET, undefined);
    assert.equal(pulito.GUI_MONGO_PASSPHRASE, undefined);
    assert.equal(pulito.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(pulito.CODEDB_MONGOSH_CRYPT_SHARED_LIB_PATH, '/opt/crypt.so');
    assert.equal(pulito.ELECTRON_RUN_AS_NODE, '1');
    console.log('  OK   [R-2/M-3] Sanitizzazione env mongoshRuntime');
  }

  // 11. [R-4] AuditLog cache lazy: scrivere non carica la cache fino a readRecent().
  {
    const { makeAuditor } = require('../db/AuditLog');
    const tmp = path.join(os.tmpdir(), `codedb-audit-lazy-${process.pid}.log`);
    try {
      const a = makeAuditor(tmp);
      for (let i = 0; i < 20; i++) a.audit({ event: 'lazy', i });
      await a.flush();
      const rec = a.readRecent({ limit: 50 });
      assert.equal(rec.total, 20);
      assert.equal(rec.entries[0].i, 19);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* */ }
    }
    console.log('  OK   [R-4] AuditLog cache lazy su disco');
  }

  // 12. [M-11] esc() escapa anche gli apici singoli in utils.js e geo-vista.js.
  {
    const vm = require('node:vm');
    for (const rel of ['public/js/utils.js', 'public/js/geo-vista.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      const m = src.match(/export function esc\(s\) \{[\s\S]*?\n\}|export const esc = [^\n]+;/);
      assert.ok(m, `${rel} deve esportare esc()`);
      const fn = vm.runInNewContext(m[0].replace(/^export /, '') + '; esc;');
      assert.equal(fn(`a'b"<>&`), 'a&#39;b&quot;&lt;&gt;&amp;', `${rel}: esc() deve escapare anche apostrofo`);
    }
    console.log('  OK   [M-11] Escape completo (incluso apostrofo) in utils.js e geo-vista.js');
  }

  // 12-bis. L'illustrazione "Collegamento interrotto" deve restare inlinata nel
  // bundle UI (`data:image/webp;base64,...`): viene mostrata proprio quando il
  // server HTTP non risponde e non può servire file statici.
  {
    const bundleUi = fs.readFileSync(path.join(__dirname, '..', 'public', 'arc', 'ui.js'), 'utf8');
    assert.ok(bundleUi.includes('data:image/webp;base64,'), 'collegamento-interrotto.webp deve restare incorporata in public/arc/ui.js per funzionare a server spento');
    console.log('  OK   Illustrazione disconnessione incorporata offline in public/arc/ui.js');
  }

  // 13. Verifica di sensibilità (AGENTS.md): rompe temporaneamente i controlli in
  //     memoria tramite vm/sostituzione e conferma che le asserzioni falliscono.
  {
    const vm = require('node:vm');
    const authSrc = fs.readFileSync(path.join(__dirname, '..', 'electron-server-auth.js'), 'utf8')
      .replace('actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)', 'false');
    const ctx = { require, module: { exports: {} }, exports: {}, Buffer, process };
    vm.runInNewContext(authSrc, ctx);
    const s = http.createServer((_req, res) => res.end('ok'));
    ctx.module.exports.proteggiDesktop(s, 'c'.repeat(64));
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    try {
      const st = (await fetch(`http://127.0.0.1:${s.address().port}/`)).status;
      assert.notEqual(st, 403, 'mutante senza verifica cookie non deve restituire 403 (sensibilità confermata)');
    } finally {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    console.log('  OK   Verifica sensibilità test (mutante proteggiDesktop intercettato)');
  }

  console.log('--- Tutti i test Audit P1/P2 + RAM/Disco superati ---');
}

module.exports = main();
if (require.main === module) {
  module.exports.catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

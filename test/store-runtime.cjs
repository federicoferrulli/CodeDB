'use strict';
const assert = require('node:assert/strict');
const { setTimeout: pausa } = require('node:timers/promises');

(async () => {
  const porta = Number(process.argv[2]);
  assert(Number.isInteger(porta) && porta > 0 && porta < 65536);
  let endpoint;
  for (let tentativo = 0; tentativo < 60 && !endpoint; tentativo++) {
    try { endpoint = (await (await fetch(`http://127.0.0.1:${porta}/json/list`, { signal: AbortSignal.timeout(1000) })).json())[0]?.webSocketDebuggerUrl; }
    catch { await pausa(1000); }
  }
  assert(endpoint, 'Inspector del processo AppX non raggiungibile');
  const socket = new WebSocket(endpoint);
  try {
    const risposta = await new Promise((resolve, reject) => {
      const limite = setTimeout(() => reject(Error('Timeout collaudo AppX')), 90000);
      socket.addEventListener('error', reject, { once: true });
      socket.addEventListener('message', ({ data }) => {
        const msg = JSON.parse(data); if (msg.id !== 1) return;
        clearTimeout(limite);
        if (msg.error || msg.result.exceptionDetails) reject(Error(JSON.stringify(msg.error || msg.result.exceptionDetails)));
        else resolve(msg.result.result.value);
      });
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        awaitPromise: true, returnByValue: true,
        expression: `(${async function () {
          const { createRequire } = process.getBuiltinModule('module');
          const path = process.getBuiltinModule('path');
          const carica = createRequire(path.join(process.resourcesPath, 'app.asar', 'package.json'));
          const { app, BrowserWindow } = carica('electron');
          await app.whenReady();
          let pagina;
          for (let i = 0; i < 60; i++) {
            const w = BrowserWindow.getAllWindows()[0];
            if (w && !w.webContents.isLoading()) {
              try { if (await w.webContents.executeJavaScript('document.documentElement.dataset.arcReady === "true"')) { pagina = w.webContents.getURL(); break; } } catch {}
            }
            await new Promise(r => setTimeout(r, 1000));
          }
          for (const base of [carica, createRequire(carica.resolve('@mongosh/service-provider-node-driver'))]) {
            base('kerberos'); base('mongodb-client-encryption');
          }
          const vault = carica('./db/vault.js');
          const fs = process.getBuiltinModule('fs');
          const directory = fs.mkdtempSync(path.join(app.getPath('userData'), 'collaudo-vault-'));
          let valido;
          try {
            const file = path.join(directory, 'connections.ini');
            const { meta, dataKey } = vault.createMeta('passphrase usa e getta');
            vault.writeMeta(file, meta);
            const chiave = vault.unwrapDataKey(vault.readMeta(file), 'passphrase usa e getta');
            valido = vault.decryptWith(vault.encryptWith('segreto di prova', dataKey), chiave) === 'segreto di prova';
          } finally { fs.rmSync(directory, { recursive: true, force: true }); }
          return { store: process.windowsStore, packaged: app.isPackaged, pagina, valido, userData: app.getPath('userData'), connections: process.env.CODEDB_CONNECTIONS_FILE };
        }.toString()})()`,
      } })), { once: true });
    });
    assert.equal(risposta.store, true, 'Il processo deve avere identità AppX reale');
    assert.equal(risposta.packaged, true);
    assert.equal(new URL(risposta.pagina).hostname, '127.0.0.1');
    assert.equal(risposta.valido, true);
    assert.match(risposta.userData, /CodeDB Store$/);
    assert.equal(require('node:path').dirname(risposta.connections), risposta.userData);
    console.log('OK AppX installato: identità Store reale, server autonomo, frontend, addon Kerberos/CSFLE e vault cifrato persistente.');
  } finally { socket.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });

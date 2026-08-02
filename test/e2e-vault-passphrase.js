'use strict';

/* ---------------------------------------------------------------------------
 * Test E2E del cambio passphrase del vault.
 *
 * È la funzione che tocca l'unica copia su disco delle credenziali salvate:
 * qui si verifica che dopo ogni operazione i segreti siano ancora leggibili,
 * che la vecchia passphrase smetta di funzionare e che un tentativo non
 * autorizzato o sbagliato non lasci il vault in uno stato peggiore.
 *
 * Nessun database richiesto: si lavora su un vault temporaneo, mai su quello
 * reale dell'utente.
 *
 * Uso: node test/e2e-vault-passphrase.js
 * ------------------------------------------------------------------------- */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { io } = require('socket.io-client');
const Vault = require('../db/vault');

const PORT = parseInt(process.env.VAULT_E2E_PORT, 10) || 3155;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-vault-e2e-'));
const ini = path.join(dir, 'connections.ini');
fs.writeFileSync(ini, '', 'utf8');

let falliti = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  OK   ${label}`);
  else { console.error(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); falliti++; }
}

const ping = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 700 }, (r) => { r.resume(); resolve(true); });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

async function avvia(passphrase) {
  const env = {
    ...process.env,
    PORT: String(PORT), HOST: '127.0.0.1', CODEDB_RBAC: 'off',
    CODEDB_CONNECTIONS_FILE: ini,
    CODEDB_CONNECTIONS_DIR: path.join(dir, 'conns'),
    CODEDB_UI_AUDIT_FILE: path.join(dir, 'ui.log'),
    CODEDB_MCP_AUDIT_FILE: path.join(dir, 'mcp.log'),
    CODEDB_BACKUPS_DIR: path.join(dir, 'backups'),
  };
  if (passphrase === null) delete env.GUI_MONGO_PASSPHRASE;
  else env.GUI_MONGO_PASSPHRASE = passphrase;

  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let codice = null;
  proc.stdout.on('data', (b) => { out += b; });
  proc.stderr.on('data', (b) => { out += b; });
  proc.on('exit', (c) => { codice = c; });

  const fine = Date.now() + 15000;
  while (Date.now() < fine) {
    if (codice !== null) return { proc, avviato: false, codice, out: () => out };
    if (await ping()) return { proc, avviato: true, codice: null, out: () => out };
    await new Promise((r) => setTimeout(r, 200));
  }
  return { proc, avviato: false, codice, out: () => out };
}

async function ferma(h) {
  if (h && h.codice === null) {
    h.proc.kill();
    await new Promise((r) => setTimeout(r, 400));
  }
}

const connetti = () => new Promise((res, rej) => {
  const s = io(`http://127.0.0.1:${PORT}`);
  s.once('connect', () => res(s));
  s.once('connect_error', rej);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));

const SEGRETO = 'p4ssw0rd-del-database';

(async () => {
  console.log('--- Test E2E cambio passphrase del vault ---');
  let h = null;
  let s = null;

  try {
    console.log('1. Vault iniziale senza passphrase, con una connessione salvata');
    h = await avvia(null);
    assert(h.avviato, 'server avviato');
    s = await connetti();
    const salva = await emit(s, 'connections:save', {
      name: 'prod',
      cfg: { dbType: 'mongodb', host: 'localhost', port: '27017', username: 'u', password: SEGRETO },
    });
    assert(salva.ok, 'connessione salvata', salva.error);
    const testo = fs.readFileSync(ini, 'utf8');
    assert(/password\s*=\s*ENC:/.test(testo), 'la password è cifrata');
    assert(!testo.includes(SEGRETO), 'il segreto non compare in chiaro');

    const stato0 = await emit(s, 'vault:status', {});
    assert(stato0.formato === 1, `vault nel formato storico (v1) — formato=${stato0.formato}`);

    console.log('2. Validazioni del cambio passphrase');
    const vuota = await emit(s, 'vault:setPassphrase', { current: '', next: '' });
    assert(!vuota.ok && /vuota/i.test(vuota.error || ''), 'passphrase vuota rifiutata', vuota.error);

    const attualeSbagliata = await emit(s, 'vault:setPassphrase', { current: 'non-e-questa', next: 'nuova-passphrase' });
    assert(!attualeSbagliata.ok && /attuale non è corretta/i.test(attualeSbagliata.error || ''),
      'passphrase attuale errata rifiutata', attualeSbagliata.error);

    const dopoTentativi = fs.readFileSync(ini, 'utf8');
    assert(dopoTentativi === testo, 'i tentativi rifiutati non hanno toccato il vault');

    console.log('3. Primo cambio: migrazione al formato a busta');
    const cambio = await emit(s, 'vault:setPassphrase', { current: '', next: 'passphrase-uno' });
    assert(cambio.ok, 'cambio riuscito', cambio.error);
    assert(cambio.migrated === true, 'segnalata la migrazione del vault');

    const meta = Vault.readMeta(ini);
    assert(!!meta && meta.version === 2, 'metadati del vault v2 creati');
    assert(!!meta && meta.kdf === 'scrypt' && !!meta.salt, 'derivazione scrypt con salt');
    assert(fs.existsSync(`${ini}.pre-vault2`), 'copia di sicurezza pre-migrazione presente');

    const statoDopo = await emit(s, 'vault:status', {});
    assert(statoDopo.formato === 2 && statoDopo.locked === false, 'vault v2 e sbloccato');

    const listaSubito = await emit(s, 'connections:list', {});
    assert(listaSubito.ok && listaSubito.connections.some((c) => c.name === 'prod'),
      'le connessioni restano utilizzabili senza riavvio');
    s.close();
    await ferma(h);

    console.log('4. Riavvio: la NUOVA passphrase apre, la vecchia no');
    h = await avvia('passphrase-uno');
    assert(h.avviato, 'server avviato con la nuova passphrase', h.out());
    if (h.avviato) {
      s = await connetti();
      const st = await emit(s, 'vault:status', {});
      assert(st.locked === false, 'vault sbloccato');
      const l = await emit(s, 'connections:list', {});
      assert(l.ok && l.connections.some((c) => c.name === 'prod'), 'connessione ancora presente');
      s.close();
    }
    await ferma(h);

    h = await avvia(null);
    assert(h.avviato, 'senza passphrase il server parte comunque');
    if (h.avviato) {
      s = await connetti();
      const st = await emit(s, 'vault:status', {});
      assert(st.locked === true, 'senza la passphrase il vault risulta bloccato', JSON.stringify(st));
      const bloccato = await emit(s, 'vault:setPassphrase', { current: '', next: 'altra-ancora' });
      assert(!bloccato.ok && /bloccato/i.test(bloccato.error || ''),
        'a vault bloccato il cambio è rifiutato', bloccato.error);
      const sblocco = await emit(s, 'vault:unlock', { passphrase: 'passphrase-uno' });
      assert(sblocco.ok, 'sblocco con la nuova passphrase', sblocco.error);
      s.close();
    }
    await ferma(h);

    console.log('5. Secondo cambio su vault v2: i segreti NON vengono riscritti');
    h = await avvia('passphrase-uno');
    assert(h.avviato, 'server avviato');
    s = await connetti();
    const iniPrima = fs.readFileSync(ini, 'utf8');
    const metaPrima = fs.readFileSync(Vault.metaFileFor(ini), 'utf8');

    const secondo = await emit(s, 'vault:setPassphrase', { current: 'passphrase-uno', next: 'passphrase-due' });
    assert(secondo.ok, 'secondo cambio riuscito', secondo.error);
    assert(secondo.migrated === false, 'nessuna migrazione: il vault era già v2');

    const iniDopo = fs.readFileSync(ini, 'utf8');
    assert(iniDopo === iniPrima,
      'connections.ini INVARIATO: cambiare passphrase non tocca i segreti');
    assert(fs.readFileSync(Vault.metaFileFor(ini), 'utf8') !== metaPrima,
      'i metadati del vault sono stati riscritti');
    s.close();
    await ferma(h);

    console.log('6. Solo la passphrase più recente apre il vault');
    h = await avvia('passphrase-uno');
    assert(!h.avviato && h.codice === 1, 'la passphrase precedente non apre più (exit 1)', `codice=${h.codice}`);
    await ferma(h);

    h = await avvia('passphrase-due');
    assert(h.avviato, 'la passphrase corrente apre il vault');
    if (h.avviato) {
      s = await connetti();
      const l = await emit(s, 'connections:list', {});
      assert(l.ok && l.connections.some((c) => c.name === 'prod'), 'connessione integra dopo due cambi');
      s.close();
    }
    await ferma(h);

    console.log('7. La CLI di backup legge il vault nel nuovo formato');
    // `loadConnections` della CLI deve restituire il segreto IN CHIARO: è la
    // prova che server e CLI condividono davvero la stessa crittografia.
    const risultato = spawnSync(process.execPath, ['-e', `
      process.env.CODEDB_CONNECTIONS_FILE = ${JSON.stringify(ini)};
      const { loadConnections } = require(${JSON.stringify(path.join(__dirname, '..', 'backup', 'lib', 'connstore.js'))});
      const c = loadConnections('passphrase-due');
      console.log(c.prod && c.prod.password === ${JSON.stringify(SEGRETO)} ? 'OK' : 'KO:' + (c.prod && c.prod.password));
    `]);
    const uscita = String(risultato.stdout || '').trim();
    assert(uscita === 'OK', 'la CLI di backup decifra il segreto', uscita || String(risultato.stderr || ''));

    const cliSbagliata = spawnSync(process.execPath, ['-e', `
      process.env.CODEDB_CONNECTIONS_FILE = ${JSON.stringify(ini)};
      const { loadConnections } = require(${JSON.stringify(path.join(__dirname, '..', 'backup', 'lib', 'connstore.js'))});
      try { loadConnections('sbagliata'); console.log('NESSUN-ERRORE'); }
      catch (e) { console.log('ERRORE:' + e.message); }
    `]);
    const uscita2 = String(cliSbagliata.stdout || '').trim();
    assert(/^ERRORE:/.test(uscita2) && /non si apre|errata/i.test(uscita2),
      'la CLI rifiuta una passphrase errata con un messaggio chiaro', uscita2);
  } catch (err) {
    console.error('Errore durante i test:', (err && err.stack) || err);
    falliti++;
  } finally {
    if (s) { try { s.close(); } catch { /* già chiuso */ } }
    await ferma(h);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignora */ }
  }

  if (falliti) {
    console.error(`\n--- ${falliti} test FALLITI ---`);
    process.exitCode = 1;
  } else {
    console.log('\n--- Tutti i test del cambio passphrase superati! ---');
  }
})();

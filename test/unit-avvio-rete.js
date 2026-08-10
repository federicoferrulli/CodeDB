'use strict';

/* ---------------------------------------------------------------------------
 * Barriere all'avvio: esporre CodeDB in rete richiede DUE dichiarazioni
 * distinte, non una (CDB-A06).
 *
 * `CODEDB_TRUST_PROXY_TLS=1` significa «davanti c'è un proxy HTTPS», non
 * «l'accesso è autenticato»: con quella sola variabile — impostata a 1
 * nell'immagine Docker e come default nel compose, mentre CODEDB_RBAC vale
 * `off` — il server partiva con un avviso nel log e chiunque raggiungesse la
 * porta otteneva ROOT_PRINCIPAL, cioè lettura, scrittura, DDL, backup ed export
 * del vault senza credenziali.
 *
 * Ogni caso avvia un processo vero: la decisione sta nel percorso di avvio, e
 * verificarla su una funzione esportata proverebbe la funzione, non l'avvio.
 * Non serve alcun database: il rifiuto arriva prima di qualunque connessione, e
 * nei casi ammessi il processo viene fermato appena si è visto che parte.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
// Porta improbabile e file di connessioni usa e getta: nei casi ammessi il
// processo apre davvero la porta, e non deve toccare il vault reale.
const PORT = String(3937);
const CONNS = path.join(os.tmpdir(), `codedb-avvio-rete-${process.pid}.ini`);

function avvia(env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        CODEDB_RBAC: 'off',
        CODEDB_TRUST_PROXY_TLS: '',
        CODEDB_ALLOW_UNAUTHENTICATED_NETWORK: '',
        CODEDB_PUBLIC_BIND: '',
        GUI_MONGO_PASSPHRASE: '',
        CODEDB_CONNECTIONS_FILE: CONNS,
        CODEDB_NO_UPDATE_CHECK: '1',
        PORT,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let esito = null;
    // Non si attende un tempo fisso: la decisione si legge dall'output.
    // "in ascolto su" = ha superato le barriere (e lo si ferma subito);
    // uscita con codice 1 = rifiutato. Un'attesa a tempo rendeva il test
    // ballerino, perché prima di assertTransportSafe il server sonda il vault
    // e può inizializzare il control plane.
    const guarda = (b) => {
      out += b;
      if (esito === null && /in ascolto su/.test(out)) {
        esito = { rifiutato: false, out };
        proc.kill();
      }
    };
    proc.stdout.on('data', guarda);
    proc.stderr.on('data', guarda);

    const timer = setTimeout(() => { esito = esito || { rifiutato: false, out }; proc.kill(); }, 20000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(esito || { rifiutato: code === 1, out });
    });
  });
}

(async () => {
  // 1. Uso locale: nessuna barriera, è il caso di ogni giorno.
  {
    const r = await avvia({ HOST: '127.0.0.1' });
    assert.strictEqual(r.rifiutato, false, 'su loopback il server deve partire');
  }

  // 2. Fuori dal loopback senza dichiarare il proxy HTTPS: rifiuto (già prima).
  {
    const r = await avvia({ HOST: '0.0.0.0' });
    assert.strictEqual(r.rifiutato, true, 'fuori dal loopback senza TLS: avvio rifiutato');
    assert.ok(/parla solo HTTP/.test(r.out), 'il motivo deve essere il trasporto in chiaro');
  }

  // 3. IL BUCO: proxy HTTPS dichiarato ma nessuna autenticazione. Prima
  //    partiva con un avviso; ora è un rifiuto.
  {
    const r = await avvia({ HOST: '0.0.0.0', CODEDB_TRUST_PROXY_TLS: '1' });
    assert.strictEqual(r.rifiutato, true, 'in rete con RBAC spento: avvio rifiutato');
    assert.ok(/NON c'è autenticazione/.test(r.out), 'il motivo deve essere l\'assenza di autenticazione');
    assert.ok(/CODEDB_ALLOW_UNAUTHENTICATED_NETWORK=1/.test(r.out), 'e deve indicare la via d\'uscita esplicita');
  }

  // 4. La via d'uscita esiste, è distinta e si fa sentire a ogni avvio.
  {
    const r = await avvia({
      HOST: '0.0.0.0', CODEDB_TRUST_PROXY_TLS: '1', CODEDB_ALLOW_UNAUTHENTICATED_NETWORK: '1',
    });
    assert.strictEqual(r.rifiutato, false, 'con la dichiarazione esplicita il server parte');
    assert.ok(/SENZA AUTENTICAZIONE/.test(r.out), 'e lo dichiara nel log a ogni avvio');
  }

  // 5. Container pubblicato su loopback: HOST=0.0.0.0 è l'indirizzo INTERNO,
  //    quindi non è esposizione e non deve bloccare `docker compose up`.
  {
    const r = await avvia({ HOST: '0.0.0.0', CODEDB_PUBLIC_BIND: '127.0.0.1' });
    assert.strictEqual(r.rifiutato, false, 'porta pubblicata su loopback: nessuna barriera');
  }

  // 6. Stesso container, ma pubblicato in rete: è CODEDB_PUBLIC_BIND a
  //    decidere, non HOST — altrimenti i due casi sarebbero indistinguibili.
  {
    const r = await avvia({ HOST: '0.0.0.0', CODEDB_PUBLIC_BIND: '0.0.0.0', CODEDB_TRUST_PROXY_TLS: '1' });
    assert.strictEqual(r.rifiutato, true, 'porta pubblicata in rete senza RBAC: avvio rifiutato');
  }

  console.log('  OK   Esposizione in rete: TLS e autenticazione sono due dichiarazioni distinte (CDB-A06)');
})().catch((err) => {
  console.error('  FAIL', err && err.message);
  process.exitCode = 1;
});

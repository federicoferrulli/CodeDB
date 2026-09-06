'use strict';

// CodeDB — trasporto. Stato e dipendenze appartengono alla singola istanza.
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { provaClient, provaServer, stessaProva } = require('../electron-server-auth');

function createModule({ config }) {
  const ELECTRON_INSTANCE_SECRET = config.env.CODEDB_ELECTRON_INSTANCE_SECRET
    || (config.desktop && config.desktop.instanceSecret)
    || null;

  const PORT = config.env.PORT ?? 3030;

  const app = express();

  // Reverse proxy davanti a CodeDB (CDB-19): senza questa impostazione `req.ip` è
  // l'indirizzo del PROXY, uguale per tutti, quindi il freno ai tentativi di login
  // diventa un blocco globale — cinque password sbagliate di chiunque chiudono
  // l'accesso a tutti. Con essa, Express legge X-Forwarded-For.
  //
  // È legata a CODEDB_TRUST_PROXY_TLS=1 e non attiva per default di proposito:
  // fidarsi di quell'header senza un proxy davanti è peggio del problema che
  // risolve, perché l'indirizzo diventa scrivibile dal client e il rate limit si
  // aggira cambiandolo a ogni tentativo. La variabile esiste già ed è esattamente
  // la dichiarazione "c'è un proxy davanti" (vedi assertTransportSafe).
  //
  // Si dichiara il NUMERO DI HOP fidati, mai `true` (CDB-71). Con `true` Express
  // risale l'intera catena di X-Forwarded-For e prende il valore più a sinistra —
  // che è quello scritto dal CLIENT, non dal proxy: il freno ai tentativi di
  // accesso tornerebbe aggirabile cambiando l'header a ogni richiesta, e stavolta
  // di proposito. Con un numero, Express scarta esattamente quegli hop e legge
  // l'indirizzo che il proxy ha inserito. Chi ha due proxy in cascata (CDN +
  // ingress) alza CODEDB_TRUST_PROXY_HOPS di conseguenza.
  if (String(config.env.CODEDB_TRUST_PROXY_TLS || '').trim() === '1') {
    const hops = parseInt(config.env.CODEDB_TRUST_PROXY_HOPS, 10);
    app.set('trust proxy', Number.isFinite(hops) && hops > 0 ? hops : 1);
  }

  const server = http.createServer(app);

  /* ---------------------------------------------------------------------------
   * Gate sull'Origin dell'handshake Socket.IO (Cross-Site WebSocket Hijacking).
   *
   * Il CORS NON protegge il transport WebSocket: senza controllo, qualunque pagina
   * web aperta nel browser dell'utente poteva fare
   *
   *     io('http://127.0.0.1:3030', { transports: ['websocket'] })
   *
   * e usare l'intera API. Con CODEDB_RBAC spento (default, e sempre nell'app
   * Electron) l'handshake assegna ROOT_PRINCIPAL: lettura, scrittura e DDL su
   * tutte le connessioni salvate, export del vault, backup su percorsi scelti da
   * chi attacca. L'endpoint /mcp aveva già `guardHost`, il canale principale no.
   *
   * REGOLA
   *  · Origin assente (app Electron, client CLI, curl) → si applica lo stesso
   *    controllo anti DNS-rebinding di /mcp sull'header Host.
   *  · CODEDB_ALLOWED_ORIGINS impostata → whitelist esplicita, punto.
   *  · Altrimenti → è consentito l'Origin il cui host coincide con l'Host della
   *    richiesta. È esattamente ciò che distingue un accesso diretto ("ho aperto
   *    io questa pagina") da una richiesta cross-site, e continua a funzionare
   *    quando si raggiunge CodeDB da un'altra macchina o dietro un reverse proxy,
   *    cosa che una whitelist fissa su localhost avrebbe rotto.
   * Il rifiuto porta un messaggio che dice cosa fare, non un errore muto.
   * ------------------------------------------------------------------------- */
  const LOCAL_HOST_HEADER = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

  function allowedOriginList() {
    return String(config.env.CODEDB_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean);
  }

  /**
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  function checkOrigin(req) {
    const origin = String((req.headers && req.headers.origin) || '').trim();
    const host = String((req.headers && req.headers.host) || '').trim();
    const allowed = allowedOriginList();
    const bindHost = String(config.env.HOST || '127.0.0.1').toLowerCase();
    const loopbackBind = ['127.0.0.1', 'localhost', '::1'].includes(bindHost);

    // Origin e Host sono entrambi controllati dal browser che visita un dominio
    // ostile. Accettare soltanto perché coincidono consentirebbe il DNS rebinding
    // (evil.example -> 127.0.0.1). Su loopback, in assenza di una whitelist
    // esplicita per il reverse proxy, l'Host deve quindi essere davvero locale.
    if (loopbackBind && !allowed.length && !LOCAL_HOST_HEADER.test(host)) {
      return { ok: false, reason: `header Host ${host} non consentito su un'istanza in ascolto solo su loopback` };
    }

    if (!origin) {
      // Nessun Origin: non è una richiesta partita da una pagina web. Resta però
      // il DNS-rebinding, in cui un dominio ostile risolve a 127.0.0.1: l'Host
      // continua a essere quello ostile, quindi lo si pretende locale — ma solo
      // se il server è in ascolto su loopback (altrimenti si romperebbe l'accesso
      // legittimo da un'altra macchina).
      if (!loopbackBind || LOCAL_HOST_HEADER.test(host)) return { ok: true };
      return { ok: false, reason: `header Host "${host}" non consentito su un'istanza in ascolto solo su loopback` };
    }

    if (allowed.length) {
      if (allowed.includes(origin)) return { ok: true };
      return {
        ok: false,
        reason: `origine "${origin}" non consentita: aggiungila a CODEDB_ALLOWED_ORIGINS (attualmente: ${allowed.join(', ')})`,
        // Versione mostrata al browser da /handshake-check, che non richiede
        // autenticazione: dice cosa fare senza elencare le origini configurate.
        publicReason: `origine "${origin}" non consentita: va aggiunta alla variabile CODEDB_ALLOWED_ORIGINS del server`,
      };
    }

    // Senza whitelist: l'Origin deve corrispondere all'host su cui il browser ha
    // effettivamente aperto CodeDB.
    let originHost;
    try { originHost = new URL(origin).host; } catch { originHost = null; }
    if (originHost && host && originHost.toLowerCase() === host.toLowerCase()) return { ok: true };
    return {
      ok: false,
      reason: `origine "${origin}" non corrisponde all'indirizzo di CodeDB ("${host}"). ` +
        'Se l\'accesso avviene tramite un altro dominio (reverse proxy), elencalo in CODEDB_ALLOWED_ORIGINS.',
    };
  }

  const io = new Server(server, {
    maxHttpBufferSize: 5e6,
    // Il CORS non basta per il WebSocket: la decisione vera è in allowRequest,
    // che gira PRIMA di stabilire la connessione. `cors: { origin: false }` evita
    // in più che il polling HTTP di fallback ottenga header permissivi.
    cors: { origin: false },
    allowRequest: (req, callback) => {
      const verdict = checkOrigin(req);
      if (verdict.ok) return callback(null, true);
      console.warn(`[Sicurezza] Handshake Socket.IO rifiutato: ${verdict.reason}`);
      // NOTA: il motivo NON raggiunge il browser. Engine.IO tratta il primo
      // argomento come codice di errore e il client riceve comunque un generico
      // "xhr poll error"/"websocket error" (verificato su entrambi i transport):
      // per l'utente il rifiuto era indistinguibile da un server spento. È il
      // motivo per cui esiste /handshake-check qui sotto, che la pagina interroga
      // quando l'handshake fallisce.
      return callback(verdict.reason, false);
    },
  });

  app.use(express.static(path.join(config.rootDir, 'public')));

  /* ---------------------------------------------------------------------------
   * Diagnosi dell'handshake rifiutato
   *
   * Serve perché il motivo del rifiuto non può viaggiare sul canale Socket.IO
   * (vedi allowRequest): senza questo endpoint il browser non ha modo di
   * distinguere "il server ha rifiutato la mia origine" da "il server è spento",
   * che è esattamente la differenza fra un problema di configurazione da
   * correggere in trenta secondi e un'attesa senza fine.
   *
   * La richiesta arriva dalla pagina di CodeDB, quindi porta gli STESSI header
   * Origin/Host dell'handshake: applicare qui `checkOrigin` diagnostica il caso
   * reale, non un'approssimazione. Non richiede autenticazione — non potrebbe,
   * dato che serve proprio quando la connessione non si stabilisce — e per questo
   * riporta `publicReason`, che dice cosa fare senza rivelare la configurazione.
   * ------------------------------------------------------------------------- */
  // `app: 'codedb'` è anche la FIRMA dell'istanza: la usa il processo Electron per
  // riconoscere un server CodeDB già in ascolto sulla porta invece di fidarsi del
  // solo fatto che qualcosa risponda (CDB-38).
  app.get('/handshake-check', (req, res) => {
    const verdict = checkOrigin(req);
    const challenge = req.get('x-codedb-instance-challenge');
    const clientProof = req.get('x-codedb-instance-client-proof');
    const contestoIstanza = `porta:${Number(req.socket.localPort)}`;
    const richiestaIstanza = stessaProva(
      provaClient(ELECTRON_INSTANCE_SECRET, challenge, contestoIstanza), clientProof,
    );
    const instanceProof = richiestaIstanza
      ? provaServer(ELECTRON_INSTANCE_SECRET, challenge, contestoIstanza)
      : null;
    if (verdict.ok) return res.json({ ok: true, app: 'codedb', ...(instanceProof ? { instanceProof } : {}) });
    res.status(403).json({
      ok: false, app: 'codedb', reason: verdict.publicReason || verdict.reason,
    });
  });

  /* ---------------------------------------------------------------------------
   * Sicurezza del trasporto e dell'accesso.
   *
   * Il server è solo `http.createServer`: su HTTP viaggiano in chiaro la password
   * di accesso (POST /auth/login), il token di sessione (handshake Socket.IO e
   * ogni riconnessione), la passphrase del vault (vault:unlock) e le credenziali
   * complete dei database digitate nel form — password SSH e passphrase delle
   * chiavi private comprese. Finché tutto resta su 127.0.0.1 il rischio è teorico;
   * appena si esce dal loopback chiunque sia sul percorso legge la chiave di tutti
   * i segreti dell'installazione.
   *
   * Implementare TLS nell'app non è la scelta giusta — un reverse proxy fa il
   * lavoro meglio — ma l'errore va reso impossibile: se si esce dal loopback senza
   * dichiarare di essere dietro un proxy TLS, il server NON parte e spiega come
   * configurarlo. `CODEDB_TRUST_PROXY_TLS=1` è la dichiarazione esplicita.
   *
   * La cifratura però non è autenticazione, e le due cose erano legate a una sola
   * variabile: con `CODEDB_TRUST_PROXY_TLS=1` e `CODEDB_RBAC=off` il server
   * partiva con un semplice avviso, e in quella configurazione **cadono tutte le
   * barriere** — `checkOrigin` accetta ogni richiesta priva di header `Origin`,
   * `guardHost` di `/mcp` fa lo stesso, e `authenticate()` restituisce
   * ROOT_PRINCIPAL perché l'RBAC è spento. Chiunque raggiunga la porta ottiene
   * lettura, scrittura, DDL, backup ed export del vault senza credenziali, e
   * l'unico segno è una riga di log a cui nessuno assiste. Da qui il secondo
   * controllo: fuori dal loopback senza autenticazione il server **non parte**,
   * salvo una dichiarazione distinta e volutamente lunga da scrivere
   * (`CODEDB_ALLOW_UNAUTHENTICATED_NETWORK=1`), che viene ripetuta a ogni avvio.
   * ------------------------------------------------------------------------- */
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

  /**
   * Indirizzo su cui l'istanza è DAVVERO raggiungibile.
   *
   * Dentro un container `HOST=0.0.0.0` è l'unico bind sensato ed è un indirizzo
   * INTERNO: a decidere chi arriva alla porta è come viene pubblicata
   * (`ports:` in docker-compose.yml). Guardare il solo `HOST` porterebbe quindi a
   * rifiutare l'avvio di uno stack pubblicato su loopback — cioè sicuro — e ad
   * accettare quello pubblicato su `0.0.0.0`. `CODEDB_PUBLIC_BIND` è la
   * dichiarazione di chi pubblica la porta; il compose la ricava da `BIND_ADDR`,
   * così una sola variabile in `.env` resta la fonte di verità.
   */
  function bindEsposto() {
    const dichiarato = String(config.env.CODEDB_PUBLIC_BIND || '').trim();
    return dichiarato || config.env.HOST || '127.0.0.1';
  }

  function fuoriDalLoopback(host) {
    return !LOOPBACK_HOSTS.has(String(host || '').trim().toLowerCase());
  }

  function assertTransportSafe(host) {
    if (!fuoriDalLoopback(host)) return;
    if (String(config.env.CODEDB_TRUST_PROXY_TLS || '').trim() !== '1') {
      console.error(`Avvio rifiutato: l'istanza è raggiungibile su "${host}", oltre il loopback, ma il server parla solo HTTP.`);
      console.error('Su HTTP viaggiano in chiaro password di accesso, token di sessione, passphrase del vault e credenziali dei database.');
      console.error('');
      console.error('Mettilo dietro un reverse proxy che termina HTTPS (nginx, Caddy, Traefik) e poi riavvia con:');
      console.error('  CODEDB_TRUST_PROXY_TLS=1');
      console.error('Esempio minimo con Caddy:   codedb.example.com { reverse_proxy 127.0.0.1:' + PORT + ' }');
      console.error('Per un uso locale, lascia HOST=127.0.0.1 (default).');
      throw new Error('Avvio rifiutato: configurazione di rete non sicura.');
    }
    console.log(`[TLS] Esposizione "${host}" con CODEDB_TRUST_PROXY_TLS=1: si assume un reverse proxy che termina HTTPS.`);
  }

  /**
   * Fuori dal loopback senza RBAC il server non parte: "c'è un proxy HTTPS
   * davanti" e "l'accesso è autenticato" sono due affermazioni diverse, e
   * confonderle è ciò che rendeva l'esposizione anonima una svista da una riga.
   */
  function assertAuthSafe(host) {
    if (!fuoriDalLoopback(host) || config.rbacOn()) return;
    if (String(config.env.CODEDB_ALLOW_UNAUTHENTICATED_NETWORK || '').trim() === '1') {
      console.warn('┌──────────────────────────────────────────────────────────────────────────┐');
      console.warn('│ ATTENZIONE: CodeDB è raggiungibile dalla rete SENZA AUTENTICAZIONE.      │');
      console.warn('│ Chiunque arrivi alla porta ha lettura, scrittura, DDL, backup ed export  │');
      console.warn('│ del vault su tutte le connessioni salvate. Sei tu ad averlo dichiarato   │');
      console.warn('│ con CODEDB_ALLOW_UNAUTHENTICATED_NETWORK=1. Per chiudere: CODEDB_RBAC=on │');
      console.warn('└──────────────────────────────────────────────────────────────────────────┘');
      return;
    }
    console.error(`Avvio rifiutato: l'istanza è raggiungibile su "${host}" ma CODEDB_RBAC è spento, cioè NON c'è autenticazione.`);
    console.error('Chiunque raggiunga la porta otterrebbe lettura, scrittura, DDL, backup ed export del vault');
    console.error('su tutte le connessioni salvate, senza credenziali e senza lasciare un attore nell\'audit.');
    console.error('');
    console.error('Attiva l\'autenticazione (control plane MongoDB dedicato, vedi .env.example):');
    console.error('  CODEDB_RBAC=on  CODEDB_APP_DB_URI=...  CODEDB_OWNER_EMAIL=...  CODEDB_OWNER_PASSWORD=...');
    console.error('Per un uso locale, lascia HOST=127.0.0.1 (default) — o BIND_ADDR=127.0.0.1 con Docker.');
    console.error('');
    console.error('Se l\'accesso alla porta è già limitato da altro (rete privata, VPN, firewall) e vuoi');
    console.error('assumerti il rischio, dichiaralo: CODEDB_ALLOW_UNAUTHENTICATED_NETWORK=1');
    throw new Error('Avvio rifiutato: configurazione di rete non sicura.');
  }

  return {
    app,
    server,
    checkOrigin,
    io,
    bindEsposto,
    assertTransportSafe,
    assertAuthSafe
  };
}

module.exports = { createModule };

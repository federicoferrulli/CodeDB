/* ---------------------------------------------------------------------------
 * Service worker di CodeDB (CDB-36)
 *
 * COSA NON FA, e perché.
 *
 * Non mette più in cache i moduli JavaScript. Prima ne conservava CINQUE su
 * una cinquantina (`utils.js`, `tabs.js`, `live.js`, `grid.js`, `uml.js`): dopo
 * un aggiornamento dell'applicazione quei cinque restavano alla versione
 * precedente mentre tutti gli altri arrivavano nuovi dalla rete, e un mix di
 * versioni di moduli ES non produce un errore chiaro — produce comportamenti
 * assurdi (funzioni che non esistono, contratti cambiati) impossibili da
 * diagnosticare per chi li subisce. Il nome della cache, per giunta, era fisso
 * a `-v1`: nessun rilascio poteva invalidarla.
 *
 * CodeDB è un client di database: senza rete non ha niente da mostrare, quindi
 * la cache offline dei moduli non porta alcun beneficio reale. Resta in cache
 * il solo guscio statico (icone e foglio di stile), che serve a evitare uno
 * sfarfallio, e la versione è legata a quella dell'applicazione: a ogni
 * rilascio la vecchia cache viene buttata.
 *
 * La strategia è "prima la rete": il contenuto servito è sempre quello vero, e
 * la cache interviene solo se la rete non risponde. Quando non c'è né rete né
 * copia, si restituisce una risposta di errore ESPLICITA: `respondWith` con
 * `undefined` genera un fallimento opaco che nel browser appare come un errore
 * di rete senza spiegazione.
 * ------------------------------------------------------------------------- */

// Cambiare questa stringa a ogni rilascio invalida la cache precedente.
const VERSIONE = 'codedb-2026.08.03';
const CACHE_NAME = `${VERSIONE}-guscio`;

// Solo risorse statiche SENZA dipendenze da altri moduli: qui una copia vecchia
// è innocua, mentre per un modulo ES non lo è mai.
const GUSCIO = [
  './codedb.ico',
  './codedb.png',
  './css/style.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(GUSCIO))
      .catch((err) => {
        console.warn('[SW] Guscio non memorizzato:', err);
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Canali applicativi: sempre e solo rete.
  if (url.includes('/socket.io/') || url.includes('/mcp') || url.includes('/auth/')
      || url.includes('/handshake-check')) {
    return;
  }
  // Il service worker si occupa solo delle GET: una POST non si mette in cache
  // e non si ripete.
  if (event.request.method !== 'GET') return;

  event.respondWith((async () => {
    try {
      const risposta = await fetch(event.request);
      // Il guscio si aggiorna man mano che lo si scarica.
      if (risposta && risposta.ok && GUSCIO.some((p) => url.endsWith(p.replace('./', '/')))) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, risposta.clone()).catch(() => { /* quota piena */ });
      }
      return risposta;
    } catch (err) {
      const copia = await caches.match(event.request);
      if (copia) return copia;
      // Mai `undefined`: una risposta esplicita dice cosa è successo.
      return new Response(
        'CodeDB non è raggiungibile: il server non risponde e non esiste una copia locale di questa risorsa.',
        { status: 503, statusText: 'Servizio non disponibile', headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }
  })());
});

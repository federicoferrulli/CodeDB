# 03: Parallelizzazione dell'export tra tabelle diverse

**What to build:** Il loop principale in `public/js/exportimport.js` (`exportDatabase`) elabora tutte le tabelle strettamente in sequenza. Introdurre una logica per processare fino a 2 o 3 tabelle in parallelo tramite Socket.IO, riducendo drasticamente il tempo complessivo di attesa della rete.

**Blocked by:** 01-optimize-count, 02-memoize-information-schema.

**Status:** ready-for-agent

- [x] Modificare la funzione `exportDatabase` in `exportimport.js`.
- [x] Rimuovere il loop sequenziale bloccante e usare uno scheduler/worker-pool pattern in memoria per elaborare le chiamate `collection:export` (mantenendo in ordine o isolando per stringa JSON le uscite destinate al file finale).
- [x] Gestire correttamente gli errori intercettando i throw paralleli per non lasciare export sospesi.


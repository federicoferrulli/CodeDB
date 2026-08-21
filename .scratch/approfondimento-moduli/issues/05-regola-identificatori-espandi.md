# 05: Regola unica per la scrittura degli identificatori (espandi)

**Cosa costruire:** esiste un modulo condiviso, usabile dal frontend, dagli adattatori e
dal motore di backup, che sa per ogni motore **se** un nome vada quotato e come raddoppiare
il carattere di quotatura.

Oggi la stessa decisione è presa in sette punti diversi, e uno solo di questi sa anche *se*
quotare: gli altri quotano sempre o mai. È la classe di difetto per cui un nome con
maiuscole su PostgreSQL viene abbassato e la tabella non si trova.

Questo ticket **espande soltanto**: nessun chiamante viene ancora migrato, le sette copie
restano al loro posto e nulla cambia nel comportamento.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** done

- [x] Il modulo condiviso è importabile dal frontend, dagli adattatori e dal motore di backup
- [x] Copre le tre famiglie di motore e distingue il caso in cui la quotatura non serve
- [x] Ha test unitari, compresi i nomi che richiedono il raddoppio del carattere di quotatura e i nomi qualificati da uno schema
- [x] Almeno un test è stato verificato rompendo di proposito il codice che protegge
- [x] Nessun comportamento esistente è cambiato: la suite passa invariata

## Che cosa è stato fatto

`public/js/identificatori.mjs` è la regola, e non ha dipendenze: né DOM, né
`require`, né import. L'estensione `.mjs` non è un vezzo — è la sola condizione
alla quale un file di questo pacchetto (che è CommonJS) può essere sia importato
dal browser come modulo ES sia raggiunto dal server con `require()`. Il ponte
lato server è `db/identificatori.js`, tredici righe di rimando senza logica.

Il modulo distingue le due domande, perché i chiamanti sono di due specie:

* `quotaIdentificatore(nome, motore)` quota **solo se serve** — è la via di chi
  scrive nell'editor dell'utente (completamento, doppio clic sullo Schema
  Browser), dove riempire le query di virgolette non richieste è un fastidio;
* `quotaSempre(nome, motore)` quota comunque — è la via di chi compone SQL che
  l'utente non legge (adattatori, DDL, backup, JOIN virtuali), dove quotare
  sempre è la scelta sicura. Su un motore sconosciuto **lancia** invece di
  tirare a caso: scegliere un apice a caso produrrebbe una query valida per il
  motore sbagliato, cioè il difetto silenzioso che il modulo esiste per togliere.
* `quotaQualificato(parti, motore)` per `schema.tabella`, saltando i pezzi
  vuoti e senza mai spezzare un nome che contiene un punto.

Le parole riservate si sono spostate qui dall'evidenziatore di sintassi: è nella
quotatura che sbagliarle **rompe una query** (una colonna `order` scritta nuda è
un errore di sintassi), mentre lì al massimo cambierebbe un colore.
`query-highlighter.js` le importa da qui e continua a ri-esportarle, così nessun
chiamante è cambiato. Stessa cosa per `sql-dialetti.js`, che ri-esporta le
funzioni di quotatura dal posto in cui i moduli del frontend le prendevano.

**Nessun chiamante è stato migrato**: le sette copie sono ancora al loro posto,
come chiede il ticket. Le migra la 06.

## Come è stato provato

`test/unit-identificatori.js` (18 prove, registrato in `test/unit.js`), senza
alcun database: le tre famiglie e i loro alias, il caso PostgreSQL della singola
maiuscola, il raddoppio dell'apice — compreso il caso di due apici di fila e
quello del delimitatore *dell'altro* motore, che non va toccato — i nomi
qualificati, e il fatto che il ponte CommonJS e la via ES diano la **stessa
funzione**, non due copie.

**Sensibilità verificata rompendo il codice di proposito**: allargando la
condizione di PostgreSQL alle maiuscole e togliendo il raddoppio dell'apice,
5 prove su 18 falliscono; ripristinato il file, zero.

`npm test` passa. Non sono stati eseguiti i test E2E (richiedono MongoDB, MySQL
e PostgreSQL vivi, non disponibili in questa sessione); i moduli del frontend
toccati sono stati comunque caricati uno per uno per verificare che importino
senza errori.

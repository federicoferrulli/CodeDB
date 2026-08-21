# CodeDB

Interfaccia in stile DBeaver per esplorare e modificare database MongoDB, MySQL e
PostgreSQL da un'unica applicazione, locale o desktop.

Questo file è **solo un glossario**: nomina i concetti del dominio e dice quale parola si
usa per ciascuno. Non contiene decisioni di implementazione — quelle stanno negli ADR in
`docs/adr/`.

## Language

### Connessione e sessione

**Connessione**:
La configurazione con cui si raggiunge un database, salvata e riusabile. I suoi segreti
vivono nel vault, mai nel browser.
_Avoid_: profilo, credenziale

**Sessione**:
Una connessione viva, aperta verso un database e legata a un singolo tab. Muore con il tab
e con il socket.
_Avoid_: connessione (quando si intende quella viva), client

**Tab**:
Lo spazio di lavoro dell'interfaccia a cui è legata una sessione. Un tab ha un proprio
stato ed è l'unità che l'utente apre, chiude e affianca.
_Avoid_: scheda (riservato al secondo livello: le tabelle aperte dentro un tab)

**Vault**:
Il deposito cifrato dei segreti delle connessioni, protetto da una passphrase.
_Avoid_: keystore, portachiavi

### Database e motori

**Strategia**:
L'adattatore che sa parlare a una famiglia di DBMS. Ce n'è una per MongoDB, una per MySQL,
una per PostgreSQL.
_Avoid_: driver (è la libreria sottostante), connettore, provider

**Database**:
Il livello dell'albero sotto la connessione. Su PostgreSQL corrisponde allo **schema**, non
al database del server: è una scelta deliberata e va detta, perché la parola non significa
la stessa cosa nei tre motori.
_Avoid_: catalogo

**Collezione**:
Il contenitore di documenti o di righe: una collezione su MongoDB, una tabella sui motori
SQL. Quando si parla del solo caso SQL si dice **tabella**.
_Avoid_: entità, oggetto

### Eventi

**Evento**:
Un messaggio che il browser manda al server e a cui il server risponde. È l'unità di
comunicazione dell'applicazione. Gli eventi si dividono in tre famiglie, e la distinzione è
di dominio, non di implementazione (vedi ADR-0001).

**Evento sui dati**:
Un evento che delega a una strategia con un database e una collezione come bersaglio.
Leggere righe, contarle, scriverle, cambiare uno schema.

**Evento amministrativo**:
Un evento che non tocca alcuna strategia: vault, utenti, permessi, chiavi API, connessioni
salvate, licenza, aggiornamenti, audit. Non ha un database come bersaglio.
_Avoid_: evento di sistema

**Operazione lunga**:
Un evento la cui esecuzione dura oltre la risposta: esecuzione di query e di script,
annullamento, backup. Emette avanzamento, si può fermare, e la sua natura si conosce solo
mentre gira.
_Avoid_: job, task

### Esecuzione

**Ricerca globale**:
Una ricerca letterale e senza distinzione fra maiuscole e minuscole nei valori scalari di
tutti i campi rilevati, compresi quelli dentro documenti e array annidati. Su MongoDB i
campi rilevati provengono da un catalogo campionato e arricchito durante la sessione.
_Avoid_: filtro rapido, modalità occhio, ricerca nella pagina

**Condizione**:
Un filtro avanzato scritto nel linguaggio del motore: clausola `WHERE` sui motori SQL o
documento MQL su MongoDB.
_Avoid_: ricerca globale, query

**Script**:
Un testo di più istruzioni eseguite una dopo l'altra, con pausa, ripresa e arresto
sull'errore.
_Avoid_: batch, macro

**Run**:
Una singola esecuzione di uno script, con il suo stato e il suo avanzamento. Uno script
eseguito due volte è due run.
_Avoid_: esecuzione (ambiguo), istanza

**Risultato**:
L'insieme di righe prodotto da una singola istruzione. Un run produce un risultato per
istruzione, e solo i risultati veri diventano schede: un riepilogo di scrittura non lo è.
_Avoid_: output, result set (in italiano: risultato)

### Autorizzazione

**Principal**:
Chi sta compiendo l'operazione: un utente autenticato o una chiave API.
_Avoid_: utente (troppo stretto: una chiave API non è un utente), attore

**Capability**:
Il tipo di operazione che un principal può compiere: lettura, scrittura, DDL,
cancellazione, amministrazione.
_Avoid_: permesso, ruolo, privilegio

**Scope**:
Il perimetro di database e collezioni entro cui una capability vale.
_Avoid_: ambito, dominio

**Grant**:
L'assegnazione di capability e scope a un principal su una connessione.
_Avoid_: assegnazione, ACL

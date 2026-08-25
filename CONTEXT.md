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
annullamento, backup, applicazione di un artefatto. Emette avanzamento, si può fermare, e
la sua natura si conosce solo mentre gira.
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

### Artefatti e applicazione

**Artefatto**:
Un file che descrive il contenuto di un database e da cui lo si può ricostruire: un export
dell'intero database o una catena di backup. Un artefatto non è mai fidato, nemmeno quando
il suo checksum torna.
_Avoid_: dump, backup (è solo una delle due forme), sorgente

**Bersaglio**:
La risorsa che una singola istruzione DDL modifica davvero, ricavata dall'istruzione e non
dal nome dichiarato attorno. È la cosa che si confronta con ciò che il piano ammette.
_Avoid_: destinazione (è il database, non la risorsa), oggetto

**Piano**:
Il contratto immutabile e firmato che descrive per intero ciò che verrà applicato, prima
di qualsiasi mutazione. Anteprima ed esecuzione condividono lo stesso piano.
_Avoid_: operazione, richiesta, configurazione

**Impronta**:
Il riassunto del contenuto del piano con cui si dimostra che l'anteprima mostrata e
l'esecuzione richiesta sono lo stesso piano.
_Avoid_: hash, firma (non è crittografia a chiave), checksum (riservato all'artefatto)

**Identità stabile**:
La regola con cui si riconosce la stessa riga nel tempo: `_id` su MongoDB, una chiave
primaria o un vincolo univoco interamente non nullo sui motori SQL. È una proprietà
dichiarata, non dedotta al momento della scrittura.
_Avoid_: chiave (ambiguo), primary key, indice

**Staging**:
La copia su cui l'artefatto viene applicato e verificato mentre la destinazione è ancora
intatta.
_Avoid_: temporaneo, area di lavoro

**Copia di recupero**:
La copia full verificata della destinazione preesistente, da cui la si riporta com'era. È
conservata finché non la si elimina esplicitamente.
_Avoid_: rollback (è l'azione), snapshot, backup

**Promozione**:
Il passaggio dallo staging alla destinazione. La sua garanzia dipende dal motore e va
dichiarata: su PostgreSQL è uno scambio di schemi atomico, altrove no.
_Avoid_: commit, pubblicazione, swap

**Esito**:
Come un'operazione su artefatto finisce, in tre soli valori: `completato`,
`ripristinato_dopo_errore`, `intervento_richiesto`. Un risultato parziale non è un
successo.
_Avoid_: stato (è ciò che l'operazione attraversa), risultato (riservato alle righe di
un'istruzione)

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

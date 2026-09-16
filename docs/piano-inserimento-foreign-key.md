# Selezione delle foreign key durante l'inserimento

Stato: implementato. Verifiche: `test/e2e-fk-inserimento.js` (Chromium, socket finto) e
`test/unit-fk-relazioni.js`.

## Obiettivo e comportamento

Nel form «Nuova riga», un campo con foreign key deve permettere di cercare e scegliere una riga della tabella riferita, usando lo stesso pannello già disponibile nell'editing della griglia.

Esempio: inserendo un ordine, il campo `cliente_id` permette di cercare un cliente per i dati mostrati nel pannello; «Usa questo valore» compila `cliente_id`. La nuova riga viene salvata solo premendo «Inserisci».

- Accanto al campo compare il pulsante di collegamento, con destinazione e nome accessibile.
- Su desktop il pannello si apre entrando nel campo, senza sottrarre il focus; su mobile si apre dal pulsante, come nell'edit attuale.
- Restano disponibili digitazione manuale, ricerca, anteprima della riga riferita e caricamento progressivo dei candidati.
- Una FK composta compila insieme tutte le colonne locali del vincolo, prendendole dalla stessa riga scelta.
- Il comportamento vale sia nella vista Dati sia nell'inserimento da Split-View.

## Punti del codice già disponibili

| File | Riutilizzo previsto |
| --- | --- |
| `public/js/insert.js` | `openInsertDocForContext`, `addInsertRow`, `insertRowValue`, `buildInsertDoc`: apertura, controlli e documento da inserire. |
| `public/js/fk-cache.js` | `caricaRelazioni` e `relazioniPer`: metadati isolati per connessione, motore, database e tabella. |
| `public/js/fk-relazioni.js` | Descrittori normalizzati e `setDaRelazione`: associazione tra colonne locali e riferite, comprese FK composte. |
| `public/js/fk-vista.js` | `apriPannelloFk`: ricerca, paginazione, anteprima e callback `onScegli(valore, riga)`. |
| `public/js/inlineEdit.js` | Riferimento per comportamento desktop/mobile; il suo callback salva immediatamente e quindi non va riutilizzato nell'inserimento. |
| `public/js/utils.js`, `public/css/style.css` | Chiusura delle modali, Escape e sovrapposizione del pannello. |
| `test/e2e-fk-viste.js`, `test/unit-fk-relazioni.js` | Verifiche esistenti da estendere senza introdurre dipendenze. |

## Sequenza di implementazione

### 1. Collegare i metadati al form

Caricare le relazioni usando il contesto congelato in `insertContext`, insieme al caricamento delle colonne. Rendere il form disponibile senza attendere le relazioni e collegare i pulsanti quando entrambi i risultati sono pronti, indipendentemente dall'ordine di arrivo.

Associare le relazioni ai nomi dei campi, senza dedurle nuovamente dai nomi delle colonne. Non rendere modificabili i campi generati o auto-incrementali. Conservare le protezioni basate su `insertAperture` ed estenderle alla chiusura: una risposta tardiva non deve aggiornare una modale chiusa o riaperta.

La cache attuale trasforma gli errori in una mappa vuota: distinguere il fallimento dal caso «nessuna relazione» con il minimo adeguamento condiviso necessario, verificando anche i chiamanti griglia e Split-View. Mostrare un errore comprensibile e consentire un nuovo tentativo, mantenendo utilizzabile l'inserimento manuale.

### 2. Aprire il pannello esistente

Da ciascun campo collegato chiamare `apriPannelloFk` con relazione, valori correnti della FK, `tabId`, database/schema di origine e identità della specifica apertura del form. Leggere solo i campi della relazione: altri campi obbligatori ancora vuoti non devono impedire la scelta.

Il callback aggiorna esclusivamente la bozza del form: non chiama `doc:update`, `doc:insert` o il salvataggio dell'editor inline. Usare `setDaRelazione` per ottenere l'intera assegnazione; validare disponibilità e scrivibilità di tutti i controlli prima di applicarla, evitando modifiche parziali.

### 3. Conservare valori e tipi

Riutilizzare la conversione esistente dove garantisce un passaggio senza perdite. Per i valori che il controllo testuale non rappresenta fedelmente, conservare il valore EJSON selezionato sulla riga del form e usarlo nella costruzione del documento; una modifica manuale deve invalidare questa copia e tornare al parser del controllo.

Verificare numeri grandi, decimali, stringhe con zeri iniziali o spazi, stringa vuota, date, `null` e ObjectId per i collegamenti MongoDB già riconosciuti. Non usare le etichette del pannello come valori: possono essere troncate. Non convertire chiavi esatte tramite `Number`.

Conservare la distinzione tra campo omesso, valore nullo e valore scelto. Il passaggio Form → JSON deve includere le FK compilate secondo le regole già esistenti, senza sovrascrivere JSON modificato manualmente.

### 4. Integrare pannello e modale

Verificare visibilità sopra l'overlay, clic, navigazione da tastiera e ritorno del focus. Escape dal pannello chiude prima il pannello; la chiusura del form deve chiudere anche il pannello di sua proprietà e invalidarne i callback.

Coprire annullamento, Escape, salvataggio riuscito, riapertura, passaggio alla scheda JSON e cambio del campo FK. Il ritorno del focus dopo «Usa questo valore» non deve riaprire automaticamente il pannello appena chiuso.

Il controllo corrente del pannello sul contenitore DOM non basta per una modale soltanto nascosta: verificare anche apertura e visibilità della sorgente. Integrare la pulizia nel percorso comune di chiusura se necessario, evitando gestori diversi per ogni pulsante.

Il comando «Apri tabella» e i cambi di tab non devono perdere la bozza né cambiarne il bersaglio. Le richieste restano vincolate al contesto originale; callback di aperture precedenti non possono compilare il nuovo form.

### 5. Verificare e chiudere

Estendere i test browser esistenti con socket simulato per verificare interazioni e payload; aggiungere verifiche pure solo per nuova logica di conversione che lo richieda.

| Caso | Risultato atteso |
| --- | --- |
| FK semplice MySQL/PostgreSQL | Ricerca e scelta compilano il campo; nessuna scrittura prima di «Inserisci». |
| FK composta, aperta da ciascun componente | Tutte le colonne vengono compilate dalla stessa riga; dati incompleti non modificano parzialmente il form. |
| Destinazione in altro schema/database | Le letture usano la destinazione del vincolo e la connessione originaria. |
| BIGINT oltre 2^53, decimali e chiavi testuali | Payload esatto, senza arrotondamenti, troncamenti o perdita di zeri/spazi. |
| Modifica manuale dopo la scelta | Il payload contiene il nuovo valore digitato. |
| Dati e Split-View su connessioni diverse | Nessuna contaminazione tra tab, riquadri e modali riaperte. |
| Richieste lente, chiusura e riapertura | Risposte e scelte obsolete non aggiornano il nuovo form. |
| Nessun candidato, errore di lettura o permesso negato | Messaggio leggibile; nessuna selezione falsa o aggiramento dei permessi. |
| Tastiera e viewport mobile | Pulsante raggiungibile, focus coerente, Escape corretto, pannello visibile e utilizzabile. |
| Regressione dell'edit | La scelta nell'editing continua a salvare secondo il comportamento attuale. |

Eseguire `node test/unit-fk-relazioni.js`, `node test/e2e-fk-viste.js` e `npm test`, oltre agli eventuali test aggiunti. Provare almeno un inserimento reale con FK semplice e composta su MySQL e PostgreSQL, verificando i valori riletti dal database: il socket simulato non dimostra l'accettazione del vincolo dal DBMS.

Verificare la sensibilità dei nuovi test introducendo temporaneamente un difetto mirato, per esempio ignorare una colonna della FK composta o arrotondare una chiave grande: il test pertinente deve fallire. Ripristinare il codice e rieseguire le verifiche. Nel resoconto distinguere prove eseguite, copertura e verifiche eventualmente bloccate dall'assenza dei database.

## Perimetro e criterio di completamento

Nessun nuovo endpoint o componente di ricerca: usare `collection:relations`, `collection:find` e `doc:insert` con i controlli RBAC esistenti. Non sono richiesti creazione di righe nella tabella riferita, nuovi vincoli o un selettore dentro l'editor JSON libero.

Per MongoDB riutilizzare i collegamenti già esposti dal sistema, mantenendo l'indicazione esplicita che sono euristiche. La selezione tra più vincoli concorrenti sul medesimo campo conserva la precedenza già adottata nell'edit; un nuovo selettore di vincolo non fa parte di questa richiesta.

Il lavoro è completo quando Keus può aprire «Nuova riga», scegliere un record riferito, vedere tutti i campi interessati compilati e salvare una sola volta nella tabella corretta, con valori esatti e senza regressioni dell'edit.

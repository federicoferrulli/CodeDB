# Progettazione SQL dal diagramma UML

Su MySQL e PostgreSQL, aprire **UML → Progetta schema**. Il pannello prepara
una bozza locale, salvata insieme al diagramma e inclusa nell'esportazione JSON.
Salvare nella bozza non modifica il database. Annulla e Ripeti agiscono sul
documento; non annullano istruzioni già applicate al database.

## Operazioni disponibili

- Creare, rinominare ed eliminare tabelle.
- Aggiungere, modificare, rinominare ed eliminare colonne; definire tipo,
  nullabilità e default. Le nuove colonne possono essere auto-incrementali.
- Aggiungere, sostituire ed eliminare chiavi primarie, anche composte.
- Creare, sostituire ed eliminare chiavi esterne, anche composte, con azioni
  su aggiornamento ed eliminazione, incluso `SET DEFAULT` su PostgreSQL.

Le tabelle nuove e le relazioni da creare compaiono sul canvas come bozze.
Le tabelle esistenti con modifiche mostrano «modifiche in bozza».
Con il pannello aperto, collegare due colonne apre la progettazione della FK.
L'ispettore offre **Modifica struttura** e **Modifica vincolo** sugli oggetti SQL.
Le relazioni logiche preesistenti non diventano automaticamente vincoli.

## Anteprima e applicazione

**Anteprima SQL** invia operazioni strutturate al server, che genera le istruzioni
con il dialetto della connessione. **Applica al database** richiede la conferma
scritta `APPLICA`, poi esegue soltanto le istruzioni associate a quell'anteprima.
L'anteprima scade dopo dieci minuti; una nuova anteprima sostituisce la precedente.
Le operazioni vengono compilate nell'ordine della bozza: una modifica può usare
colonne, tabelle e vincoli creati o rinominati dai passi precedenti.

I controlli verificano permessi e scope su tutte le tabelle interessate, comprese
le destinazioni delle FK e delle rinomine. Prima dell'applicazione si confrontano
le definizioni delle tabelle, degli indici e delle FK con quelle dell'anteprima.
L'avanzamento del contatore `AUTO_INCREMENT` dovuto agli INSERT non invalida
l'anteprima; le modifiche alla struttura e ai default continuano a invalidarla.
Il token impedisce di ripetere le scritture con un doppio clic o un retry.

L'esecuzione si ferma al primo errore. Il piano **non è una transazione unica**:
le istruzioni già riuscite restano applicate e vengono tolte dalla bozza. Il
riepilogo distingue le istruzioni applicate da quelle il cui esito va verificato.
In caso di risposta persa, lo stesso pulsante recupera l'esito del piano senza
ripetere le istruzioni, finché la sessione e l'anteprima restano disponibili.
Dopo l'applicazione il diagramma rilegge lo schema e conserva il layout.

## Perimetro

Il progettista lavora sulle tabelle dello schema/database corrente. Per vincoli
tra schemi diversi e modifiche di espressioni di colonne generate si usa una DDL
esplicita. Il DBMS resta responsabile della compatibilità dei tipi, dei valori
esistenti e delle dipendenze: l'anteprima non garantisce che una conversione di
dati riesca. MongoDB non è incluso in questo incremento.

## Verifica

- `node test/unit-uml-progetto.js`: autorizzazioni, input, SQL mostrato/eseguito,
  schema cambiato, concorrenza, esiti parziali, token e persistenza della bozza.
- `node test/e2e-uml-progetto.js`: Chromium con backend simulato; creazione e FK,
  annulla/ripeti, riapertura, anteprima, conferma e aggiornamento del canvas.
- `node test/e2e-uml-progetto-regressioni.js`: rinomine e vincoli nei passi della
  bozza, conservazione di `SET DEFAULT` e rifiuto delle modifiche FK tra schemi.
- `node test/e2e-uml-progetto-db.js`: strategie e controlli reali contro MySQL e
  PostgreSQL, con database/schema temporanei. Richiede `CODEDB_E2E_DESTRUCTIVE=1`
  e le variabili `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `PG_PORT`, `PG_USER`,
  `PG_PASSWORD`, `PG_DATABASE` quando diverse dai valori locali standard.

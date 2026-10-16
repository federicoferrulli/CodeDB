# Informativa sulla privacy di CodeDB Manager beta

Ultimo aggiornamento: 16 ottobre 2026. Versione di riferimento: 0.2.1-beta.1 per Windows, distribuita tramite Microsoft Store.

CodeDB Manager è un'applicazione desktop per gestire database. Elabora sul dispositivo le informazioni necessarie alle operazioni richieste dall'utente e comunica con i database e i servizi descritti di seguito. Il normale utilizzo dell'app non comporta l'invio automatico del contenuto dei database o delle credenziali allo sviluppatore.

## Titolare e contatti

Il titolare del trattamento dei dati ricevuti per l'assistenza e la gestione della beta è **Federico Ferrulli**, sviluppatore che pubblica con il nome **Keus**, in Italia. Per informazioni sulla privacy o per esercitare i tuoi diritti puoi scrivere a **[info@codedb.org](mailto:info@codedb.org)**.

Quando utilizzi CodeDB Manager per trattare dati personali presenti nei tuoi database, le finalità, le autorizzazioni e i tempi di conservazione di quei dati dipendono da te o dall'organizzazione per cui operi. La sola distribuzione dell'app non dà allo sviluppatore accesso ai tuoi database e non costituisce un servizio di custodia dei loro contenuti.

Questa informativa riguarda l'app desktop e i contatti per la beta. Non sostituisce le informative dell'organizzazione che gestisce i database, dei servizi esterni scelti dall'utente o del sito web eventualmente visitato.

## Dati utilizzati dall'app

In base alle funzioni utilizzate, l'app può trattare:

- parametri di connessione, nomi di host e database, nomi utente, password, stringhe di connessione, chiavi e parametri SSH;
- schemi, documenti, righe, risultati delle query e altri contenuti dei database, compresi eventuali dati personali presenti al loro interno;
- testi delle query e degli script, filtri e cronologia delle operazioni;
- impostazioni dell'interfaccia, preferenze, dati di sessione e cache;
- file importati o esportati, backup e registri tecnici o di audit, che possono contenere nomi di connessioni, database, utenti, dettagli delle operazioni e messaggi di errore.

Questi dati servono a effettuare le connessioni, mostrare ed elaborare i risultati, eseguire le operazioni richieste e conservare le impostazioni e la cronologia. L'app utilizza memoria locale, archivi del profilo utente e file nelle destinazioni previste o scelte dall'utente. Se configuri un'installazione con autenticazione multiutente, i dati degli account e delle autorizzazioni sono gestiti anche nel database di controllo configurato dall'amministratore.

L'app non include pubblicità, strumenti propri di analisi del comportamento a fini pubblicitari o un servizio automatico di invio dei log allo sviluppatore. Le eventuali informazioni raccolte da Windows e Microsoft Store sono disciplinate dalle impostazioni e dall'informativa di Microsoft.

## Connessioni esterne

**Database e SSH.** Le connessioni trasmettono ai server configurati i dati necessari all'autenticazione e alle operazioni richieste. I server possono trovarsi sullo stesso dispositivo, in una rete privata o presso fornitori esterni. La protezione del collegamento dipende dal protocollo e dalle impostazioni utilizzate.

**Google Fonts.** La beta carica i caratteri Inter e JetBrains Mono dai servizi Google Fonts, anche all'apertura dell'interfaccia. Queste richieste comunicano a Google l'indirizzo IP e le informazioni tecniche della richiesta, come la risorsa richiesta e i metadati del client. Le richieste dei caratteri non includono il contenuto delle query o dei database. Nella beta non è presente un comando dedicato per disattivare questo caricamento. Per il trattamento svolto da Google consulta l'[informativa di Google](https://policies.google.com/privacy) e le [informazioni sulla privacy di Google Fonts](https://fonts.googleblog.com/2022/11/your-privacy-and-google-fonts.html).

**Mappe OpenStreetMap.** Quando apri una mappa con lo sfondo attivo, l'app richiede le immagini cartografiche a tile.openstreetmap.org. Il servizio riceve l'indirizzo IP, informazioni tecniche sulla richiesta e gli identificativi delle tessere, dai quali è ricavabile l'area visualizzata e il livello di zoom. I documenti del database e le geometrie sovrapposte non sono caricati sul servizio come parte di queste richieste. Lo sfondo è inizialmente attivo; puoi disattivarlo dal comando “Sfondo mappa” dell'editor geografico. La preferenza viene conservata localmente e condivisa dalle viste cartografiche; le richieste già effettuate non vengono annullate. Si applica l'[informativa della OpenStreetMap Foundation](https://osmfoundation.org/wiki/Privacy_Policy).

**Integrazioni facoltative.** Se configuri notifiche Slack per backup e ripristini, vengono inviati al webhook indicato l'esito dell'operazione, nomi di database e connessioni, statistiche ed eventuali messaggi di errore. Se utilizzi lo storage remoto per i backup, ove disponibile con i relativi componenti aggiuntivi, i file del backup sono caricati nella destinazione S3, Google Cloud Storage o Azure scelta da te. Queste integrazioni non inviano dati finché non vengono configurate e utilizzate.

**Client MCP e intelligenza artificiale.** Collegando un client esterno al gateway MCP, gli consenti di richiedere informazioni e operazioni nei limiti delle autorizzazioni configurate. Schemi, risultati e altri contenuti restituiti possono essere inoltrati dal client al proprio fornitore AI. Verifica le impostazioni e l'informativa di quel servizio prima di collegarlo; CodeDB Manager non determina come il fornitore esterno conserva o utilizza i dati ricevuti.

**Microsoft Store.** Installazione, distribuzione e aggiornamenti dell'edizione Store sono gestiti da Microsoft. Microsoft può trattare dati dell'account, del dispositivo e di diagnostica secondo la propria [informativa sulla privacy](https://www.microsoft.com/it-it/privacy/privacystatement). L'edizione Store non utilizza il sistema di aggiornamento da GitHub previsto per l'installer indipendente.

## Assistenza e partecipazione alla beta

Se scrivi a info@codedb.org, vengono ricevuti il tuo indirizzo email, l'eventuale nome, il testo del messaggio, i metadati della comunicazione e gli allegati che scegli di inviare. La casella è ospitata da **Hostinger**, che tratta i messaggi per erogare il servizio di posta, secondo le relative condizioni sul trattamento dei dati.

Queste informazioni vengono utilizzate per rispondere, analizzare i problemi segnalati e migliorare affidabilità e sicurezza dell'app. Invia soltanto informazioni necessarie alla richiesta, rimuovendo password, chiavi private e dati personali dei tuoi database da schermate e log.

Se chiedi di partecipare a una beta con accesso riservato, l'indirizzo del tuo account Microsoft può essere inserito nel gruppo di tester in Partner Center per abilitare l'accesso e comunicarti informazioni relative al collaudo. Puoi chiedere di essere rimosso scrivendo al contatto privacy. Fornire questi dati è facoltativo, ma senza un indirizzo valido potrebbe non essere possibile rispondere alla richiesta o abilitare l'accesso riservato.

Se scegli di pubblicare una segnalazione nel repository GitHub pubblico, il nome del tuo profilo e il contenuto della segnalazione sono visibili pubblicamente secondo le impostazioni del servizio. Per contenuti riservati utilizza l'email. Consulta l'[informativa di GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

## Finalità e basi giuridiche

Per i dati ricevuti direttamente dallo sviluppatore, la gestione delle richieste di assistenza, delle segnalazioni e degli accessi alla beta si basa sul legittimo interesse a rispondere agli utenti, organizzare il collaudo richiesto e mantenere il software affidabile e sicuro, ai sensi dell'articolo 6, paragrafo 1, lettera f), del GDPR. Puoi opporti al trattamento nei casi previsti dalla legge.

Gli eventuali trattamenti imposti da obblighi di legge si basano sull'articolo 6, paragrafo 1, lettera c), del GDPR. I dati ricevuti tramite assistenza o iscrizione alla beta non sono utilizzati per pubblicità comportamentale, vendita di elenchi di contatti o decisioni automatizzate con effetti giuridici o analogamente significativi.

Le operazioni sui database e le integrazioni che configuri dipendono dalle tue istruzioni e dalle autorizzazioni del soggetto che gestisce quei dati; questa informativa non attribuisce una base giuridica alle operazioni eseguite per conto della tua organizzazione.

## Destinatari e trasferimenti internazionali

I dati inviati allo sviluppatore sono accessibili per le finalità indicate al titolare e ai fornitori necessari all'erogazione dei servizi utilizzati, tra cui Hostinger per la posta e Microsoft per l'accesso alla beta. Possono essere comunicati alle autorità quando richiesto dalla legge. Le connessioni dell'app raggiungono inoltre i destinatari descritti nella sezione “Connessioni esterne”.

L'utilizzo di questi servizi può comportare trattamenti fuori dallo Spazio economico europeo. Per i servizi coperti dal [Data Processing Addendum di Hostinger](https://www.hostinger.com/legal/dpa), sono previste, ove applicabili, le clausole contrattuali standard della Commissione europea per i trasferimenti verso Paesi privi di una decisione di adeguatezza. Le informative dei singoli servizi descrivono le ulteriori garanzie e modalità applicabili ai loro trattamenti. Puoi richiedere informazioni sulle garanzie relative ai dati gestiti dal titolare a info@codedb.org.

## Conservazione e cancellazione

I dati salvati dall'app sul dispositivo restano disponibili secondo le funzioni utilizzate, i limiti di cronologia e la rotazione dei log, oppure fino alla loro eliminazione. Puoi rimuovere le connessioni salvate e cancellare la cronologia mediante i relativi comandi. File esportati, backup e copie conservate in altre cartelle o servizi devono essere gestiti separatamente. La disinstallazione non elimina i dati presenti nei database remoti o nei servizi esterni.

Le comunicazioni di assistenza e i relativi allegati sono conservati per il tempo necessario a gestire la richiesta e gli eventuali sviluppi del problema segnalato; terminata tale necessità, vengono eliminati o anonimizzati, salvo quanto occorra per obblighi di legge o per specifiche controversie. Il criterio tiene conto della chiusura della richiesta e della permanenza del problema, senza giustificare una conservazione indefinita.

Gli indirizzi dei tester sono conservati nel gruppo di accesso finché la partecipazione alla beta è attiva; vengono rimossi in caso di rinuncia o cessazione del gruppo. La conservazione nei servizi esterni segue anche le impostazioni e le condizioni dei rispettivi fornitori.

## Protezione dei dati

Il server incorporato nell'app desktop opera sull'interfaccia locale del dispositivo. Il vault può proteggere i segreti delle connessioni con crittografia AES-256-GCM e una passphrase impostata dall'utente. Un vault senza una passphrase personale non offre la stessa protezione contro chi ha accesso ai file locali.

La protezione del vault non cifra automaticamente cronologie, log, risultati, esportazioni e tutti i backup. Proteggi l'account del sistema operativo e i supporti di archiviazione; configura collegamenti protetti ai database e limita i permessi dei client esterni. Lo sviluppatore non dispone di un accesso remoto per leggere o cancellare i dati conservati esclusivamente sul tuo dispositivo.

## I tuoi diritti

Nei casi previsti dal GDPR, puoi chiedere l'accesso ai dati personali trattati dal titolare, la rettifica, la cancellazione, la limitazione del trattamento e la portabilità, nonché opporti al trattamento fondato sul legittimo interesse. Invia la richiesta a **[info@codedb.org](mailto:info@codedb.org)**. Per dati gestiti esclusivamente dalla tua organizzazione o da un servizio esterno, rivolgiti al rispettivo titolare.

Puoi presentare un reclamo al [Garante per la protezione dei dati personali](https://www.garanteprivacy.it/i-miei-diritti) o a un'altra autorità di controllo competente.

## Aggiornamenti dell'informativa

L'informativa viene aggiornata quando cambiano le funzionalità o le modalità di trattamento. La data in apertura identifica la versione del testo. Eventuali nuovi trattamenti saranno descritti prima della loro introduzione e, quando necessario, accompagnati dalle scelte o dai consensi richiesti dalla legge.

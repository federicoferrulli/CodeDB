# Inserimento dei testi di CodeDB Manager beta nello Store

[Descrizione e campi della scheda](descrizione-it.md) e [informativa sulla privacy](privacy-it.md) si riferiscono alla beta Windows 0.2.1-beta.1 e al nome riservato **CodeDB Manager**. Contatto indicato dal titolare: **info@codedb.org**, con casella ospitata da **Hostinger**.

## Utilizzo dei testi

Nella scheda italiana di Partner Center, copiare il contenuto della sezione “Descrizione” nel relativo campo. Le altre sezioni forniscono i testi per descrizione breve, funzionalità e novità, dove presenti. I titoli e le istruzioni del file non fanno parte della descrizione commerciale.

Pubblicare l'informativa su una pagina HTTPS accessibile senza autenticazione e inserire l'indirizzo effettivo nel campo URL dell'informativa sulla privacy di Partner Center. La pagina per `https://codedb.org/privacy` è preparata nella landing, come descritto sotto; la pubblicazione sul sito e la verifica dell'URL pubblico restano da eseguire. L'indirizzo email non sostituisce l'URL della pagina. Il requisito si applica anche alle applicazioni desktop: [Microsoft Store Policies 7.19, sezione 10.5.1](https://learn.microsoft.com/en-us/windows/apps/publish/store-policy-archive/store-policy-7-19#105-personal-information).

L'indicazione “beta” nella descrizione non configura la visibilità. L'accesso riservato ai tester va impostato separatamente in Partner Center.

## Pagina HTML nella landing

La build contiene [la pagina italiana](../../landing/dist/privacy.html) e [la traduzione inglese](../../landing/dist/en/privacy.html). La pagina conserva la cornice del sito e aggiunge all'informativa dell'app una sezione sulla navigazione di codedb.org: registri del server, preferenze locali e caricamento dei caratteri da Google Fonts.

Per aggiornare il sito, caricare il contenuto di `landing/dist/` nella radice del sito statico, mantenendo le sottocartelle e gli asset. La configurazione Apache esistente in `landing/codedb.conf` serve anche gli indirizzi senza estensione: `/privacy` restituisce `privacy.html`, mentre `/en/privacy` restituisce `en/privacy.html`. I canonical restano `/privacy.html` e `/en/privacy.html`, coerenti con gli indirizzi già usati nella mappa del sito. L'effettiva configurazione del server pubblico non è stata modificata.

Per revisioni successive, modificare `landing/src/pages/privacy.html` e i dizionari `landing/locales/it/privacy.json` e `landing/locales/en/privacy.json`, quindi rigenerare con `npm run pagine`, verificare con `npm run verifica` e compilare con `npm run build` dalla cartella `landing`. Non modificare direttamente gli HTML generati.

La landing è esclusa dal Git del progetto. La copia precedente dei sorgenti interessati e dell'intera build è conservata in `landing/scratch/privacy-store-20261016-174923/prima/`.

Verifiche locali completate: generazione e coerenza delle 26 pagine bilingui, build Vite, accesso a `/privacy` e `/en/privacy` nel server di anteprima, viewport da 320 a 1440 px, cambio lingua, chiusura del banner e testo disponibile senza JavaScript. Nessun errore JavaScript, asset locale mancante o scorrimento orizzontale rilevato. Il confronto con la build salvata mostra modifiche soltanto a `privacy.html`, `en/privacy.html` e `sitemap.xml`. Questi controlli non confermano la disponibilità sul server pubblico.

## Ambito della verifica

I testi sono stati confrontati con il codice locale al commit `8dcc564` e con i dati forniti dal titolare. Sono bozze da adottare: descrivono il comportamento rilevato, ma non costituiscono una verifica legale o una certificazione Microsoft. La pagina HTML è stata integrata nella landing locale; non sono stati modificati l'app, la pipeline o servizi esterni, né pubblicati i testi.

| Argomento | Riscontro nel progetto |
| --- | --- |
| Identità dello sviluppatore, versione e licenza | `package.json` |
| Runtime locale e profilo Store | `electron-main.js` |
| Aggiornamenti tramite Microsoft Store | `electron-aggiornamenti.js` |
| Richieste automatiche a Google Fonts | `public/index.html`, `public/css/tokens.css` |
| Sfondo OpenStreetMap attivo per impostazione iniziale e preferenza locale | `public/js/geo-leaflet.js`, `public/js/geomap.js`, `public/js/geo-vista.js` |
| Cronologie persistenti | `public/js/queryhistory.js`, `public/js/query-history-store.js` |
| Cifratura e passphrase del vault | `server/vault.js`, `db/vault.js` |
| Audit e rotazione dei registri | `server/audit.js`, `db/AuditLog.js` |
| Notifiche Slack e contenuti inviati | `backup/cli.js`, `backup/lib/notify.js` |
| Backup cloud opzionali | `backup/lib/storage.js`; i relativi SDK non sono dipendenze del pacchetto corrente |
| Accesso mediante client MCP | `mcp/McpGateway.js` |

La verifica è statica: non è stata effettuata una cattura del traffico di rete e non sono state collaudate le integrazioni esterne. Il testo non promette funzionamento completamente offline, cifratura di tutti i file o assenza di connessioni esterne.

## Adozione dell'informativa

I criteri di conservazione per assistenza e tester sono una proposta organizzativa: devono essere effettivamente applicati dal titolare nella casella email e in Partner Center. Non corrispondono a cancellazioni automatiche implementate nell'app. La localizzazione della casella, l'eventuale prodotto email rivenduto e le condizioni contrattuali effettive vanno riscontrati nell'account Hostinger; il documento non presume che i messaggi rimangano esclusivamente in Italia o nell'UE.

Il caricamento automatico di Google Fonts è presente nel codice, senza un comando di consenso dedicato; anche le mappe hanno lo sfondo inizialmente attivo. L'informativa descrive questi comportamenti, ma la sua pubblicazione da sola non risolve la valutazione della base giuridica o degli eventuali consensi necessari. Prima dell'adozione definitiva, verificare questi aspetti; includere i font nel pacchetto è una possibile modifica tecnica per evitare le richieste a Google.

I contenuti informativi e i diritti sono stati confrontati con le indicazioni del [Garante sugli obblighi di informazione](https://www.garanteprivacy.it/home/docweb/-/docweb-display/docweb/8981258) e sui [diritti degli interessati](https://www.garanteprivacy.it/Regolamentoue/diritti-degli-interessati). Le informative dei fornitori e il DPA Hostinger sono collegati direttamente nei paragrafi pertinenti del testo destinato agli utenti.

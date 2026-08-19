# 11: Staccare il trasporto dal sacco di utilità

**Cosa costruire:** il modulo che manda gli eventi al server esce dal sacco di funzioni di
utilità del frontend e diventa un modulo suo, con il socket **accettato** come dipendenza
invece che creato al momento in cui il modulo viene importato.

Oggi due moduli convivono in un file solo: uno superficiale — una quarantina di funzioni
scorrelate, dai toast alle icone alle modali — e uno profondo, il trasporto, che assorbe la
riconnessione delle sole connessioni salvate, l'annullamento su tab chiuso e la marcatura
dell'origine della risposta. Il secondo è invisibile perché sepolto nel primo, e importarlo
tira dentro tutto il resto.

È il socket creato al caricamento, non lo stacco in sé, a chiudere il ciclo di import che
rende non caricabili in prova quasi tutti i file grandi del frontend: entrambe le cose vanno
fatte in questo ticket, altrimenti il ciclo resta.

Il precedente esiste già in casa: il modulo dei valori è stato staccato e ri-esportato
proprio perché chi ha bisogno solo di quello non debba caricare l'intera applicazione.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** ready-for-agent

- [ ] Il trasporto è un modulo proprio, importabile senza tirarsi dietro toast, modali e icone
- [ ] Il socket è accettato come dipendenza, non creato al caricamento del modulo
- [ ] Almeno un modulo grande del frontend che prima non era caricabile in prova ora lo è, dimostrato da un test che lo importa
- [ ] L'applicazione si avvia senza errori, provato dal test di avvio dell'interfaccia
- [ ] Nessun comportamento visibile all'utente è cambiato

# 28: Il guardiano strutturale dichiara ciò che non sa vedere

**Cosa costruire:** chi incontra il test che impedisce alle copie duplicate di
risorgere capisce in dieci secondi se ha davanti un difetto vero o un
rinominamento innocente, e sa che cosa quel test **non** garantisce.

Quel test confronta il testo dei due adattatori con stringhe prese alla lettera.
È una scelta obbligata — due copie identiche si comportano in modo identico,
quindi nessun test di comportamento può accorgersi che sono due — ma ha due
lati, e oggi nessuno dei due è dichiarato:

- **Non vede la copia riscritta.** Basta uno spazio diverso, l'ordine delle
  chiavi cambiato o una funzione anonima al posto di una dichiarazione, e la
  copia passa. Il test sembra promettere che il difetto non possa tornare;
  promette molto meno.
- **Fallisce su modifiche innocenti.** Chi rinomina legittimamente una variabile
  lo fa diventare rosso senza che esista alcun difetto — e un test che fallisce
  a vuoto, con un messaggio che non aiuta a capirlo, è un test che qualcuno
  cancella.

**Non** si costruisca un rilevatore di duplicati più tollerante: un matcher più
permissivo aggancia commenti e funzioni simili, i suoi fallimenti diventano
rompicapi, e un analizzatore sintattico sarebbe una dipendenza nuova in un repo
che non ha né build step né parser. Il lavoro qui è di **onestà**, non di
potenza: dire che cos'è (un rilevatore di fumo) e rendere il fallimento
leggibile.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** ready-for-agent

- [ ] Il commento del test dichiara che cosa il controllo sul testo non sa vedere, e perché si è scelto comunque
- [ ] Il messaggio di fallimento dice quale frammento ha fatto scattare il controllo e come distinguere un difetto vero da un rinominamento
- [ ] La sensibilità del controllo è verificata rompendola di proposito, in entrambi i sensi: una copia che risorge lo fa fallire, un rinominamento innocente non lascia l'autore senza indicazioni
- [ ] Nessun analizzatore sintattico e nessuna dipendenza nuova

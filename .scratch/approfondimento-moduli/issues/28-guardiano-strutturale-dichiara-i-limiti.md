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

**Status:** done

- [x] Il commento del test dichiara che cosa il controllo sul testo non sa vedere, e perché si è scelto comunque
- [x] Il messaggio di fallimento dice quale frammento ha fatto scattare il controllo e come distinguere un difetto vero da un rinominamento
- [x] La sensibilità del controllo è verificata rompendola di proposito, in entrambi i sensi: una copia che risorge lo fa fallire, un rinominamento innocente non lascia l'autore senza indicazioni
- [x] Nessun analizzatore sintattico e nessuna dipendenza nuova

## Che cosa è stato fatto

Il lavoro era di **onestà**, non di potenza, e il risultato si legge in due
punti di `test/unit-sql-tabellare.js`.

**Una nota in testa al guardiano** che dice che cos'è: «QUESTO È UN RILEVATORE
DI FUMO, NON UN ANALIZZATORE». Con i due lati dichiarati:

1. **non vede la copia riscritta** — uno spazio diverso, l'ordine delle chiavi
   cambiato, una funzione anonima al posto di una dichiarazione, e la copia
   passa. Se il test è verde non è dimostrato che le copie non ci siano: è
   dimostrato che non ci sono *nella forma che avevano*;
2. **può fallire su modifiche innocenti** — chi rinomina legittimamente una
   variabile lo fa diventare rosso senza che esista alcun difetto.

E perché comunque così: un matcher più permissivo aggancerebbe commenti e
funzioni soltanto somiglianti, peggiorando proprio il lato 2; un analizzatore
sintattico sarebbe una dipendenza nuova in un repo senza build step né parser.
Il valore è nel costo: due righe che intercettano il ritorno più probabile della
copia, quello per copia-incolla. **Nessuna dipendenza nuova.**

**Un messaggio di fallimento che risponde in dieci secondi alla sola domanda che
conta.** I frammenti sorvegliati non sono più asserzioni sparse con una frase
ciascuna: sono un elenco (`SORVEGLIATI`) in cui ogni voce dichiara il testo
cercato, *che cosa* è e *dove* dovrebbe vivere. Il messaggio li stampa e poi
distingue i due casi:

```
PostgreSqlStrategy.js: trovato la riga finale di buildSelect, che dovrebbe
vivere solo in db/sqlTabellare.js.
  Frammento cercato (alla lettera): "return { table, whereSql, orderSql, limit, skip };"

  DUE CASI, e si distinguono guardando il file:
  1. DIFETTO — nell'adattatore è ricomparsa una copia di ciò che sta in
     db/sqlTabellare.js. Va tolta: la correzione di una copia non raggiunge
     l'altra, e nulla lo segnala finché i due motori non si comportano
     diversamente.
  2. FALSO ALLARME — quel testo è ricomparso per un altro motivo (un messaggio
     riformulato, un nome riusato in un contesto diverso). Allora va aggiornata
     la voce in SORVEGLIATI qui sopra, non cancellato il test.

  Questo controllo è un rilevatore di FUMO: cerca frammenti letterali, e una
  copia riscritta con altre parole gli sfugge. Vedi la nota in testa.
```

Il caso 2 è la parte che vale: prima un rinominamento legittimo lasciava
l'autore davanti a un rosso senza indicazioni, e un test che fallisce a vuoto
senza spiegarsi è un test che qualcuno cancella. Ora dice esplicitamente che la
risposta giusta può essere **aggiornare la voce**, non togliere il controllo.

Separato dai frammenti c'è il controllo sugli **import** (`require('./sqlTabellare')`,
`require('./sqlValori')`), che ha valore più alto perché non ha falsi allarmi: o
l'import c'è o non c'è.

## Sensibilità verificata nei DUE sensi

| prova | esito |
|---|---|
| copia che risorge alla lettera (`return { table, whereSql, orderSql, limit, skip };` rimesso in `PostgreSqlStrategy.js`) | **FALLISCE**, con il messaggio riportato sopra per esteso |
| copia **riscritta** (stessa riga con le chiavi in altro ordine: `return { limit, skip, table, whereSql, orderSql };`) | **PASSA** — ed è il punto: il limite dichiarato nella nota è reale, non teorico |

Ripristinati i file, `npm test` passa (esito 0).

La seconda riga della tabella non è un difetto del ticket: è la sua conclusione.
Il guardiano ora promette esattamente quanto mantiene.

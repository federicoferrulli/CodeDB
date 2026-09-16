# Benchmark di export e import — dataset e ambiente

Deliverable della **Fase 0** di `piano-export-import-database.md` (§12, «Benchmark
riproducibile»). Fissa *che cosa* si misura e *su cosa*, perché i numeri delle fasi
successive siano confrontabili fra loro. Non contiene misure: in questo ambiente non c'è
alcun motore di database, quindi non è stata eseguita nessuna prova prestazionale.

## Ambiente dichiarato

Ogni esecuzione registra, e nessun numero vale senza:

* CPU (modello, core fisici), RAM, tipo di disco (NVMe/SATA/rete) e filesystem;
* versione di Node, versione del motore e sua configurazione rilevante
  (`innodb_buffer_pool_size`, `shared_buffers`, `wiredTiger.engineConfig.cacheSizeGB`);
* se il motore è locale o remoto; banda e RTT misurati, non nominali;
* cache **fredda** o **calda**, dichiarata — non dedotta dalla posizione nella sequenza;
* se i tre motori girano in container, i limiti di CPU e memoria del container.

Tre esecuzioni per caso, riportate con mediana e scarto. Percentili solo con un numero di
campioni che li giustifichi.

## I cinque profili di dataset

Le dimensioni sono del **volume logico**, prima della compressione. Ogni profilo esiste
nelle tre taglie 1 GB, 10 GB e 100 GB; la prova di durata su 1 TB si esegue solo dove c'è
lo spazio, e usa il profilo `misto`.

| Profilo | Forma | Che cosa mette sotto stress |
|---|---|---|
| `molte-piccole` | 2.000 tabelle/collection da poche migliaia di righe | Costo per **oggetto**: catalogo, DDL, apertura file, voci di manifest. È il profilo in cui l'overhead di orchestrazione si vede, e il throughput dei byte non conta |
| `una-enorme` | Una sola tabella con l'intero volume, PK intera | Throughput puro e paginazione keyset. È il profilo di riferimento per il confronto con il tool nativo |
| `senza-chiave` | Come `una-enorme` ma **senza** PK né UNIQUE `NOT NULL`, con righe duplicate identiche | Il percorso `OFFSET` su PostgreSQL e la verifica dei dati senza chiave stabile (ordinamento esterno, molteplicità preservata) |
| `binario` | 60% del volume in BLOB/`bytea` **poco comprimibili** (byte casuali), documenti grandi su MongoDB | Compressione che non guadagna nulla, memoria per record singolo, tetto del record |
| `misto` | Un quarto di ciascuno dei precedenti, più geometrie, indici costosi (compositi, parziali, GIN/fulltext), view, routine e trigger | Il caso realistico, e l'unico su cui si misura la durata a 1 TB |

Ogni profilo esiste nelle tre varianti di motore (MySQL, PostgreSQL, MongoDB) con lo
stesso **volume logico**, non con lo stesso numero di righe: confrontare i tre motori a
parità di righe confronterebbe la larghezza delle righe, non i motori.

Il contenuto dei dati è generato da un seme dichiarato, così due esecuzioni sullo stesso
profilo contengono gli stessi byte.

## Che cosa si misura, separato

§2 del piano distingue i tempi, e la misura deve tenerli distinti o non serve a nulla:

1. **accettazione** del lavoro (ack della richiesta), che non include catalogo e snapshot;
2. **estrazione**: byte letti dalla sorgente, righe lette, tempo, e impatto sulla latenza
   della sorgente misurato con un carico concorrente;
3. **serializzazione e compressione**, separate dall'I/O di rete;
4. **scrittura dell'artefatto** e calcolo delle impronte;
5. **trasferimento** (download o upload), confrontato con lo stesso server che serve
   staticamente lo stesso file nelle stesse condizioni;
6. **caricamento** nella destinazione, **costruzione degli indici** e **verifica**, come
   tre voci distinte — un benchmark senza indici e senza verifica non si confronta con un
   ripristino che li esegue.

Si registrano anche i processi figli, i byte letti e scritti in più rispetto al volume
logico, e lo spazio occupato da staging e copia di recupero.

## Memoria

I budget di §7 (RSS del server ≤256 MiB per lavoro incorporato, renderer ≤64 MiB) si
misurano come **incremento** rispetto al processo a riposo, campionato durante il lavoro e
non alla fine. Il criterio che conta non è il valore assoluto ma la **forma**: passando da
10 GB a 100 GB l'incremento non deve crescere. Un budget rispettato a 1 GB e lineare non è
un budget rispettato.

## Che cosa manca

Il generatore dei dataset non è scritto. Scriverlo ora significherebbe consegnare un
programma che non è mai stato eseguito contro un motore vero — in questo ambiente non ce
n'è nessuno, e il demone Docker non è attivo. Va scritto insieme alla prima misura, che è
l'unica cosa che può dimostrare che genera davvero ciò che questo documento dichiara.

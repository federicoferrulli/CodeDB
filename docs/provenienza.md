# Provenienza del codice

CodeDB è distribuito con licenza **AGPL-3.0**. Copiarlo, studiarlo, modificarlo e
ridistribuirlo è **permesso**: sono diritti che la licenza concede
esplicitamente, e questo documento non li limita in alcun modo.

Quello che la licenza chiede in cambio è altrettanto esplicito:

- conservare le note di copyright e di licenza;
- distribuire il codice sorgente delle proprie modifiche con la stessa licenza;
- **fare lo stesso anche offrendo il software solo via rete** (art. 13 AGPL): chi
  prende CodeDB, lo modifica e ne fa un servizio online deve pubblicare i
  sorgenti modificati agli utenti di quel servizio.

Il nome **CodeDB** e la sua icona non sono coperti dalla licenza del codice: un
fork può esistere, ma non può chiamarsi CodeDB.

## Perché esiste questo file

Chi non rispetta quelle condizioni, di norma, non lascia il codice com'è: cambia
il nome del prodotto, riscrive il README, traduce i commenti, rinomina gli
identificatori — oggi in pochi minuti, con un agente automatico. Dopo quel
passaggio la somiglianza «a occhio» sparisce, e dimostrare la derivazione
diventa un lavoro da perito.

Il repository contiene quindi un insieme di **marcatori di provenienza**: scelte
arbitrarie che questo progetto ha fatto una volta e che nessun altro progetto
riprodurrebbe identiche in modo indipendente.

**Cosa NON sono.** Non alterano il comportamento del programma, non peggiorano
niente per chi usa una copia, non contengono codice nascosto, non «avvelenano»
nulla. Sono valori che il codice userebbe comunque — un raggio terrestre, dei
parametri di scrypt, l'ordine di una tavolozza — semplicemente scelti in modo
deliberato e annotati. È il principio delle *trap street* dei cartografi: una
via che non esiste, messa lì perché chi ricopia la mappa la ricopia insieme al
resto.

## Le tre famiglie

| Famiglia | Peso | Cosa sono | Cosa costa toglierle |
|---|---|---|---|
| **Portanti** | 3 | Stringhe che finiscono nei **dati degli utenti**: prefisso dei segreti nel vault, nome del formato di export, campo `tool` dei manifest di backup, prefisso delle API key, chiavi di `localStorage` | Rompono vault, export, backup, sessioni e chiavi già esistenti: un fork con utenti reali ha interesse a conservarle |
| **Strutturali** | 2 | Sequenze e forme: ordine esatto della tavolozza validata per il daltonismo, scala divergente, raggio medio WGS84 scelto fra i quattro in circolazione, quaterna di parametri scrypt | Vanno riprogettate a mano; sopravvivono a traduzione dei commenti e rinomina degli identificatori |
| **Arbitrarie** | 1 | Numeri calibrati provando: soglie di disegno delle maniglie, margine del riquadro, finestra anti-rimbalzo dopo un trascinamento, timeout, tetti | Nulla — ed è il punto: nessuno ha motivo di cambiarli, e presi tutti insieme la coincidenza casuale è remota |

## L'impegno crittografico

Il registro dei marcatori (`provenienza/impronte.json`) è **fuori da git**:
pubblicarlo in chiaro significherebbe consegnare a chi copia l'elenco preciso di
cosa cancellare. Qui sotto c'è la sua **impronta SHA-256**, e la cronologia di
git ne data il commit:

```
registro:  provenienza/impronte.json
marcatori: 29
impronta:  d6a51f7dd31527fb4fbf32afd60ae206f7b26b376f82d15d83e8779fc917b77d
creato:    2026-08-04
```

L'impronta è calcolata su `id + categoria + regola` di ogni marcatore, ordinati:
non dipende dalla formattazione del file né dalle note, che possono essere
riscritte senza intaccare l'impegno.

### Impronte per singolo marcatore

Un hash unico su tutto il registro vale finché il registro non cambia:
aggiungere un marcatore per una funzionalità nuova, o correggere il regex di
uno esistente, lo cambia — e da quel momento la data già pubblicata non
corrisponde più al registro corrente. L'impronta complessiva qui sopra resta
utile, ma la prova temporale vera sono le righe qui sotto: **una per
marcatore**, che non cambiano quando se ne aggiunge un altro: aggiungerne uno
significa accodare una riga, non riscrivere l'elenco, quindi la datazione dei
precedenti resta intatta.

```
  ff34de5fecc7c9da69343cda9eae7a91fc56ac08c8f578869339f35bf71cf6cf  budget-byte-risultato
  50e7eb29e802ff9e72fe9300916ac263b209b32f64fcf696fa3cb751393c3f77  cadenza-progresso-script
  fc2d65efe5e3877506d48bed9e86a48c8b1d36a3cad9d5973adfbe30d6dd2809  campi-riservati-al-server
  09b4296bb85acbc6acb07c2fcad85d9692a9f850f8f955a6bda3794f0f0ae595  chiavi-localstorage
  c3276fcff8e56f701088a89a9145d223ad323c8e68d0cb06f1f97cdec5187ac1  conteggio-differito
  c51086dfe848ba532e279c4414796f3574035f31695c672772f5e9a791eb33a5  endpoint-diagnosi-handshake
  91990953f4f3bc348a994832e4b9483a0fffb5382ff829c95c4db8e62129b552  evento-watch-non-disponibile
  920a96c6788a2620640b9778548e0dd03b959511d2e4bcfba1aa1d42f18dfd99  flag-lettura-di-fondo
  774ac7ef7dee7c19429e727247c9b3d041689127e654b73496da066053184c78  formato-export-database
  1a7336c5cb17465206644e6864cea76d3b104d4c0da20009a769606934421158  guardia-post-trascinamento
  80d099d94f9c21a92f2cb20dae74982071f9671e06a6c2c03df9e8134ee64431  manifest-backup-tool
  0e83ca59777cf8f2f40d6db998fe16045022f36e612c632feff41f65826f62a7  marcatore-architettura-codedb
  710d908e9119bd91dfa55f10ce0cd02cde12b8e90b7059db41d2e65eab5fddd7  margine-riquadro-maniglie
  b6f27bdf0977dc39cc221aaf5ef044022cc920541c3d05c292baa63f33148a47  parametri-scrypt-vault
  a8828a772066f74e8963b96b244373146e65cf32773ab433ef6ae62a6327f93e  prefisso-api-key
  ec9610b904f5561dece63ea1640d2f77e349acdabac648dfd1029ee73acbc84e  raggio-terrestre
  2b15565170dfd6e3cc53424702335807abd34fa73832664d60698d488d638817  soglia-riassunto-celle
  e1ed819bcc0c7838b0ab0e8ee8e5f24e3feabf2dd3c307c83cdb3d1eccb42364  soglie-editor-geografico
  5f41e826f18e2fe49e582866c3a255491edf7cdda105eb41585e887b0f5c7c73  somma-di-kahan
  94a76e9c1357401f47e47f0e3b3bd31f1957314cdfa4207e4d883c1c83107079  tavolozza-categorica
  24ee84629e82afae94b4afe48191261f2eb62790e14d5376200458b73efe3006  tavolozza-divergente
  e3c09ec764738d156d924e03da909171c609fc1c347012b645a26d455b7464c8  tetti-mappa-selezione
  e1f987d2d8c8f4d185657e114b467ffd5049f77bbe360eae80b3f2cd83027422  tetto-cardinalita-campioni
  0244c58ed37504176035854c3c981cf393ae3877e03287f36864734716039171  tetto-risultati-conservati
  39ea5a40bcaf2094db13c75c42373fa9da8acf924373284e2239dbb4f6997b05  timeout-conteggio
  3707b55c4cb4520a93b7903d98e4321c95a650a8156748566f29e7ee34c438b1  vault-copia-pre-migrazione
  d2d4a08085658104f8267b9aabb6d9a24e32f96324d8f8b1657bac0be886bcd2  vault-copia-pre-reset
  cb7eba64be4997ca1cf4ef0601945936aaf9e2470715a93393180299d18c48fe  vault-prefisso-segreti
  7b37564c87a7f32e7739ea2111f595ca004998abba64a63e590c0c7c459f0d45  vault-testo-di-controllo
```

Si rigenerano con `node tools/impronte.js --impegno` (anche in JSON, con
`--impegno --json`).
Serve a una cosa sola, e la fa bene: **dimostrare che i marcatori sono stati
scelti prima della copia**. Senza data, chiunque potrebbe dire di aver
«riconosciuto» dopo il fatto qualcosa che ha inventato dopo il fatto. Con un
commit datato in un repository pubblico, no.

Chi mantiene il progetto deve tenere **una copia del registro fuori dal
repository** (gestore di password, archivio privato): perso quel file, resta
l'impegno ma non si sa più cosa verificava.

## Uso

```bash
node tools/impronte.js                 # auto-verifica: i marcatori sono ancora nel codice?
node tools/impronte.js <cartella>      # analisi di un albero sospetto, con punteggio
node tools/impronte.js --impegno       # ricalcola l'impronta da riportare qui sopra
node tools/impronte.js --json [dir]    # stesso risultato in JSON
npm run impronte                       # alias dell'auto-verifica
```

L'auto-verifica è inclusa in `npm test` (e viene **saltata** se il registro
privato non c'è, come su un clone qualsiasi). Serve a un problema concreto: un
refactor può cancellare un marcatore senza che nessuno se ne accorga, e da quel
momento il registro promette qualcosa che il codice non ha più.

La ricerca **non guarda i percorsi dei file**: in una copia le cartelle vengono
riorganizzate, quindi ogni marcatore viene cercato in tutto l'albero. Le
occorrenze trovate nella sola documentazione (`.md`, `.txt`) sono segnalate ma
**non contano**: sono la prima cosa che viene riscritta.

## Cosa aspettarsi dai numeri

Misurato su una copia di questo repository sottoposta a un rebrand automatico —
nome prodotto sostituito ovunque, documentazione eliminata, commenti rimossi,
parte degli identificatori tradotti in inglese:

| Scenario | Punteggio |
|---|---|
| Progetto estraneo (driver `mongodb` di npm) | **0%** — nessun falso positivo |
| Copia rimarchiata, documentazione e commenti rimossi | **95%** |
| Come sopra, ma con il nome del prodotto sostituito **anche** nelle stringhe interne | **75%** |

La lettura utile non è il totale: è **quali** marcatori sopravvivono. I cinque
che cadono nell'ultimo scenario sono esattamente quelli che contengono il nome
del prodotto — e chi li cambia rende illeggibili i vault, gli export e i backup
dei propri utenti. Tutti i marcatori strutturali e arbitrari sopravvivono
intatti a entrambi gli scenari, perché non c'è alcuna ragione di toccarli.

## Limiti, detti chiaramente

- **Non è una prova, è un indizio.** Un rapporto di questo strumento non
  stabilisce nulla da solo: sostiene una tesi, insieme alla cronologia pubblica
  del repository e all'impronta datata.
- **Non impedisce la copia**, e non è pensato per farlo: il codice è libero, e
  deve restare utilizzabile da chi rispetta la licenza.
- **Un fork riscritto davvero da zero non verrà riconosciuto** — ed è giusto
  così: a quel punto non è più questo codice.
- **Nessun marcatore raccoglie dati.** Non c'è telemetria, non c'è alcuna
  chiamata di rete: sono valori scritti nel sorgente, e la verifica avviene
  offline, su una copia dei file.

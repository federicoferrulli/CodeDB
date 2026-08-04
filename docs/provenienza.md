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
marcatori: 28
impronta:  e25fbfa14736adf58d1f0c45107d61a661a62b3da479559d5e3bcf7fa47a983c
creato:    2026-08-04
```

L'impronta è calcolata su `id + categoria + regola` di ogni marcatore, ordinati:
non dipende dalla formattazione del file né dalle note, che possono essere
riscritte senza intaccare l'impegno.

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

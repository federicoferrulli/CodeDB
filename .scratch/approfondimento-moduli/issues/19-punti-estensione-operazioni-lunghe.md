# 19: I punti di estensione delle operazioni lunghe, dichiarati

**Cosa costruire:** gli otto punti che rendono speciale un'operazione lunga sono espliciti,
nominati e provati, invece di essere un'affermazione da riverificare a mano ogni volta che
qualcuno si chiede perché quell'evento non passa dalla giuntura dei dati.

Sono la terza famiglia di ADR-0001, ed è la loro esistenza a giustificarla:

1. rispondere prima che l'operazione finisca, e continuare a lavorare dopo la risposta;
2. emettere avanzamento durante l'esecuzione;
3. registrare un riferimento di annullamento che cambia nel tempo, anziché uno fissato
   all'ingresso — uno script ne cambia uno per istruzione;
4. leggere lo stato delle operazioni in corso senza registrarne una propria, che è il
   bisogno dell'evento di annullamento;
5. interrompere un'esecuzione che gira dentro CodeDB e non sul DBMS, e che quindi non si
   può fermare dal server del database;
6. decidere la categoria dell'audit a fine esecuzione anziché all'ingresso, perché su uno
   script interpretato la si conosce solo eseguendo;
7. verificare la capability per singola istruzione anziché per evento;
8. operare su stato di sessione che non è una strategia.

Ogni punto va reso un'estensione dichiarata della giuntura. Un'operazione lunga che non ne
usa nessuno non dovrebbe stare in questa famiglia: se ne emerge una, va spostata.

**Bloccato da:** 16.

**Status:** done

- [x] Gli otto punti sono estensioni dichiarate, non comportamenti impliciti
- [x] Ogni punto ha almeno un test che lo esercita attraverso l'interfaccia
- [x] L'annullamento non entra più in conflitto con la registrazione dell'operazione in corso
- [x] Pausa, ripresa, arresto e avanzamento di uno script funzionano da capo a fondo
- [x] I test dell'esecutore di script, dell'annullamento delle query e delle schede di risultato passano invariati

## Che cosa è stato fatto

Gli otto punti hanno un nome. `PUNTI_ESTENSIONE` li dichiara uno per uno con la
loro ragione; `OPERAZIONI_LUNGHE` dice quali usa ciascuno degli otto eventi:

| evento | punti dichiarati |
|---|---|
| `query:execute` | annullamentoMutevole, categoriaAuditFinale, interruzioneInProcesso, statoDiSessione |
| `script:execute` | rispostaAnticipata, avanzamento, annullamentoMutevole, interruzioneInProcesso, categoriaAuditFinale, capabilityPerIstruzione, statoDiSessione |
| `script:pause` | statoDiSessione, interruzioneInProcesso |
| `script:resume` | statoDiSessione |
| `script:state` | statoDiSessione, letturaOperazioniInCorso |
| `script:result` | statoDiSessione |
| `script:abort` | statoDiSessione, interruzioneInProcesso |
| `query:cancel` | letturaOperazioniInCorso, interruzioneInProcesso |

**`operazioneLunga()` non aggiunge comportamento: dichiara.** L'evento deve
comparire nella tabella con **almeno un punto**, e ogni punto dev'essere uno
degli otto nominati. È l'unica cosa che impedisce a questa famiglia di diventare
il cassetto dove finisce ciò che non si sa dove mettere — ed è esattamente il
requisito del ticket: «un'operazione lunga che non ne usa nessuno non dovrebbe
stare in questa famiglia».

Il messaggio d'errore dice anche **dove spostarla**:

```
Operazione lunga "operazione:senza:punti" non dichiarata in OPERAZIONI_LUNGHE.
Cosa fare: elenca i punti di estensione che usa fra gli otto di
PUNTI_ESTENSIONE. Se non ne usa nessuno non appartiene a questa famiglia:
registrala con delegate() se tocca una strategia, con amministrativo() se non
la tocca.
```

**Perché la giuntura non fa altro.** I corpi di questi handler sono lunghi e
diversissimi fra loro — avanzamento, pause, depositi, interpreti — e una
giuntura che provasse a governarli tutti diventerebbe l'interfaccia piena di
parametri opzionali che ADR-0001 ha deciso di **non** costruire. Qui il valore è
nel vincolo, non in codice condiviso: era la stessa scelta dell'ADR, e cambiarla
avrebbe voluto dire contraddirlo mentre lo si documenta.

## L'annullamento e la registrazione dell'operazione in corso

Il terzo requisito chiede che «l'annullamento non entri più in conflitto con la
registrazione dell'operazione in corso». Il conflitto è preciso, e ora è
**nominato**: `letturaOperazioniInCorso`. Se `query:cancel` passasse dalla
giuntura dei dati, questa registrerebbe un proprio `opHandle` sotto lo **stesso**
`runId` che l'annullamento sta cercando — cioè sovrascriverebbe proprio il
riferimento da annullare, e l'annullamento fermerebbe se stesso.

Il test lo esercita: registra un riferimento, chiede l'annullamento, e verifica
che la strategia riceva **quel** riferimento e che il registro non sia stato
sovrascritto.

## Come è stato provato

`test/unit-operazioni-lunghe.js` (16 prove, registrato in `test/unit.js`), sul
contesto finto del ticket 16.

**Le dichiarazioni**: gli otto punti hanno nome e descrizione e sono **otto e non
di più** (uno in più allargherebbe la famiglia in silenzio); ogni evento dichiara
i suoi; **ogni punto è usato da almeno un evento**, perché un punto che nessuno
usa non giustifica niente e la famiglia esiste proprio per giustificarsi.

**I vincoli, provati comportamentalmente** scrivendo una copia di server.js e
caricandola:

* un'operazione lunga non dichiarata **non si registra** — `registraEventi`
  lancia all'avvio;
* un punto scritto male (`statoDiSessioni` invece di `statoDiSessione`) è un
  **errore**, non una capacità che resta spenta in silenzio. È la stessa classe
  di difetto già chiusa per le capacità della griglia.

**I punti, esercitati attraverso l'interfaccia**: `script:state` legge il
registro degli script dalla sessione (e senza registro risponde con un elenco
vuoto, non con un errore: chiedere lo stato di ciò che non gira è una domanda
legittima); `query:cancel` legge senza registrare e alza il flag di
interruzione che ferma ciò che gira **dentro** CodeDB; annullare ciò che non è
registrato risponde `cancelled: false` invece di inventare.

## Un difetto trovato di rimbalzo, di nuovo

Come per il ticket 18, `test/unit-handler-scope.js` ha perso di vista gli otto
eventi migrati — e questa volta se n'è accorta la **seconda** guardia, non la
prima: «handler script:execute non riconosciuto: il controllo non starebbe
guardando il punto che lo ha motivato». Quel test ha due guardie contro il
proprio marcire, e in questo lotto hanno lavorato entrambe. Ora riconosce tutte
e quattro le forme di registrazione e copre 80 handler.

## Suite eseguite

`npm test` (esito 0) e, con i due container dedicati:

| suite | FAIL | baseline |
|---|---|---|
| `e2e-script-runner.js` | 0 | 0 |
| `e2e-query-cancel.js` | 0 | 0 |
| `e2e-script-risultati.js` | 0 | 0 |
| `e2e-mongo-script.js` | 0 | 0 |
| `e2e.js` (MongoDB) | 4 | 4 |
| `e2e-mysql.js` | 2 | 2 |
| `e2e-postgres.js` | 3 | 3 |
| `e2e-rbac.js` | 0 | 0 |

**Nessun fallimento nuovo.** Pausa, ripresa, arresto e avanzamento di uno script
sono coperti da `e2e-script-runner.js`, che passa invariato.

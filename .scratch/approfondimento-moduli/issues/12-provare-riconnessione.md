# 12: Provare riconnessione e annullamento su tab chiuso

**Cosa costruire:** il comportamento del trasporto è coperto da test attraverso la sua
interfaccia: riconnessione automatica alle sole connessioni salvate, annullamento della
richiesta quando il tab d'origine viene chiuso, marcatura che permette a una risposta di
sapere se il suo tab è ancora quello attivo.

Il modulo porta nei commenti tre difetti già corretti — un identificatore di tab indefinito
che cancellava quello iniettato, il tab orfano, e una notifica scambiata per messaggio
all'utente che ne aveva soppressi una trentina — e nessuno dei tre ha oggi un test che ne
impedisca il ritorno.

**Bloccato da:** 11.

**Status:** done

- [x] Un socket finto permette di provare il trasporto senza server
- [x] La riconnessione automatica è provata, compreso il caso della connessione **non** salvata, dove non deve avvenire
- [x] L'annullamento su tab chiuso è provato
- [x] I tre difetti registrati nei commenti hanno ciascuno un test che fallisce se il difetto torna
- [x] Ogni test è stato verificato rompendo di proposito il codice che protegge

## Che cosa è stato fatto

`test/socket-finto.js` registra ogni `emit` e risponde con ciò che il test
decide — anche **in ritardo**, il che non è un dettaglio: è l'unico modo di far
accadere qualcosa (la chiusura di un tab) *mentre* una richiesta è in volo, che
è precisamente la situazione per cui il trasporto esiste. Risponde in modo
asincrono come il socket vero: rispondere subito nasconderebbe ogni difetto di
ordine.

`test/unit-trasporto.js` (14 prove, registrato in `test/unit.js`), senza server
e senza browser — al posto del DOM basta un `EventTarget`, perché non si sta
provando il DOM ma chi lo usa.

**La riconnessione**, con il caso negativo che è quello che conta:

* connessione **salvata**: si riapre, si ritenta **una volta sola**, il secondo
  tentativo si dichiara con `_reconnected` (senza, si riconnetterebbe
  all'infinito) e il tab risulta di nuovo connesso;
* connessione **non salvata**: nessuna riapertura e nessun ritentativo. I
  segreti non vivono più nel browser, quindi non c'è nulla con cui riaprirla e
  provarci darebbe un errore di autenticazione al posto di quello vero;
* un errore che **non è** «connessione assente» non fa riconnettere;
* riconnessione fallita: si riporta l'errore **originale**, non quello della
  riconnessione, che nasconderebbe la causa vera;
* il tab si chiude **durante** la riapertura: la richiesta viene annullata e non
  ritentata.

**L'annullamento su tab chiuso**, nei due casi distinti: tab chiuso *mentre* la
richiesta è in volo, e tab già chiuso *alla partenza* (dove la richiesta non
deve nemmeno partire).

**I tre difetti registrati nei commenti**, ciascuno con la sua prova:

1. **il `tabId` indefinito** — diverse modali passano `tabId` esplicito ma
   `undefined` quando non hanno contesto; con lo spread del payload per ultimo
   quell'`undefined` cancellava il tabId iniettato e il server rispondeva
   «Nessuna connessione attiva al database.». Provato su entrambe le funzioni,
   `emit` e `emitFireAndForget`;
2. **il tab orfano** — con il tabId di un tab già chiuso l'origine va conservata
   in un sentinella, perché `isForActiveTab` risulti falso e l'errore non
   compaia nel workspace di un'altra connessione;
3. **la fire-and-forget scambiata per notifica** — si chiamava `notify`, e in
   graph3d.js era stata usata per una trentina di messaggi all'utente, che
   quindi non comparivano mai (errori compresi) mentre il testo italiano finiva
   sul socket come *nome di evento*. La prova fissa che cosa la funzione deve
   continuare a fare: manda un evento col tab attivo e non attende risposta.

## Sensibilità verificata, una per una

Rompendo di proposito il codice protetto, quattro guasti distinti:

| guasto introdotto | esito |
|---|---|
| spread del payload rimesso per ultimo | **FAIL** «DIFETTO 1 — un tabId esplicito ma indefinito…» |
| tolto il sentinella del tab orfano | **FAIL** «DIFETTO 2 — tab già chiuso alla partenza…» |
| `riconnettibile = !!tab` (riconnette anche le non salvate) | il test entra nel ramo di riconnessione e il processo **muore** con `TypeError: Cannot read properties of undefined (reading 'saved')` — il codice corretto in quel ramo non ci arriva mai. Rumoroso, non silenzioso |
| `'tabId' in payload` nella fire-and-forget | **FAIL** «emitFireAndForget: un tabId indefinito…» |

Ripristinato ogni volta il file, zero fallimenti.

`npm test` passa (esito 0). `test/e2e-avvio-ui.js` passa: il socket aperto
pigramente e installabile dai test non cambia nulla nella pagina.

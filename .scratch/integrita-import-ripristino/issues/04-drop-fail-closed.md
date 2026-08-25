# 04: Rendere ogni drop fail-closed

Status: resolved
Type: task
Blocked by: 01

Eliminare tutti i `catch` generici attorno alle cancellazioni preparatorie di import e
restore. È ignorabile soltanto l'errore specifico che dimostra l'assenza della risorsa.

- [x] MongoDB distingue namespace inesistente da autorizzazione, rete e timeout
- [x] PostgreSQL distingue tabella inesistente dagli altri errori
- [x] L'import completo non scarta più alcun errore di drop
- [x] Un drop fallito impedisce create e insert successivi
- [x] L'audit registra il bersaglio e l'errore originale
- [x] Il test collauda ogni ramo attraverso il motore, non leggendo il sorgente
- [x] La sensibilità viene dimostrata reintroducendo un catch generico

## Risposta

`eliminaSePresente` ignora esclusivamente `NamespaceNotFound`/codice 26 su MongoDB e
`42P01` su PostgreSQL. Tutti gli altri errori conservano istanza, codice, codeName e
bersaglio fino allo stato dell'operazione e all'audit. Restore e promozione non hanno
più catch generici sui drop. La controprova con un catch generico ha fatto fallire
`unit-drop-fail-closed` per mancata propagazione dell'errore di autorizzazione.

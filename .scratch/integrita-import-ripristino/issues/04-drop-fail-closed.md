# 04: Rendere ogni drop fail-closed

Status: ready-for-agent
Type: task
Blocked by: 01

Eliminare tutti i `catch` generici attorno alle cancellazioni preparatorie di import e
restore. È ignorabile soltanto l'errore specifico che dimostra l'assenza della risorsa.

- [ ] MongoDB distingue namespace inesistente da autorizzazione, rete e timeout
- [ ] PostgreSQL distingue tabella inesistente dagli altri errori
- [ ] L'import completo non scarta più alcun errore di drop
- [ ] Un drop fallito impedisce create e insert successivi
- [ ] L'audit registra il bersaglio e l'errore originale
- [ ] Il test collauda ogni ramo attraverso il motore, non leggendo il sorgente
- [ ] La sensibilità viene dimostrata reintroducendo un catch generico


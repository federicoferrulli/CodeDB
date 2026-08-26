# 11: Esportare CSV conformi e sicuri per fogli elettronici

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** L'utente deve ottenere un CSV strutturalmente corretto e poter scegliere
una modalità che neutralizza le celle interpretabili come formule.

- [ ] Header e celle condividono lo stesso escaping conforme al formato CSV
- [ ] Virgole, quote, CRLF e righe nuove sopravvivono a un round trip
- [ ] La modalità sicura neutralizza celle che iniziano con =, +, - o @
- [ ] La modalità letterale resta disponibile ed è descritta come tale
- [ ] Test coprono header ostili e formule in valori provenienti dal database
- [ ] La controprova senza neutralizzazione rende rosso il test della modalità sicura


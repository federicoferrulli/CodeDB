# 06: Dichiarare e preservare gli oggetti di schema SQL

Status: ready-for-agent
Type: task
Blocked by: 03, 04

Allineare l'export database UI alla copertura degli oggetti SQL del backup e dichiarare
nel manifest quali capacità sono presenti.

- [ ] PostgreSQL conserva view, routine, trigger, sequenze e relativi valori
- [ ] MySQL conserva view, routine, trigger ed eventi supportati
- [ ] L'ordine di creazione rispetta le dipendenze fra oggetti
- [ ] Oggetti non supportati o non autorizzati producono un esito esplicito
- [ ] Un artefatto dati-only non viene presentato come export completo del database
- [ ] Il manifest dichiara capacità, oggetti inclusi e omissioni intenzionali
- [ ] La verifica finale confronta presenza e definizione degli oggetti

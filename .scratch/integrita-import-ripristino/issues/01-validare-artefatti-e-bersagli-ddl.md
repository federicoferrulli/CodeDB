# 01: Validare artefatti e bersagli DDL

Status: ready-for-agent
Type: task
Blocked by: nessuno

Costruire il confine di fiducia unico per export di database e backup. La validazione
deve normalizzare l'artefatto, estrarre il bersaglio effettivo di ogni DDL e rifiutare
qualsiasi istruzione che modifichi una risorsa diversa da quella dichiarata.

- [ ] Un file formalmente valido con DDL distruttiva o estranea viene rifiutato prima di ogni mutazione
- [ ] La presenza testuale del nome atteso non è considerata prova del bersaglio
- [ ] DDL di collezione e oggetti di schema legittime dei tre motori continuano a passare
- [ ] Checksum e autenticità sono trattati come proprietà distinte
- [ ] UI, CLI e restore consumano la stessa validazione; nessuna regex parallela sopravvive
- [ ] I test coprono almeno `ALTER` su altra tabella, `DROP`, `TRUNCATE`, oggetti cross-database e DDL multiple
- [ ] La sensibilità del test viene verificata disabilitando intenzionalmente il controllo del bersaglio

## Commenti

Questo ticket chiude insieme il varco del file `.codedb.json` e la validazione debole del
DDL dei backup: sono lo stesso difetto al confine di fiducia.


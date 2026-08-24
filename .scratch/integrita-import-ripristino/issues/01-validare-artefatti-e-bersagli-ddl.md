# 01: Validare artefatti e bersagli DDL

Status: resolved
Type: task
Blocked by: nessuno

Costruire il confine di fiducia unico per export di database e backup. La validazione
deve normalizzare l'artefatto, estrarre il bersaglio effettivo di ogni DDL e rifiutare
qualsiasi istruzione che modifichi una risorsa diversa da quella dichiarata.

- [x] Un file formalmente valido con DDL distruttiva o estranea viene rifiutato prima di ogni mutazione
- [x] La presenza testuale del nome atteso non è considerata prova del bersaglio
- [x] DDL di collezione e oggetti di schema legittime dei tre motori continuano a passare
- [x] Checksum e autenticità sono trattati come proprietà distinte
- [x] UI, CLI e restore consumano la stessa validazione; nessuna regex parallela sopravvive
- [x] I test coprono almeno `ALTER` su altra tabella, `DROP`, `TRUNCATE`, oggetti cross-database e DDL multiple
- [x] La sensibilità del test viene verificata disabilitando intenzionalmente il controllo del bersaglio

## Commenti

Questo ticket chiude insieme il varco del file `.codedb.json` e la validazione debole del
DDL dei backup: sono lo stesso difetto al confine di fiducia.

## Risposta

Introdotto `db/artefatti.js` come confine unico server-side per normalizzare export e
layer di backup, estrarre tipo e bersaglio effettivo delle DDL e rifiutare istruzioni o
qualificatori estranei. L'import UI passa dall'evento `artifact:validate`; CLI e restore
passano dal preflight della catena prima di qualsiasi mutazione. Integrità tramite
checksum e autenticità sono esposte separatamente.

La suite unitaria completa passa. La controprova è stata eseguita disabilitando il
confronto del bersaglio: il caso `ALTER TABLE clienti` contenente testualmente `ordini`
è diventato rosso, quindi la barriera è sensibile al difetto originale.

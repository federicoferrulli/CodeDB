# Etichette di triage

Le skill ragionano in termini di cinque **ruoli** canonici di triage. Questo file mappa
quei ruoli alle stringhe di etichetta effettivamente usate dal tracker di questo repo.

| Etichetta in mattpocock/skills | Etichetta nel nostro tracker | Significato                                        |
| ------------------------------ | ---------------------------- | -------------------------------------------------- |
| `needs-triage`                 | `needs-triage`               | Il manutentore deve ancora valutare la issue        |
| `needs-info`                   | `needs-info`                 | In attesa di ulteriori informazioni dal segnalatore |
| `ready-for-agent`              | `ready-for-agent`            | Del tutto specificata, pronta per un agente in autonomia |
| `ready-for-human`              | `ready-for-human`            | Richiede implementazione umana                      |
| `wontfix`                      | `wontfix`                    | Non verrà presa in carico                           |

Quando una skill nomina un ruolo (per esempio «applica l'etichetta di triage
"pronta per l'agente"»), usa la stringa corrispondente nella colonna di destra.

Il tracker di questo repo è a **markdown locale**: queste stringhe non sono etichette di
un sistema esterno, ma il valore della riga `Status:` in cima al file della issue
(vedi `issue-tracker.md`).

Per cambiare vocabolario si modifica **solo la colonna di destra**: la sinistra è il nome
del ruolo con cui parlano le skill e non va toccata.

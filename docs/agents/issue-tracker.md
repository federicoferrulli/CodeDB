# Tracciamento delle issue: markdown locale

Le issue e le specifiche di questo repo vivono come file markdown sotto `.scratch/`.

## Convenzioni

- Una funzionalità per cartella: `.scratch/<slug-funzionalita>/`
- La specifica è `.scratch/<slug-funzionalita>/spec.md`
- Le issue di implementazione sono **un file per ticket** in
  `.scratch/<slug-funzionalita>/issues/<NN>-<slug>.md`, numerate da `01`; mai un unico
  file che raccoglie tutti i ticket
- Lo stato di triage è una riga `Status:` in cima al file della issue (le stringhe dei
  ruoli sono in `triage-labels.md`)
- Commenti e cronologia della discussione si accodano in fondo al file sotto un titolo
  `## Commenti`

## Quando una skill dice «pubblica sul tracker delle issue»

Crea un nuovo file sotto `.scratch/<slug-funzionalita>/`, creando la cartella se manca.

## Quando una skill dice «recupera il ticket pertinente»

Leggi il file al percorso indicato. Di norma l'utente passa direttamente il percorso o il
numero della issue.

## Operazioni di wayfinding

Usate da `/wayfinder`. La **mappa** è un file con un file **figlio** per ticket.

- **Mappa**: `.scratch/<impresa>/map.md` (il corpo Note / Decisioni-finora / Nebbia).
- **Ticket figlio**: `.scratch/<impresa>/issues/NN-<slug>.md`, numerati da `01`, con la
  domanda nel corpo. Una riga `Type:` registra il tipo di ticket
  (`research`/`prototype`/`grilling`/`task`); una riga `Status:` registra
  `claimed`/`resolved`.
- **Blocchi**: una riga `Blocked by: NN, NN` in cima. Un ticket è sbloccato quando ogni
  file elencato è `resolved`.
- **Frontiera**: scorri `.scratch/<impresa>/issues/` cercando i file aperti, sbloccati e
  non presi in carico; vince il primo per numero.
- **Presa in carico**: imposta `Status: claimed` e salva **prima** di iniziare il lavoro.
- **Risoluzione**: accoda la risposta sotto un titolo `## Risposta`, imposta
  `Status: resolved`, poi accoda un puntatore di contesto (sintesi + collegamento) alle
  Decisioni-finora in `map.md`.

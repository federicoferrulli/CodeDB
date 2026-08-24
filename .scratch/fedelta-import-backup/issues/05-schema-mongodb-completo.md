# 05: Preservare lo schema logico MongoDB

Status: ready-for-agent
Type: task
Blocked by: 01

Estendere manifest ed export completo perché collection e indici vengano ricreati con
le stesse proprietà osservabili.

- [ ] Opzioni della collection e validator vengono esportati e ripristinati
- [ ] Le view MongoDB conservano sorgente e pipeline
- [ ] Gli indici conservano sparse, TTL, partial filter, collation e wildcard projection
- [ ] Le opzioni non applicabili sono rifiutate o dichiarate, non eliminate in silenzio
- [ ] Gli indici interni non vengono duplicati
- [ ] Export UI e backup descrivono gli stessi metadati canonici
- [ ] Un confronto post-restore verifica opzioni e non soltanto nome e chiavi

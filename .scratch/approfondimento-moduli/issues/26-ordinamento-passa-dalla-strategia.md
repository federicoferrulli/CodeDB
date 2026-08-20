# 26: L'ordinamento della griglia passa dalla strategia e conosce le colonne

**Cosa costruire:** un motore che ha bisogno di ordinare in modo diverso lo
ottiene sovrascrivendo il proprio metodo di ordinamento, e la modifica si vede
**anche nella griglia dati** — che è il posto dove l'ordinamento si guarda. E
chi compone l'ordinamento sa se la colonna ammette valori nulli.

Nessun cambiamento di comportamento visibile: è il prefactor che rende possibile
il ticket successivo.

Due difetti, la stessa giuntura:

**Il punto di estensione è saltato.** La composizione dei pezzi della SELECT non
passa più dal metodo di ordinamento della strategia ma direttamente dalla
funzione legata al dialetto. Sovrascrivere quel metodo — che è l'idioma di
questo strato: la classe base propone, il motore corregge, come già fanno la
rinomina nativa, il DDL ausiliario e l'osservazione dei cambiamenti — oggi
funzionerebbe per la tab ⚡ e verrebbe **ignorato in silenzio dalla griglia**.
Due ordinamenti diversi nello stesso motore a seconda della strada, senza alcun
errore: è la divergenza silenziosa che il modulo comune doveva eliminare,
riapparsa fra due funzioni invece che fra due file.

**I metadati arrivano troppo tardi.** L'ordinamento viene composto in modo
sincrono *prima* che la lettura dei metadati di colonna sia partita. Finché
resta lì, chi compone l'ordinamento non può sapere nulla della colonna su cui
ordina — e il ticket 27 ha bisogno esattamente di quello. I metadati sono già
letti a ogni pagina, con una cache di pochi secondi: il costo di spostare la
composizione dopo di essi è nullo, il costo di leggerli due volte no.

**Bloccato da:** 25 (cambia la firma di funzioni che la 25 sta togliendo dalla
superficie pubblica: farlo prima significherebbe scrivere prove contro una
superficie che la 25 poi cancella).

**Status:** ready-for-agent

- [ ] Sovrascrivere il metodo di ordinamento di una strategia si riflette su tutti i percorsi che ordinano, griglia compresa
- [ ] Esiste un test che fallisce se quel punto di estensione viene di nuovo scavalcato — e la sua sensibilità è verificata rompendolo di proposito
- [ ] Chi compone l'ordinamento può sapere quali colonne ammettono valori nulli, senza letture di catalogo aggiuntive rispetto a oggi
- [ ] La paginazione a chiave (keyset) e il suo ripiego su OFFSET si comportano esattamente come prima
- [ ] Nessun cambiamento osservabile: stessa SQL prodotta, a parità di richiesta
- [ ] I test end-to-end dei due motori SQL passano invariati

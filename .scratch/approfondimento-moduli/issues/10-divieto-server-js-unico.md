# 10: Definizione unica del divieto degli operatori server-side

**Cosa costruire:** il divieto degli operatori che fanno eseguire JavaScript al server
MongoDB è definito in un posto solo e chiamato da tutti.

Oggi ne esistono tre versioni: quella autorevole nel modulo delle capability, una copia
nel server, e una terza sotto forma di espressione regolare applicata al testo di un
messaggio d'errore. Tre versioni della stessa regola sono tre occasioni di divergere.

La copia nel server è **superficiale** nel senso preciso del termine: cancellarla concentra
la complessità nel modulo autorevole, senza che alcun chiamante ne assorba.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** ready-for-agent

- [ ] Esiste una sola definizione del divieto, e le altre due sono rimosse
- [ ] Tutti i punti che applicavano il divieto chiamano quella definizione
- [ ] Un test copre il divieto attraverso almeno due percorsi diversi
- [ ] Il gateway e i test di autorizzazione passano invariati

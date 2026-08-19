# 03: Modulo tabellare comune — le quattro funzioni identiche

**Cosa costruire:** la composizione dell'identificatore di riga, la sua lettura, la
costruzione dell'ordinamento e quella della lista di selezione smettono di esistere in due
copie, una per motore SQL, e vivono in un modulo solo che i due adattatori chiamano.

Le quattro sono oggi byte per byte identiche fra i due adattatori, messaggio d'errore e
costanti compresi: correggerne una richiede due modifiche, e nulla segnala la seconda.

Sono funzioni pure — ricevono descrittori di colonna e restituiscono frammenti — quindi si
provano senza alcun database acceso, che oggi non è possibile per nessuna di esse.

**Bloccato da:** nessuno (si può iniziare subito).

**Status:** ready-for-agent

- [ ] Le quattro funzioni hanno una sola implementazione, chiamata da entrambi gli adattatori SQL
- [ ] Ognuna ha test unitari che girano senza database
- [ ] Almeno un test è stato verificato rompendo di proposito il codice che protegge
- [ ] I test end-to-end dei due motori SQL passano invariati
- [ ] Il comportamento osservabile non cambia in nessun caso

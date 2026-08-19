# 07: I tetti imposti dalla giuntura, con adattatore finto

**Cosa costruire:** i tetti su righe, byte e tempo smettono di essere funzioni che ogni
adattatore può ricordarsi o dimenticarsi di chiamare, e diventano vincoli che la giuntura
applica avvolgendo l'esecuzione. L'adattatore fornisce solo il pezzo che varia fra motori.

Oggi la loro applicazione è a macchia: alcuni tetti valgono su un motore e non sugli altri,
e il difetto chiuso dal ticket 01 era un caso di questa classe. Un motore aggiunto in
futuro deve nascere già limitato.

Il ticket porta anche l'adattatore finto in memoria che rende i tetti provabili senza un
database acceso: è la giuntura su cui si appoggeranno le prove dei lotti successivi.

**Bloccato da:** 01.

**Status:** ready-for-agent

- [ ] I tetti sono applicati dalla giuntura per tutti e tre i motori
- [ ] Un adattatore finto in memoria permette di provarli senza database
- [ ] Esiste un test per ciascun tetto — righe, byte, tempo — che dimostra l'interruzione
- [ ] Un adattatore che non fa nulla per rispettarli viene comunque limitato, e un test lo prova
- [ ] Almeno un test è stato verificato rompendo di proposito il codice che protegge
- [ ] I test end-to-end dei tre motori passano invariati

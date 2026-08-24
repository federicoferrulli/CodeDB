# 32: Le celle geometriche si disegnano in qualunque griglia

**Cosa costruire:** una cella che contiene una geometria si riconosce e si apre su mappa
anche in un riquadro della Split-View e — dove ha senso — nella tabella dei risultati.

Il riconoscimento (`geo-risultati.js`) e la vista (`geo-vista.js`) sono già moduli riusabili
e già usati da due chiamanti diversi: manca l'aggancio dalla cella di una griglia che non
sia quella della vista Dati.

**Bloccato da:** 13.

**Status:** done

- [x] La resa di una cella geometrica è una funzione che una qualunque griglia può chiamare
- [x] La capacità `geometrie` di un riquadro Split-View si accende, con un test
- [x] La vista Dati si comporta come oggi

## Che cosa è stato fatto

`public/js/cella-geometria.js` è la resa comune alle tre griglie: etichetta,
classe `type-geo` sulla **cella**, aiuto nel `title` e doppio clic. La capacità
`geometrie` di un riquadro Split-View è accesa e dichiarata in
`CAPACITA_RIQUADRO`.

La parte che mancava non era la resa ma **che cosa significhi «aprire»**. Non è
una proprietà della vista, è una proprietà della **cella**: una riga senza `_id`
— una vista SQL, un result set, una griglia in sola lettura — non è
riscrivibile. Il doppio clic veniva però agganciato sempre alla stessa apertura
in modifica, quindi su quelle righe l'utente riceveva un editor con «Applica
geometria», disegnava, e il salvataggio partiva come `doc:update` con `id`
indefinito: un errore restituito **dopo** il lavoro, non prima.

Ora la decisione sta in un posto solo (`aperturaCella`) e ogni griglia dichiara
nei propri termini quando una cella è modificabile — `col !== '_id'` più
l'identità della riga nella vista Dati, più il permesso di selezione in un
riquadro. `aperturaSolaLettura` è la via della tab ⚡, dove non c'è nulla da
riscrivere; è la stessa funzione, non una terza copia della chiamata a
`openGeoEditor`.

## Come è stato provato

`test/e2e-geometrie-viste.js` (Chromium, socket finto, 27 prove): resa condivisa
sui tre tipi di geometria, apertura in sola lettura nella tab ⚡, riquadro reale
di Split-View che disegna, apre in modifica e salva su **tab, database e
collection propri**, riquadro senza `_id` che apre in sola lettura, vista Dati
invariata più il suo caso senza `_id`.

L'assertione sulla classe si controlla sul `td` e **non** su un discendente:
`displayValue` marca già `type-geo` sullo span di ripiego, quindi la forma
larga (`td.classList.contains(...) || td.querySelector('.type-geo')`) passava
anche a capacità **spenta** — cioè non provava ciò che il ticket chiede.

**Sensibilità verificata rompendo il codice di proposito**, tre volte:
`geometrie: false` sul riquadro → 4 prove falliscono (prima ne falliva 1);
apertura sempre in sola lettura → fallisce la modifica in Split-View;
apertura sempre in modifica → falliscono le tre prove sulle righe senza `_id`.
Ripristinato il codice, zero fallimenti.

Eseguiti verdi: `npm test`, `e2e-geometrie-viste`, `e2e-avvio-ui`,
`e2e-griglia-viste`, `e2e-fk-viste`, `e2e-selezione-celle-viste`,
`e2e-tocco-griglia`, `e2e-playwright` (19 superati, 0 falliti).
Non eseguiti i test che richiedono un DB reale (`e2e.js`, `e2e-mysql.js`,
`e2e-postgres.js`): questo lotto non tocca il server.

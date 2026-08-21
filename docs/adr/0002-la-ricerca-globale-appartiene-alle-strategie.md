# La ricerca globale appartiene alle strategie

La vista Dati deve cercare una sottostringa nei valori di tutti i campi rilevati, anche
quando un campo non compare nella pagina corrente e quando il valore vive dentro JSON,
documenti o array. Far comporre al browser un elenco di colonne lega il risultato alla
pagina caricata e duplica nel client le regole dei tre motori.

**Abbiamo deciso che il browser invia soltanto l'intenzione `contieneOvunque`.** Ogni
strategia la traduce in una query parametrizzata usando i propri metadati: tutte le
colonne dichiarate per MySQL e PostgreSQL; un catalogo di percorsi campionato e arricchito
incrementalmente per MongoDB e per le colonne JSON di MySQL. La ricerca considera i
valori scalari, non i nomi delle chiavi, ed è letterale e senza distinzione fra maiuscole
e minuscole.

## Consequences

La correttezza non dipende più dalle colonne visibili nel browser e non esiste un tetto
silenzioso. Il catalogo dei motori senza schema conserva solo percorsi e tipi, mai i
documenti, ma un campo raro non ancora osservato può entrare nella ricerca solo dopo un
nuovo campionamento o dopo essere comparso in un risultato. La vista Dati espone soltanto
`Cerca` e `Condizione`; pipeline MongoDB e SQL Raw restano nell'editor Query & Aggregate.

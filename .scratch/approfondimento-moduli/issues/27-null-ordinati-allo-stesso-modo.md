# 27: I valori nulli si ordinano allo stesso modo su tutti i motori

**Cosa costruire:** lo stesso clic sulla stessa intestazione di colonna produce
lo stesso ordine su MySQL, PostgreSQL e MongoDB. Oggi non è così, e la
differenza non è marginale: è la posizione di tutte le righe con quel campo
vuoto.

Misurato su motori veri, stessi tre valori, `ORDER BY nome`:

| motore | ASC | DESC | regola implicita |
| --- | --- | --- | --- |
| MySQL | `<NULL>` aldo bruno | bruno aldo `<NULL>` | NULL è il più **piccolo** |
| MongoDB | `<NULL>` `<assente>` aldo bruno | bruno aldo `<NULL>` `<assente>` | NULL è il più **piccolo** |
| PostgreSQL | aldo bruno `<NULL>` | `<NULL>` bruno aldo | NULL è il più **grande** |

**La regola scelta: il valore nullo è il più piccolo.** Due motori su tre la
seguono già, quindi cambia solo PostgreSQL, e su MongoDB un campo *assente*
resta accanto a un campo nullo. La regola è una proprietà della griglia di
CodeDB, non di un motore: sta nel modulo comune. Ciò che cambia è solo come
ciascun dialetto la **scrive** — PostgreSQL con un suffisso esplicito, MySQL con
niente, perché il suo comportamento predefinito già coincide.

Che coincida va **provato su un MySQL vero**, non assunto: senza quella prova la
regola su MySQL si regge su una coincidenza che nessuno sorveglia.

## Il prezzo, e perché si paga

Su PostgreSQL l'indice btree colloca i nulli in fondo. Chiedere l'ordine opposto
lo rende inservibile per l'ordinamento. Misurato su 200.000 righe con indice
sulla colonna, la query di una pagina di griglia:

```
ORDER BY n ASC                  0,042 ms   Index Scan
ORDER BY n ASC NULLS FIRST      6,508 ms   Seq Scan + Sort
```

Circa 150 volte, e il divario cresce con la tabella. Si paga perché ogni
alternativa sposta lo stesso costo su un motore diverso senza toglierlo:
allineare nel verso opposto costringerebbe MySQL a ordinare per un'espressione
(indice perso lì) e MongoDB a una pipeline di aggregazione al posto di un sort.
Questa direzione lo paga sul motore di minoranza, e solo dove i nulli esistono
davvero.

**La mitigazione, e la trappola che contiene.** Su una colonna che non ammette
nulli i motori non possono differire, quindi il suffisso è inutile e va omesso —
ed è lì che si recupera quasi tutto, perché si ordina soprattutto per chiavi e
identificatori. Attenzione: **PostgreSQL non se ne accorge da solo.** Su una
colonna dichiarata NOT NULL con indice, il suffisso esplicito produce comunque
Seq Scan + Sort; il planner non riconosce che è un'operazione nulla. L'omissione
deve farla CodeDB, non il database.

## Confini

- Vale **solo per l'ordinamento strutturato**, quello prodotto dal clic
  sull'intestazione. L'SQL libero scritto nella tab ⚡ non si riscrive mai: se
  l'utente ordina a mano, comanda lui — suffisso compreso.
- Nessuna impostazione per disattivare l'allineamento. È un non-obiettivo
  esplicito: la griglia ha un comportamento solo. Se emergesse un utente con
  tabelle PostgreSQL grandi e ordinamenti su colonne nullable, si riapre.
- La paginazione a chiave non è toccata: parte solo in assenza di ordinamento
  personalizzato e lavora sulla chiave primaria, che non ammette nulli.

**Bloccato da:** 26 (la composizione dell'ordinamento deve prima passare dalla
strategia e vedere i metadati di colonna: senza, la griglia non riceverebbe la
correzione e l'omissione sulle colonne NOT NULL sarebbe impossibile).

**Status:** done

- [x] Lo stesso ordinamento richiesto dalla griglia produce lo stesso ordine di righe sui tre motori, valori nulli compresi
- [x] Un campo assente su MongoDB si colloca dove si colloca un campo nullo
- [x] Su colonne che non ammettono nulli, PostgreSQL continua a usare l'indice: verificato leggendo il piano di esecuzione, non dedotto
- [x] Che il comportamento predefinito di MySQL coincida con la regola è verificato contro un MySQL reale, non assunto
- [x] L'SQL di ordinamento scritto a mano dall'utente non viene riscritto in nessun caso
- [x] Esiste un test end-to-end che confronta l'ordine risultante fra i motori e fallirebbe se uno solo divergesse

## Che cosa è stato fatto

La regola — **il valore nullo è il più piccolo** — sta in `db/sqlTabellare.js`,
perché è una proprietà della griglia di CodeDB e non di un motore. Ciò che
cambia è solo come ciascun dialetto la **scrive**, e lo dichiara il dialetto:

* **PostgreSQL**: `nulliPrima = (discendente) => discendente ? ' NULLS LAST' : ' NULLS FIRST'`;
* **MySQL**: `nulliPrima = () => ''`, perché il suo predefinito già coincide — e
  non ha nemmeno la sintassi `NULLS FIRST/LAST`;
* **MongoDB** non passa da qui: ordina già i nulli come i più piccoli e colloca
  un campo assente accanto a uno nullo. È la sola cosa di questo ticket che
  **ho potuto verificare su un motore vero**, ed è verificata.

**L'omissione sulle colonne NOT NULL** (`serveSuffissoNulli`) è la mitigazione
che il ticket chiede, ed è dove si recupera quasi tutto il costo: si ordina
soprattutto per chiavi e identificatori. Quando la nullabilità **non si conosce**
il suffisso si mette: sbagliare l'ordine è un difetto visibile su tutte le righe
vuote, sbagliare il piano è lento — nel dubbio si sceglie il difetto che non c'è.

**L'SQL libero non viene mai riscritto**, suffisso compreso: se l'utente ordina a
mano, comanda lui. È il confine dichiarato dal ticket, ed è provato.

## Come è stato provato — e che cosa NON è provato

**Prove unitarie** (`test/unit-ordinamento-strategia.js`, 18 prove in tutto,
senza database): il suffisso nei due versi su PostgreSQL, la sua assenza su
MySQL, l'omissione su colonna NOT NULL, il suffisso quando la nullabilità è
sconosciuta, più colonne ciascuna secondo la propria nullabilità, l'SQL libero
mai riscritto (nemmeno quando porta un `NULLS LAST` opposto alla regola), la
regola che arriva fino alla query vera della griglia, e il fatto che sulla
chiave primaria la griglia non paghi niente.

**Prova end-to-end** (`test/e2e-nulli-ordinati.js`, **nuovo**): apre una
connessione vera per ciascuno dei tre motori, crea una tabella con un valore
nullo fra due pieni, legge la pagina con l'ordinamento strutturato nei due versi
e **confronta la forma dell'ordine fra i motori**. Su MongoDB inserisce anche una
riga con il campo del tutto **assente**. Include la lettura del **piano di
esecuzione** di PostgreSQL su una colonna NOT NULL indicizzata, con 5.000 righe e
`ANALYZE`: si legge `Index Scan`, non si deduce.

Il test **si rifiuta di dichiararsi superato** quando i motori disponibili sono
meno di due: esce con codice 1 e scrive «NESSUN CONFRONTO ESEGUITO:
l'allineamento fra i motori NON risulta verificato».

**Eseguito qui**: solo MongoDB — 5 asserzioni superate, compreso il campo assente
nei due versi.

**NON eseguito, ed è il limite serio di questo ticket.** MySQL rifiuta l'utente
`root` senza password che l'harness richiede, e PostgreSQL non è in ascolto su
5432 (le istanze Docker sulle stesse porte appartengono ad altri progetti e non
le ho toccate). Restano quindi non verificate proprio le due cose che il ticket
dice di non assumere:

* che il predefinito di MySQL **coincida** davvero con la regola — senza questa
  prova, su MySQL la regola si regge su una coincidenza che nessuno sorveglia;
* che su PostgreSQL l'omissione del suffisso lasci il piano su `Index Scan`.

Il test per entrambe è scritto e pronto: basta un MySQL con `root` senza
password su 3306 e un PostgreSQL su 5432, oppure le variabili d'ambiente
`MYSQL_PORT`/`MYSQL_PASSWORD`/`PG_PORT`/`PG_USER`/`PG_PASSWORD`.

`npm test` passa (esito 0).


---

## Le verifiche su motori veri — eseguite

Sono stati avviati due container **dedicati e usa-e-getta** (MySQL 8 su 3307,
PostgreSQL 16 su 5433), senza toccare le istanze di altri progetti sulle porte
consuete. `test/e2e-nulli-ordinati.js` ha girato sui **tre motori**:

```
MongoDB      ASC: ∅ ∅ aldo bruno   DESC: bruno aldo ∅ ∅
MySQL        ASC: ∅ aldo bruno     DESC: bruno aldo ∅
PostgreSQL   ASC: ∅ aldo bruno     DESC: bruno aldo ∅

  OK   MySQL ordina come MongoDB
  OK   PostgreSQL ordina come MongoDB
```

Le due cose che il ticket dice di **non assumere** sono ora verificate:

* **MySQL**: il comportamento predefinito coincide davvero con la regola, contro
  un MySQL 8 vero. Non è più una coincidenza che nessuno sorveglia — se una
  versione futura la cambiasse, questo test diventerebbe rosso.
* **PostgreSQL**: su una colonna NOT NULL indicizzata (5.000 righe, dopo
  `ANALYZE`) il piano **letto** riporta `Index Scan`, e la query spiegata non
  porta il suffisso. L'omissione fa il suo lavoro.

MongoDB colloca il campo **assente** esattamente dove colloca il campo nullo,
nei due versi.

**Sensibilità del confronto verificata**: togliendo il suffisso dal dialetto
PostgreSQL (`nulliPrima = () => ''`) il test diventa rosso su tre asserzioni,
fra cui «PostgreSQL ordina come MongoDB», mentre MySQL resta verde — cioè il
test fallisce se **un solo** motore diverge, che è precisamente ciò che il
ticket chiede. Ripristinato il dialetto, tutti superati.

Il test si rifiuta di dichiararsi superato quando i motori raggiungibili sono
meno di due: esce con codice 1 e lo scrive.

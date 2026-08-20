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

**Status:** ready-for-agent

- [ ] Lo stesso ordinamento richiesto dalla griglia produce lo stesso ordine di righe sui tre motori, valori nulli compresi
- [ ] Un campo assente su MongoDB si colloca dove si colloca un campo nullo
- [ ] Su colonne che non ammettono nulli, PostgreSQL continua a usare l'indice: verificato leggendo il piano di esecuzione, non dedotto
- [ ] Che il comportamento predefinito di MySQL coincida con la regola è verificato contro un MySQL reale, non assunto
- [ ] L'SQL di ordinamento scritto a mano dall'utente non viene riscritto in nessun caso
- [ ] Esiste un test end-to-end che confronta l'ordine risultante fra i motori e fallirebbe se uno solo divergesse

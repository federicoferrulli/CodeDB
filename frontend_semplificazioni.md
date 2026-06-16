# Issue: semplificazioni ed eliminazione di complicazioni nel frontend

Analisi di tutto il codice frontend (`public/`) con l'elenco delle semplificazioni
possibili, delle duplicazioni e delle complicazioni eliminabili. Le voci sono
ordinate per impatto: dalla più alta (codice morto, file interi) alla più bassa
(piccoli refactor locali). I testi UI e i commenti restano in italiano.

File analizzati: `public/index.html`, `public/css/style.css`,
`public/js/{main,app,utils,state,socket,uml}.js`.

---

## 🔴 Priorità ALTA — codice morto e duplicazioni intere

### 1. `public/js/app.js` è codice morto (1920 righe)

`index.html` carica **solo** `js/main.js` (come `type="module"`):

```html
<script type="module" src="js/main.js"></script>
```

`app.js` non è referenziato da nessuna parte (verificato su tutto `public/` e
`server.js`). È una **copia precedente e non modularizzata** dell'intero
frontend: contiene `displayValue`, `renderUml`, tutta la logica di connessione,
griglia, ecc. — tutto già presente in `main.js` + moduli.

Prove che è una versione *vecchia* (quindi non un'alternativa valida):
- non ha la funzionalità di **polling** (`togglePolling`, `state.pollingInterval`)
  presente in `main.js`;
- `displayValue` per `$binary` è la versione semplice `Binary(${subType})`,
  mentre `utils.js` ha la versione evoluta `[BLOB ...] hex`;
- `$numberDecimal` non usa `String(...)` come in `utils.js`.

**Azione:** eliminare `public/js/app.js`. Da solo dimezza la superficie del
frontend e rimuove ogni rischio di modifiche fatte sul file sbagliato.

> ⚠️ Aggiornare anche `CLAUDE.md`, che descrive `public/js/app.js` come «intero
> frontend»: dopo la modularizzazione la descrizione è obsoleta e va riscritta
> elencando `main.js` + `utils.js` + `state.js` + `socket.js` + `uml.js`.

### 2. `main.js` è ancora un monolite da ~1630 righe

La modularizzazione è iniziata (estratti `utils`, `state`, `socket`, `uml`) ma
`main.js` contiene ancora blocchi tematici nettamente separati e indipendenti.
Sono già delimitati da banner di commento, quindi lo split è quasi meccanico:

- `connection.js` — form di connessione, tab URI/parametri, SSH, connessioni
  salvate, import/export (righe ~11–345).
- `dbtree.js` — albero database/collection + menu contestuale (righe ~347–472).
- `schema-ops.js` — crea/rinomina/elimina database, collection, colonne, indici
  (righe ~474–718, 1452–1587).
- `grid.js` — query, paginazione, rendering griglia, editing inline (righe
  ~738–1038).
- `insert.js` — modulo di inserimento guidato dallo schema (righe ~1083–1385).
- `details.js` — vista dettagli/statistiche (righe ~1387–1450).
- `live.js` — watch + polling (righe ~1591–1633).

**Azione:** spostare ogni blocco nel proprio modulo ES, esponendo solo le
funzioni richiamate da altri (`runQuery`, `setView`, `refreshDbTree`,
`startWatch`, ecc.). Riduce drasticamente il carico cognitivo per ogni modifica.

---

## 🟠 Priorità MEDIA — pattern ripetuti da estrarre in helper

### 3. Apertura/chiusura modali ripetuta ovunque

Il pattern `$('#x-overlay').classList.add('hidden')` /
`.remove('hidden')` compare per **8 modali diverse** (connect, dbcreate,
collcreate, editdoc, insert, idxcreate, coledit, context-menu), spesso seguito
da `value=''`, `focus()` e reset dell'errore.

**Azione:** introdurre in `utils.js` due helper:

```js
export const openModal  = (id) => $(id).classList.remove('hidden');
export const closeModal = (id) => $(id).classList.add('hidden');
```

e, dove serve, un `resetError(id)`. Elimina decine di righe ripetitive e rende
uniforme il comportamento.

### 4. Visualizzazione errore nelle modali ripetuta ~6 volte

Questo blocco identico appare in `doConnect`, `conn-save-btn`, `dbcreate-save`,
`collcreate-save`, `editdoc-save`, `insert-save`, `idxcreate-save`,
`coledit-save`:

```js
const err = $('#xxx-error');
err.textContent = res.error;
err.classList.remove('hidden');
return;
```

**Azione:** helper unico:

```js
export function showError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}
```

### 5. Wrapper per `socket.emit` con gestione errori standard

Quasi ogni chiamata ripete:

```js
socket.emit('evento', payload, (res) => {
  if (!res.ok) { toast(res.error, true); return; }
  /* ... */
});
```

**Azione:** un piccolo helper basato su Promise:

```js
export function emit(event, payload) {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (res) =>
      res.ok ? resolve(res) : reject(new Error(res.error)));
  });
}
```

Permette `try { await emit(...) } catch (e) { toast(e.message, true) }` e
rimuove il branch `if (!res.ok)` da ~20 callback.

### 6. `state.dbSchema = null` sparso dopo le mutazioni

L'invalidazione della cache dello schema è ripetuta a mano in `renameDb`,
`renameColl`, `dropColl`, `collcreate-save`, `column:drop`, `coledit-save`.
È facile dimenticarla in una nuova operazione → UML stantio.

**Azione:** centralizzare in una funzione `invalidateSchema()` (o farla chiamare
da `refreshDbTree`/`loadDetails`), così il punto di invalidazione è uno solo.

### 7. Logica EJSON di rilevamento tipo duplicata

In `utils.js`, `displayValue`, `simplify` e `valueType` ripetono ciascuna la
sequenza di controlli `'$oid' in v`, `'$date' in v`, `'$numberInt' in v`, ecc.
Lo stesso schema riappare in `buildEditor` (`main.js`) e in `insertKindOf`.

**Azione:** una sola funzione `ejsonKind(v)` che ritorna il «tipo logico»
(`'oid' | 'date' | 'number' | 'decimal' | 'binary' | 'plain'`); le altre funzioni
la usano per smistare. Riduce la possibilità che le liste divergano nel tempo
(come è già successo per `$binary` tra `app.js` e `utils.js`).

---

## 🟡 Priorità BASSA — complicazioni locali e pulizia

### 8. Stili inline da spostare in CSS

- `main.js:824` → `actionsTh.style.width = '56px'` (colonna azioni della griglia).
- `main.js:401` → `'<li ... style="color:var(--fg-dim)">caricamento…</li>'`.

**Azione:** usare classi CSS (`.grid-actions-col`, `.loading`) già che esiste
`public/css/style.css`.

### 9. Indice "magico" nel menu modalità

`main.js:130` → `$('#query-mode').options[1].textContent = ...` dipende
dall'ordine fisso delle `<option>`. Fragile se si riordina l'HTML.

**Azione:** dare un `id`/`data-attr` all'opzione e selezionarla esplicitamente.

### 10. Calcolo statusbar contorto

`main.js:887-890`:

```js
const to = Math.min(state.skip + state.docs.length, state.skip + state.limit);
$('#page-info').textContent = `${from}–${Math.min(to, state.total) || state.docs.length}`;
```

Il doppio `Math.min` + `|| state.docs.length` è di difficile lettura. Il valore
«ultimo elemento mostrato» è semplicemente `state.skip + state.docs.length`.

**Azione:** semplificare in `const to = state.skip + state.docs.length;`.

### 11. Etichetta "documenti" anche per MySQL

`main.js:889` → `` `${state.total} documenti — ${state.docs.length} mostrati` ``
viene mostrato anche con MySQL connesso, dove esiste già `collWord()`
(«tabella») e altrove si usa «righe». Incoerenza UI.

**Azione:** usare un termine adattato al `dbType` (es. «righe» per MySQL).

### 12. Suffissi di genere ripetuti (`${isMysql ? 'a' : 'o'}`)

`eliminat${...}`, `modificat${...}`, `aggiunt${...}` compaiono più volte nei
toast di gestione colonne.

**Azione:** una funzione `colWord` già esiste; aggiungere `colDone(verb)` che
restituisce la frase completa concordata, oppure restituire participi pronti.

### 13. Flag `finished` + `cancel`/`save` in `startEdit`

La macchina a stati dell'editing inline (`finished`, doppio path
`blur`/`Enter`/`Escape`/`change`) è corretta ma densa. Documentata bene, ma
candidata a estrazione in un piccolo modulo `inlineEdit.js` insieme a
`buildEditor` (che è già autosufficiente).

### 14. `main.js:1589` commento residuo

`/* UML delegate to module */` è un commento orfano dopo l'estrazione di
`uml.js`: rimuoverlo.

### 15. Doppio `applyDbTypeToForm()` in catena

`applySshToForm()` termina chiamando `applyDbTypeToForm()`, che a sua volta
rilegge `ssh.checked`. La dipendenza incrociata tra i due `apply*` è un po'
intricata: verificare che non ci siano doppi reflow/aggiornamenti e, se
possibile, unificare in un solo `syncConnForm()` che applica tutto lo stato del
form in un passaggio.

---

## Riepilogo impatto

| # | Intervento | Beneficio |
|---|------------|-----------|
| 1 | Eliminare `app.js` | −1920 righe, zero rischio di edit sul file sbagliato |
| 2 | Split di `main.js` in moduli | leggibilità, modifiche isolate |
| 3–6 | Helper modali/errori/emit/cache | −centinaia di righe ripetute |
| 7 | Centralizzare rilevamento EJSON | una sola fonte di verità per i tipi |
| 8–15 | Pulizia locale | leggibilità e coerenza UI |

**Quick win consigliato per primo:** punto **1** (eliminare `app.js`) e punto
**14**, immediati e a rischio nullo; poi i punti **3–6** che ripagano subito in
tutto il resto del refactor.

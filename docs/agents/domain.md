# Documenti di dominio

Come le skill di ingegneria devono consumare la documentazione di dominio di questo repo
mentre esplorano il codice.

Layout: **contesto singolo**.

## Prima di esplorare, leggi questi

- **`CONTEXT.md`** alla radice del repo, oppure
- **`CONTEXT-MAP.md`** alla radice, se esiste: punta a un `CONTEXT.md` per contesto. Leggi
  quelli pertinenti all'argomento.
- **`docs/adr/`**: leggi gli ADR che toccano l'area su cui stai per lavorare. Nei repo
  multi-contesto controlla anche `src/<contesto>/docs/adr/` per le decisioni locali al
  contesto.

Se uno di questi file non esiste, **prosegui in silenzio**. Non segnalarne l'assenza e non
proporre di crearli in anticipo. La skill `/domain-modeling` (raggiunta da
`/grill-with-docs` e `/improve-codebase-architecture`) li crea quando serve davvero, cioè
quando un termine o una decisione vengono effettivamente risolti.

## Struttura dei file

Repo a contesto singolo (è il caso di questo repo):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-strategia-per-dbms.md
│   └── 0002-ejson-fra-client-e-server.md
└── db/ …
```

Repo multi-contesto (riconoscibile da `CONTEXT-MAP.md` alla radice):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← decisioni valide per tutto il sistema
└── src/
    ├── ordini/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← decisioni specifiche del contesto
    └── fatturazione/
        ├── CONTEXT.md
        └── docs/adr/
```

## Usa il vocabolario del glossario

Quando il tuo risultato nomina un concetto di dominio (nel titolo di una issue, in una
proposta di refactoring, in un'ipotesi, nel nome di un test), usa il termine **come è
definito** in `CONTEXT.md`. Non scivolare verso sinonimi che il glossario evita
esplicitamente.

Se il concetto che ti serve non è ancora nel glossario, è un segnale: o stai inventando un
linguaggio che il progetto non usa (ripensaci), oppure c'è un vuoto reale (annotalo per
`/domain-modeling`).

## Segnala i conflitti con gli ADR

Se il tuo risultato contraddice un ADR esistente, dichiaralo apertamente invece di
scavalcarlo in silenzio:

> _Contraddice l'ADR-0007 (strategia per DBMS), ma vale la pena riaprirlo perché…_

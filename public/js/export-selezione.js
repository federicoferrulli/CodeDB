/**
 * Lo stato dell'albero di selezione dell'export: logica pura, senza DOM.
 *
 * Il wizard (§3 del piano) mostra un albero ricercabile con checkbox a tre
 * stati e due colonne indipendenti — Struttura e Dati. La regola che conta è
 * che la RICERCA non è una selezione: filtrare per nome non deve deselezionare
 * nulla, altrimenti restringere l'albero per trovare una tabella ne cancella
 * silenziosamente altre cento dall'export. Qui dentro la ricerca restituisce
 * visibilità, mai appartenenza.
 *
 * La propagazione è l'altro punto delicato: spuntare un gruppo spunta i figli,
 * cambiare un figlio ricalcola il genitore come tutto/niente/misto. Senza, un
 * genitore spuntato a metà dichiara una selezione che non esegue.
 *
 * Niente rete, niente DOM, niente piano: entra una lista di oggetti, esce la
 * mappa che `creaPianoExport` accetta come selezione. Il wizard la importa
 * così com'è — una sola definizione di «selezionato».
 */

const STATI = Object.freeze({ TUTTO: 'tutto', NIENTE: 'niente', MISTO: 'misto' });
export { STATI };

/** Gli unici tipi su cui «dati» ha un significato (stessa regola del piano). */
function portaDatiDefault(tipo) {
  return tipo === 'tabella' || tipo === 'collection';
}

/**
 * @param {Array<{id:string, tipo:string, nome:string, gruppo?:string|null}>} oggetti
 * @param {object} [opts]
 * @param {(tipo:string) => boolean} [opts.portaDati]
 */
export function creaStatoSelezione(oggetti, { portaDati = portaDatiDefault } = {}) {
  const nodi = new Map();
  for (const raw of oggetti || []) {
    const id = String(raw && raw.id || '');
    if (!id || nodi.has(id)) throw new Error(`Oggetto di selezione duplicato o senza id: "${id}".`);
    nodi.set(id, {
      id,
      tipo: String(raw.tipo || ''),
      nome: String(raw.nome || ''),
      gruppo: raw.gruppo != null ? String(raw.gruppo) : null,
      struttura: true,
      dati: portaDati(String(raw.tipo || '')),
    });
  }

  function nodo(id) {
    const n = nodi.get(String(id));
    if (!n) throw new Error(`Selezione di un oggetto assente: "${id}".`);
    return n;
  }

  function figliDi(gruppo) {
    return [...nodi.values()].filter((n) => n.gruppo === gruppo);
  }

  return {
    STATI,

    /** Imposta una colonna su un nodo; su un gruppo si propaga ai figli. */
    imposta(id, colonna, valore) {
      if (colonna !== 'struttura' && colonna !== 'dati') throw new Error(`Colonna sconosciuta: "${colonna}".`);
      const v = !!valore;
      let bersagli = bersagliDi(String(id), nodi);
      const suGruppo = bersagli.length > 1 || (bersagli.length === 1 && bersagli[0].gruppo === String(id));
      if (colonna === 'dati' && v) {
        // Sul singolo nodo è un errore (stessa regola del piano); sul gruppo si
        // applica dove ha senso e si saltano gli altri — altrimenti nessun
        // gruppo con una vista dentro si potrebbe mai accendere, cioè tutti.
        const rilevanti = bersagli.filter((x) => portaDati(x.tipo));
        if (!suGruppo && rilevanti.length !== bersagli.length) {
          const primo = bersagli.find((x) => !portaDati(x.tipo));
          throw new Error(`"${primo.id}": un oggetto di tipo "${primo.tipo}" non porta righe.`);
        }
        bersagli = rilevanti;
      }
      for (const n of bersagli) n[colonna] = v;
      return this;
    },

    /** Stato triplo di un nodo o di un gruppo su una colonna. */
    stato(id, colonna) {
      let bersagli = bersagliDi(String(id), nodi);
      // I «dati» di una vista non esistono: non votano, altrimenti nessun
      // gruppo con una vista sarebbe mai «tutto».
      if (colonna === 'dati') bersagli = bersagli.filter((x) => portaDati(x.tipo));
      const accesi = bersagli.filter((x) => x[colonna]).length;
      if (!accesi) return STATI.NIENTE;
      if (accesi === bersagli.length) return STATI.TUTTO;
      return STATI.MISTO;
    },

    /** Visibilità per la ricerca: non tocca la selezione, mai. */
    cerca(testo) {
      const q = String(testo || '').trim().toLowerCase();
      if (!q) return [...nodi.keys()];
      return [...nodi.values()].filter((x) => x.nome.toLowerCase().includes(q)).map((x) => x.id);
    },

    selezionaTutto() {
      for (const x of nodi.values()) { x.struttura = true; if (portaDati(x.tipo)) x.dati = true; }
      return this;
    },

    deselezionaTutto() {
      for (const x of nodi.values()) { x.struttura = false; x.dati = false; }
      return this;
    },

    soloStruttura() {
      for (const x of nodi.values()) { x.struttura = true; x.dati = false; }
      return this;
    },

    soloDati() {
      for (const x of nodi.values()) { x.struttura = false; x.dati = portaDati(x.tipo); }
      return this;
    },

    /** Riepilogo per il passo di conferma del wizard. */
    riepilogo() {
      const tutti = [...nodi.values()];
      return {
        oggetti: tutti.length,
        conStruttura: tutti.filter((x) => x.struttura).length,
        conDati: tutti.filter((x) => x.dati).length,
        esclusi: tutti.filter((x) => !x.struttura && !x.dati).map((x) => x.id),
      };
    },

    /** La mappa per `creaPianoExport` in modalità personalizzata. */
    perPiano() {
      return Object.fromEntries([...nodi.values()].map((x) => [x.id, { struttura: x.struttura, dati: x.dati }]));
    },

    conteggio() { return nodi.size; },
  };
}

// I bersagli di un'impostazione: un nome di gruppo colpisce tutti i figli
// (anche quelli nascosti dalla ricerca: un'impostazione di massa non deve
// lasciare stati nascosti), un id colpisce il nodo. Se un id collide col nome
// di un gruppo vince il gruppo — nel wizard i gruppi sono schemi e gli id sono
// `tipo:nome`, quindi non collide mai davvero. Il resto è un errore, perché
// quasi sempre è un nome scritto male.
function bersagliDi(chiave, nodi) {
  const figli = [...nodi.values()].filter((x) => x.gruppo === chiave);
  if (figli.length) return figli;
  const singolo = nodi.get(chiave);
  if (singolo) return [singolo];
  throw new Error(`Selezione di un oggetto assente: "${chiave}".`);
}

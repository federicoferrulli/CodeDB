/**
 * Contesti immutabili e generazioni monotone per le richieste del browser.
 *
 * Una risposta asincrona puo' produrre effetti soltanto se e' ancora l'ultima
 * richiesta per la propria chiave. Il contesto viene copiato in profondita'
 * perche' filtro, ordinamento e metadata non cambino mentre la richiesta e' in
 * volo.
 */

function copia(valore) {
  if (Array.isArray(valore)) return valore.map(copia);
  if (valore && typeof valore === 'object') {
    const out = {};
    for (const [chiave, contenuto] of Object.entries(valore)) out[chiave] = copia(contenuto);
    return out;
  }
  return valore;
}

function congela(valore) {
  if (!valore || typeof valore !== 'object' || Object.isFrozen(valore)) return valore;
  for (const contenuto of Object.values(valore)) congela(contenuto);
  return Object.freeze(valore);
}

export function congelaContesto(contesto) {
  return congela(copia(contesto || {}));
}

/** Tutti i campi dichiarati dall'atteso appartengono ancora allo stesso bersaglio. */
export function contestoCorrente(stato, atteso) {
  return !!stato && !!atteso
    && Object.entries(atteso).every(([chiave, valore]) => stato[chiave] === valore);
}

/** Chiude un indicatore di caricamento solo se appartiene proprio a quel run. */
export function chiudiCaricamento(stato, token) {
  if (!stato || stato.gridLoadingRunId !== token) return false;
  stato.loading = false;
  stato.gridLoadingRunId = null;
  return true;
}

export class RegistroGenerazioni {
  constructor() {
    this.generazioni = new Map();
  }

  nuova(chiave, contesto = {}) {
    const generazione = (this.generazioni.get(chiave) || 0) + 1;
    this.generazioni.set(chiave, generazione);
    return Object.freeze({ chiave, generazione, contesto: congelaContesto(contesto) });
  }

  corrente(richiesta) {
    return !!richiesta && this.generazioni.get(richiesta.chiave) === richiesta.generazione;
  }

  invalida(chiave) {
    this.generazioni.set(chiave, (this.generazioni.get(chiave) || 0) + 1);
  }

  invalidaSe(predicato) {
    for (const chiave of this.generazioni.keys()) {
      if (predicato(chiave)) this.invalida(chiave);
    }
  }
}

/** Cache asincrona single-flight che non accetta risultati di generazioni obsolete. */
export class CacheGenerazionale {
  constructor(carica) {
    if (typeof carica !== 'function') throw new TypeError('Il caricatore della cache deve essere una funzione.');
    this.carica = carica;
    this.generazioni = new Map();
    this.valori = new Map();
    this.inCorso = new Map();
  }

  leggi(chiave) {
    return this.valori.get(chiave);
  }

  ha(chiave) {
    return this.valori.has(chiave);
  }

  ottieni(chiave) {
    if (this.valori.has(chiave)) return Promise.resolve(this.valori.get(chiave));
    const esistente = this.inCorso.get(chiave);
    if (esistente) return esistente.promessa;

    const generazione = this.generazioni.get(chiave) || 0;
    const promessa = Promise.resolve()
      .then(() => this.carica(chiave))
      .then((valore) => {
        if ((this.generazioni.get(chiave) || 0) === generazione) this.valori.set(chiave, valore);
        return valore;
      })
      .finally(() => {
        const corrente = this.inCorso.get(chiave);
        if (corrente && corrente.generazione === generazione) this.inCorso.delete(chiave);
      });
    this.inCorso.set(chiave, { generazione, promessa });
    return promessa;
  }

  invalida(chiave) {
    this.generazioni.set(chiave, (this.generazioni.get(chiave) || 0) + 1);
    this.valori.delete(chiave);
    this.inCorso.delete(chiave);
  }

  invalidaSe(predicato) {
    const chiavi = new Set([
      ...this.generazioni.keys(), ...this.valori.keys(), ...this.inCorso.keys(),
    ]);
    for (const chiave of chiavi) if (predicato(chiave)) this.invalida(chiave);
  }

  invalidaTutto() {
    const chiavi = new Set([...this.valori.keys(), ...this.inCorso.keys()]);
    for (const chiave of chiavi) this.invalida(chiave);
  }
}

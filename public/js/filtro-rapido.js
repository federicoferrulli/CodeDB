/**
 * CodeDB — Il filtro rapido: una parola, tutte le colonne.
 *
 * La casella del filtro della griglia chiedeva all'utente di sapere quale
 * motore aveva davanti: su MongoDB si scrive un documento MQL
 * (`{"age":{"$gt":30}}`), sui due motori SQL un frammento di clausola `WHERE`.
 * Sono due linguaggi diversi nella stessa casella, e nessuno dei due è ciò che
 * si vuole nel caso più frequente — che è cercare una parola e vedere dove
 * compare.
 *
 * Da qui le due modalità:
 *
 *  - **rapida**: si scrive del testo e il browser invia la sola intenzione
 *    `contieneOvunque`. Campi, tipi e percorsi JSON vengono decisi dal server:
 *    non dipendono dalla pagina caricata e non espongono al client i dialetti;
 *  - **condizione**: resta la casella di prima, per chi vuole scrivere una
 *    `WHERE` arbitraria o un documento MQL. Toglierla avrebbe tolto una
 *    capacità vera a uno strumento da database.
 *
 * Modulo puro: nessun DOM, nessuna rete. Si prova senza browser.
 */

import { analizzaJsonBson, tokenizzaJsonBson } from './json-bson.js';

/** Le due modalità della casella del filtro. */
export const MODI = {
  rapido: {
    icona: 'search',
    etichetta: 'Cerca',
    titolo: 'Cerca nei valori di tutti i campi rilevati',
    segnaposto: 'Cerca in tutti i campi…',
  },
  condizione: {
    icona: 'filter',
    etichetta: 'Condizione',
    titolo: 'Scrivi una condizione: WHERE su SQL, documento MQL su MongoDB',
    segnaposto: 'Condizione, es. { "age": { "$gt": 30 } }',
  },
};

/** Il modo successivo, per il pulsante che li alterna. */
export function modoSuccessivo(modo) {
  return modo === 'rapido' ? 'condizione' : 'rapido';
}

/**
 * Compone l'intenzione strutturata della ricerca globale. Il browser non
 * enumera colonne: su MongoDB quella lista dipenderebbe dai documenti della
 * pagina e una ricerca senza risultati la azzererebbe.
 */
export function filtroRapido(testo) {
  const cercato = String(testo == null ? '' : testo).trim();
  if (!cercato) return null;
  return { operatore: 'contieneOvunque', valore: cercato };
}

/**
 * Che cosa mandare al server per una certa modalità.
 *
 * Le due chiavi sono diverse e non intercambiabili: `filter` è il testo grezzo
 * storico, `cercaOvunque` è l'intenzione strutturata. Mandarle entrambe le fa valere
 * entrambe (unite da AND), ed è esattamente ciò che NON si vuole qui — la
 * casella è una sola, e il suo contenuto significa una cosa alla volta.
 */
export function payloadFiltro(modo, testo) {
  if (modo === 'rapido') {
    const cercaOvunque = filtroRapido(testo);
    return cercaOvunque ? { cercaOvunque } : {};
  }
  const t = String(testo == null ? '' : testo).trim();
  return t ? { filter: t } : {};
}

/**
 * Controllo sintattico leggero di una condizione SQL (WHERE): verifica
 * stringhe/identificatori non chiusi, commenti /* non chiusi, parentesi
 * sbilanciate e la parola WHERE lasciata senza predicato. Nessun falso
 * positivo su clausole SQL valide di MySQL o PostgreSQL.
 */
function validaCondizioneSql(testo, dbType) {
  const s = String(testo);
  const n = s.length;
  if (/^\s*WHERE\s*$/i.test(s)) {
    return { ok: false, messaggio: 'Scrivi una condizione dopo WHERE (es. stato = \'attivo\').', riga: 1, colonna: 1, indice: 0 };
  }
  const parentesi = [];
  let i = 0;
  while (i < n) {
    const c = s[i];
    // Commenti di riga: -- oppure # (MySQL)
    if (c === '-' && s[i + 1] === '-') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (c === '#' && dbType === 'mysql') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    // Commento di blocco /* ... */
    if (c === '/' && s[i + 1] === '*') {
      const fine = s.indexOf('*/', i + 2);
      if (fine < 0) {
        return { ok: false, messaggio: 'Commento /* … */ aperto e mai chiuso.', riga: 1, colonna: i + 1, indice: i };
      }
      i = fine + 2;
      continue;
    }
    // Stringhe e identificatori quotati
    if (c === "'" || c === '"' || c === '`') {
      const inizio = i;
      const q = c;
      i++;
      let chiusa = false;
      while (i < n) {
        if (q === "'" && dbType === 'mysql' && s[i] === '\\') { i += 2; continue; }
        if (s[i] === q) {
          if (s[i + 1] === q) { i += 2; continue; } // escape SQL '' / "" / ``
          i++;
          chiusa = true;
          break;
        }
        i++;
      }
      if (!chiusa) {
        return {
          ok: false,
          messaggio: q === "'" ? 'Stringa aperta e mai chiusa: manca l’apice finale.' : `Identificatore aperto con ${q} e mai chiuso.`,
          riga: 1, colonna: inizio + 1, indice: inizio,
        };
      }
      continue;
    }
    if (c === '(') parentesi.push(i);
    else if (c === ')') {
      if (!parentesi.length) {
        return { ok: false, messaggio: 'Parentesi chiusa ")" senza una "(" corrispondente.', riga: 1, colonna: i + 1, indice: i };
      }
      parentesi.pop();
    }
    i++;
  }
  if (parentesi.length) {
    const aperta = parentesi[parentesi.length - 1];
    return { ok: false, messaggio: 'Parentesi tonda "(" aperta e mai chiusa.', riga: 1, colonna: aperta + 1, indice: aperta };
  }
  return { ok: true };
}

/**
 * Valida la sintassi della casella in modalità Condizione, prima dell'invio al
 * server. Restituisce `null` se la casella è vuota, `{ ok: true }` se valida,
 * oppure `{ ok: false, messaggio, riga, colonna, indice }` per indicare il
 * punto esatto dell'errore.
 */
export function validaCondizione(testo, dbType) {
  const s = String(testo == null ? '' : testo);
  if (!s.trim()) return null;
  const isSql = dbType === 'mysql' || dbType === 'postgresql' || dbType === 'postgres';
  if (isSql) return validaCondizioneSql(s, dbType);

  const esito = analizzaJsonBson(s);
  if (!esito.ok) return esito;

  // Un filtro MongoDB deve essere un documento oggetto `{ ... }`, non uno
  // scalare ("mario", 123, true, null) né un array: prima gli scalari JSON
  // venivano scartati silenziosamente e restituivano tutta la collection.
  const toks = tokenizzaJsonBson(s);
  const primo = toks.find((t) => t.t !== 'commento');
  if (!primo || primo.t !== 'punt' || primo.v !== '{') {
    const indice = primo ? primo.i : 0;
    return {
      ok: false,
      messaggio: 'Il filtro MongoDB deve essere un documento tra graffe (es. { age: { $gt: 30 } }).',
      riga: 1,
      colonna: indice + 1,
      indice,
    };
  }
  return { ok: true };
}

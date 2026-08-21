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

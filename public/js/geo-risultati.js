'use strict';

/* ---------------------------------------------------------------------------
 * Dalle RIGHE di un risultato di query alle celle geometriche da mappare.
 *
 * È il pezzo che manca fra la tab ⚡ Query & Aggregate (che produce righe) e
 * `geo-vista.js` (che disegna un elenco di celle `{valore, colonna, riga}`).
 * Sta a parte dall'interfaccia per la solita ragione di questa base di codice —
 * `chart-option.js`, `cell-stats.js`, `geo-stats.js`: è la parte che, sbagliata,
 * NON si vede. Una mappa disegnata storta salta all'occhio; una mappa che mostra
 * 40 punti su 60 perché la scansione ha saltato un campo annidato sembra invece
 * una mappa giusta, e nessuno ha modo di accorgersene.
 *
 * Tre scelte che non sono ovvie:
 *
 * 1. IL RILEVAMENTO SCORRE TUTTE LE RIGHE, CON UN BUDGET DI NODI. Una geometria
 *    dopo la cinquantesima riga non deve rendere invisibile la vista mappa; il
 *    tetto esplicito impedisce però a documenti patologici di bloccare la UI.
 *
 * 2. SI SCENDE NEI SOTTODOCUMENTI, MA POCO. Su MongoDB la geometria sta spesso
 *    in `spedizione.destinazione`, non in cima; su SQL è sempre una colonna di
 *    primo livello. Due livelli coprono il caso reale senza trasformare la
 *    scansione in una visita completa di documenti che possono essere enormi.
 *    Dentro un ARRAY invece si entra: `percorso[2]` è una geometria a tutti gli
 *    effetti e va mappata, con il suo indice nell'etichetta.
 *
 * 3. IL TETTO È SULLE CELLE RACCOLTE, non sulle righe lette. Una query con
 *    200.000 punti va troncata prima di arrivare a `geo-stats.js`, e il numero
 *    di righe da cui vengono non dice nulla su quanto lavoro sia: una riga può
 *    contenere un array di mille geometrie. Il troncamento viene DICHIARATO al
 *    chiamante, che lo mostra: una mappa parziale silenziosa è una bugia.
 * ------------------------------------------------------------------------- */

// `normalizzaGeometria` è la domanda larga "questo valore è disegnabile?" e
// tratta le tre forme in cui una geometria arriva dai vari database (oggetto
// GeoJSON, testo GeoJSON, coppia {x,y}). Sta in `geojson.js` perché serve anche
// alla mappa della SELEZIONE di celle: le due viste devono riconoscere le stesse
// cose, altrimenti la stessa colonna è mappabile da una e non dall'altra.
import { normalizzaGeometria } from './geojson.js';

/** Massimo di valori visitati per decidere se la vista mappa ha senso. */
export const MAX_NODI_RILEVAMENTO = 250000;

/** Massimo di celle geometriche portate alla mappa. */
export const MAX_CELLE = 20000;

/** Profondità massima di discesa nei sottodocumenti (0 = solo primo livello). */
const MAX_PROFONDITA = 2;

/** Evita stack smisurati su array artificialmente annidati. */
const MAX_PROFONDITA_ARRAY = 8;

/**
 * Visita una riga e passa a `cb(percorso, valore)` ogni valore geometrico.
 * Gli array si attraversano senza consumare profondità: un elenco di geometrie
 * resta un elenco di geometrie, non un sottodocumento in più.
 */
function visita(valore, percorso, profondita, cb, controllo = null, profonditaArray = 0) {
  if (controllo) {
    if (controllo.ferma || controllo.visitati >= controllo.maxNodi) {
      controllo.esaurito = controllo.visitati >= controllo.maxNodi;
      controllo.ferma = true;
      return;
    }
    controllo.visitati++;
  }
  if (valore === null || valore === undefined) return;
  // Prima la domanda "è disegnabile?": copre l'oggetto GeoJSON, il testo
  // GeoJSON dei database SQL e la coppia {x,y} del tipo `point` nativo.
  const geo = normalizzaGeometria(valore);
  if (geo) {
    if (cb(percorso, geo) === false && controllo) controllo.ferma = true;
    return;
  }
  if (typeof valore !== 'object') return;
  if (Array.isArray(valore)) {
    if (profonditaArray >= MAX_PROFONDITA_ARRAY) return;
    for (let i = 0; i < valore.length; i++) {
      visita(valore[i], `${percorso}[${i}]`, profondita, cb, controllo, profonditaArray + 1);
      if (controllo && controllo.ferma) break;
    }
    return;
  }
  // Un oggetto EJSON ($oid, $date, $numberLong…) è un VALORE, non un
  // sottodocumento: scenderci dentro non troverebbe mai una geometria e
  // produrrebbe percorsi fantasma tipo `creato.$date`.
  if (profondita >= MAX_PROFONDITA || Object.keys(valore).some((k) => k.startsWith('$'))) return;
  for (const [k, v] of Object.entries(valore)) {
    if (v === null || v === undefined) continue;
    visita(v, percorso ? `${percorso}.${k}` : k, profondita + 1, cb, controllo, profonditaArray);
    if (controllo && controllo.ferma) break;
  }
}

/**
 * C'è almeno una geometria nei risultati?
 *
 * Domanda a cui si risponde a ogni query per decidere se mostrare il pulsante
 * della vista mappa: si scorrono tutte le righe finché si trova una geometria
 * o si esaurisce il budget di nodi (vedi nota 1).
 *
 * @param {object[]} righe
 * @param {number} [maxNodi]
 * @returns {boolean}
 */
export function haGeometrie(righe, maxNodi = MAX_NODI_RILEVAMENTO) {
  if (!Array.isArray(righe)) return false;
  const controllo = {
    maxNodi: Math.max(Number(maxNodi) || 0, 1),
    visitati: 0,
    ferma: false,
    esaurito: false,
  };
  for (let i = 0; i < righe.length && !controllo.ferma; i++) {
    let trovata = false;
    visita(righe[i], '', 0, () => {
      trovata = true;
      return false;
    }, controllo);
    if (trovata) return true;
  }
  return false;
}

/**
 * Raccoglie tutte le celle geometriche dei risultati, nella forma attesa da
 * `geo-vista.js` / `geo-stats.js`.
 *
 * @param {object[]} righe
 * @param {{max?:number}} [opts]
 * @returns {{voci:{valore:any,colonna:string,riga:number}[], colonne:string[], tagliate:number, righeConGeometrie:number}}
 */
export function vociGeometriche(righe, { max = MAX_CELLE } = {}) {
  const voci = [];
  const colonne = [];
  const viste = new Set();
  let tagliate = 0;
  let righeConGeometrie = 0;

  const lista = Array.isArray(righe) ? righe : [];
  for (let i = 0; i < lista.length; i++) {
    let nella = false;
    visita(lista[i], '', 0, (percorso, geo) => {
      nella = true;
      if (voci.length >= max) { tagliate++; return; }
      // Il nome della colonna è il percorso SENZA gli indici di array: dieci
      // geometrie di `tappe[0..9]` sono la stessa colonna, e nell'elenco della
      // mappa serve sapere da quale campo vengono, non da quale posizione.
      const colonna = percorso || '(valore)';
      const base = colonna.replace(/\[\d+\]/g, '[]');
      if (!viste.has(base)) { viste.add(base); colonne.push(base); }
      voci.push({ valore: geo, colonna, riga: i });
    });
    if (nella) righeConGeometrie++;
  }
  return { voci, colonne, tagliate, righeConGeometrie };
}

/**
 * Nota da mostrare quando la mappa non rappresenta tutto il result set.
 * Torna stringa vuota se non c'è nulla da dichiarare.
 */
export function notaTroncamento(tagliate, max = MAX_CELLE) {
  if (!tagliate) return '';
  return `Mappate le prime ${max.toLocaleString('it-IT')} geometrie dei risultati `
    + `(${tagliate.toLocaleString('it-IT')} escluse): restringi la query per vederle tutte.`;
}

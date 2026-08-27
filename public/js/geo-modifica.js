'use strict';

/* ---------------------------------------------------------------------------
 * Le modifiche di una geometria, come DATI.
 *
 * Aggiungere un vertice, eliminarlo, infilarne uno in mezzo a un lato,
 * aggiungere o togliere una parte di una geometria multipart: sono decisioni
 * che dipendono solo dal GeoJSON, non dalla mappa. Vivevano dentro `geomap.js`
 * mescolate a Leaflet, ai canvas e alla modale, quindi l'unico modo di provarle
 * era aprire un browser — e l'unico modo di sbagliarle era non provarle.
 *
 * Regole comuni a tutte le funzioni di questo modulo:
 *   · non mutano l'argomento (lavorano su una copia e restituiscono la copia),
 *     così chi chiama può tenere lo stato precedente per l'annullamento;
 *   · restituiscono `{ geo, selezione, parteAttiva, errore }` — un `errore` è
 *     un rifiuto DICHIARATO, con la ragione già scritta in italiano per l'utente,
 *     mai un'eccezione da indovinare;
 *   · un anello di poligono resta CHIUSO (prima posizione ripetuta in fondo)
 *     dopo ogni operazione: è un requisito del formato, e riaprirlo produce un
 *     rifiuto del database molto lontano dal gesto che l'ha causato.
 *
 * Il `percorso` di un vertice è quello prodotto da `posizioni()` in geojson.js:
 * `[]` per un Point, `[i]` per MultiPoint/LineString, `[anello, i]` per un
 * Polygon, `[linea, i]` per un MultiLineString, `[poligono, anello, i]` per un
 * MultiPolygon.
 * ------------------------------------------------------------------------- */

import { isGeometry, chiuso } from './geojson.js';

// Tipi che si disegnano e si modificano con le maniglie. `GeometryCollection`
// resta fuori: mescola forme eterogenee e richiederebbe un secondo editor
// gerarchico, quindi si guarda sulla mappa e si modifica dal JSON.
export const MODIFICABILI = new Set([
  'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon',
]);

const copia = (geo) => JSON.parse(JSON.stringify(geo));

/** Il tipo è fatto di anelli chiusi (poligoni)? */
export const aAnelli = (tipo) => tipo === 'Polygon' || tipo === 'MultiPolygon';

/** Il tipo è multipart, cioè ha parti che si aggiungono e si tolgono? */
export const multipart = (tipo) => tipo === 'MultiLineString' || tipo === 'MultiPolygon';

/**
 * Posizioni minime perché una parte di questo tipo abbia senso. Per un anello
 * sono 4 e non 3 perché la quarta è la ripetizione di chiusura.
 */
export function minimiPer(tipo) {
  if (aAnelli(tipo)) return 4;
  if (/LineString$/.test(tipo)) return 2;
  return 1;
}

/** La sequenza di posizioni (anello o linea) che contiene il vertice indicato. */
export function sequenzaDi(geo, percorso) {
  if (!isGeometry(geo) || !Array.isArray(percorso)) return null;
  switch (geo.type) {
    case 'MultiPoint':
    case 'LineString': return geo.coordinates;
    case 'MultiLineString':
    case 'Polygon': return geo.coordinates[percorso[0]] || null;
    case 'MultiPolygon': return (geo.coordinates[percorso[0]] || [])[percorso[1]] || null;
    default: return null;
  }
}

/** Quante parti ha la geometria (1 per i tipi non multipart). */
export function numeroParti(geo) {
  if (!isGeometry(geo)) return 0;
  return multipart(geo.type) ? geo.coordinates.length : 1;
}

/** Indice della parte a cui appartiene un vertice (0 se il tipo non è multipart). */
export function parteDiPercorso(geo, percorso) {
  if (!isGeometry(geo) || !Array.isArray(percorso) || !percorso.length) return 0;
  return multipart(geo.type) ? percorso[0] : 0;
}

// Un anello deve avere la prima posizione ripetuta in fondo: toccando il primo
// vertice va riallineato l'ultimo, e viceversa.
function chiudiAnello(anello, primoModificato) {
  if (!Array.isArray(anello) || anello.length < 2) return;
  if (primoModificato) anello[anello.length - 1] = [...anello[0]];
  else anello[0] = [...anello[anello.length - 1]];
}

// Il nuovo vertice entra PRIMA della ripetizione di chiusura, e la chiusura si
// aggiunge appena l'anello ha abbastanza vertici per essere una superficie.
function aggiungiAdAnello(anello, nuova) {
  if (anello.length >= 2 && chiuso(anello)) anello.splice(anello.length - 1, 0, nuova);
  else anello.push(nuova);
  if (anello.length >= 3 && !chiuso(anello)) anello.push([...anello[0]]);
}

const esito = (geo, extra = {}) => ({ geo, selezione: null, parteAttiva: null, errore: '', ...extra });
const rifiuto = (geo, errore) => esito(geo, { errore });

/**
 * La forma VUOTA di un tipo: la nidificazione giusta senza nessuna posizione.
 * Serve a «Ridisegna», che deve conservare il tipo (quasi sempre imposto dalla
 * colonna) e buttare via solo il disegno.
 */
export function geometriaVuota(tipo) {
  switch (tipo) {
    case 'Point':
    case 'MultiPoint':
    case 'LineString': return { type: tipo, coordinates: [] };
    case 'MultiLineString':
    case 'Polygon': return { type: tipo, coordinates: [[]] };
    case 'MultiPolygon': return { type: tipo, coordinates: [[[]]] };
    default: return null;
  }
}

/**
 * Aggiunge una posizione alla parte attiva. È il gesto del clic sulla mappa,
 * ma la decisione di DOVE finisca il vertice è qui: su un Point si sposta
 * l'unica posizione, su un poligono si entra nell'anello esterno della parte
 * attiva, su un MultiLineString in coda alla linea attiva.
 */
export function aggiungiVertice(geo, pos, parteAttiva = 0) {
  if (!isGeometry(geo) || !MODIFICABILI.has(geo.type)) return rifiuto(geo, 'Questa geometria non si modifica sulla mappa.');
  const g = copia(geo);
  const parte = Math.min(Math.max(0, Number(parteAttiva) || 0), Math.max(0, numeroParti(g) - 1));
  switch (g.type) {
    case 'Point':
      g.coordinates = pos; // un Point si sposta, non si moltiplica
      return esito(g, { selezione: [] });
    case 'MultiPoint':
    case 'LineString':
      g.coordinates.push(pos);
      return esito(g, { selezione: [g.coordinates.length - 1] });
    case 'Polygon': {
      const anello = g.coordinates[0] || (g.coordinates[0] = []);
      aggiungiAdAnello(anello, pos);
      return esito(g, { selezione: [0, anello.indexOf(pos)] });
    }
    case 'MultiLineString': {
      const linea = g.coordinates[parte] || (g.coordinates[parte] = []);
      linea.push(pos);
      return esito(g, { selezione: [parte, linea.length - 1], parteAttiva: parte });
    }
    case 'MultiPolygon': {
      const poligono = g.coordinates[parte] || (g.coordinates[parte] = [[]]);
      const anello = poligono[0] || (poligono[0] = []);
      aggiungiAdAnello(anello, pos);
      return esito(g, { selezione: [parte, 0, anello.indexOf(pos)], parteAttiva: parte });
    }
    default:
      return rifiuto(geo, 'Questa geometria non si modifica sulla mappa.');
  }
}

/**
 * Elimina il vertice indicato.
 *
 * Il rifiuto è dichiarato in due casi diversi, e dirlo cambia cosa fare: un
 * Point ha una sola posizione (si cambia tipo), una parte al minimo dei vertici
 * si elimina intera invece di svuotarla un vertice alla volta.
 */
export function eliminaVertice(geo, percorso) {
  if (!isGeometry(geo) || !MODIFICABILI.has(geo.type)) return rifiuto(geo, 'Questa geometria non si modifica sulla mappa.');
  if (geo.type === 'Point') return rifiuto(geo, 'Un Point ha una sola posizione: cambia il tipo per eliminarla.');
  if (!Array.isArray(percorso) || !percorso.length) return rifiuto(geo, 'Seleziona prima un vertice sulla mappa.');

  const g = copia(geo);
  const sequenza = sequenzaDi(g, percorso);
  const minimi = minimiPer(g.type);
  if (!sequenza) return rifiuto(geo, 'Il vertice selezionato non esiste più.');
  if (sequenza.length <= minimi) {
    return rifiuto(geo, multipart(g.type)
      ? `Servono almeno ${minimi} posizioni: elimina la parte intera, non i suoi vertici.`
      : `Servono almeno ${minimi} posizioni per un ${g.type}.`);
  }
  const idx = percorso[percorso.length - 1];
  sequenza.splice(idx, 1);
  if (aAnelli(g.type)) chiudiAnello(sequenza, idx === 0);
  // Selezione al vertice precedente: dopo un'eliminazione il gesto naturale è
  // continuare a ripulire lo stesso tratto, e senza selezione ogni bottone
  // tornerebbe disattivato.
  const dopo = Math.max(0, Math.min(idx - 1, sequenza.length - 1));
  return esito(g, { selezione: [...percorso.slice(0, -1), dopo] });
}

// Punto di mezzo fra due posizioni, quota compresa quando ce l'hanno entrambe.
function mezzo(a, b) {
  const pos = [
    Number(((Number(a[0]) + Number(b[0])) / 2).toFixed(7)),
    Number(((Number(a[1]) + Number(b[1])) / 2).toFixed(7)),
  ];
  if (a.length > 2 && b.length > 2) pos.push(Number(((Number(a[2]) + Number(b[2])) / 2).toFixed(7)));
  return pos;
}

// Prolungamento oltre l'ultimo vertice, lungo la direzione dell'ultimo tratto.
function prolunga(prev, ultimo) {
  return [
    Number((Number(ultimo[0]) + (Number(ultimo[0]) - Number(prev[0])) / 2).toFixed(7)),
    Number((Number(ultimo[1]) + (Number(ultimo[1]) - Number(prev[1])) / 2).toFixed(7)),
  ];
}

/**
 * Infila un vertice DOPO quello selezionato, a metà del lato.
 *
 * È l'operazione che sulla mappa non esisteva: il clic accoda sempre in fondo,
 * quindi correggere il lato fra il terzo e il quarto vertice di un poligono
 * significava rifare la forma o riscrivere il JSON. Su una linea aperta, se il
 * vertice selezionato è l'ultimo, non c'è un lato da dividere e si PROLUNGA il
 * tratto — che è ciò che si sta chiedendo.
 */
export function inserisciVerticeDopo(geo, percorso) {
  if (!isGeometry(geo) || !MODIFICABILI.has(geo.type)) return rifiuto(geo, 'Questa geometria non si modifica sulla mappa.');
  if (geo.type === 'Point') return rifiuto(geo, 'Un Point ha una sola posizione.');
  if (geo.type === 'MultiPoint') return rifiuto(geo, 'I punti di un MultiPoint non hanno lati: aggiungili con un clic sulla mappa.');
  if (!Array.isArray(percorso) || !percorso.length) return rifiuto(geo, 'Seleziona prima il vertice dopo il quale inserire.');

  const g = copia(geo);
  const sequenza = sequenzaDi(g, percorso);
  if (!sequenza || sequenza.length < 2) return rifiuto(geo, 'Servono almeno due vertici per dividere un lato.');
  let idx = percorso[percorso.length - 1];
  // In un anello chiuso l'ultima posizione È la prima: «dopo l'ultima» vuol
  // dire dopo la prima, altrimenti il vertice nuovo finirebbe fuori
  // dall'anello e lo aprirebbe.
  if (aAnelli(g.type) && idx === sequenza.length - 1) idx = 0;
  const successivo = sequenza[idx + 1];
  const nuova = successivo
    ? mezzo(sequenza[idx], successivo)
    : prolunga(sequenza[idx - 1], sequenza[idx]);
  sequenza.splice(idx + 1, 0, nuova);
  return esito(g, { selezione: [...percorso.slice(0, -1), idx + 1] });
}

/** Apre una nuova parte vuota (l'ultima diventa quella attiva). */
export function nuovaParte(geo) {
  if (!isGeometry(geo) || !multipart(geo.type)) {
    return rifiuto(geo, 'Solo un MultiLineString o un MultiPolygon hanno più parti.');
  }
  const g = copia(geo);
  g.coordinates.push(g.type === 'MultiPolygon' ? [[]] : []);
  return esito(g, { parteAttiva: g.coordinates.length - 1 });
}

/**
 * Elimina una parte intera. L'ultima parte non si elimina: una geometria senza
 * parti non è una geometria, e chi vuole ricominciare ha «Ridisegna», che lo
 * dichiara.
 */
export function eliminaParte(geo, indice) {
  if (!isGeometry(geo) || !multipart(geo.type)) {
    return rifiuto(geo, 'Solo un MultiLineString o un MultiPolygon hanno parti da eliminare.');
  }
  const g = copia(geo);
  const i = Number(indice);
  if (!Number.isInteger(i) || i < 0 || i >= g.coordinates.length) return rifiuto(geo, 'La parte selezionata non esiste più.');
  if (g.coordinates.length <= 1) return rifiuto(geo, 'È l’ultima parte: usa «Ridisegna» per ricominciare da capo.');
  g.coordinates.splice(i, 1);
  return esito(g, { parteAttiva: Math.max(0, i - 1) });
}

/**
 * Che cosa manca perché la geometria sia salvabile — stringa vuota se non manca
 * nulla. Il salvataggio è fail-closed su questo: una parte incompleta viene
 * fermata qui con il motivo, invece di essere rifiutata dal database dopo che
 * l'utente ha finito di disegnare.
 */
export function problemaGeometria(geo) {
  const posizione = (p) => Array.isArray(p) && p.length >= 2
    && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));
  const linea = (l) => Array.isArray(l) && l.length >= 2 && l.every(posizione);
  const anello = (a) => Array.isArray(a) && a.length >= 4 && a.every(posizione) && chiuso(a);
  const poligono = (p) => Array.isArray(p) && p.length >= 1 && p.every(anello);
  if (!isGeometry(geo)) return 'Geometria non valida.';
  switch (geo.type) {
    case 'Point': return posizione(geo.coordinates) ? '' : 'Posiziona il punto sulla mappa prima di applicare la geometria.';
    case 'MultiPoint': return geo.coordinates.length && geo.coordinates.every(posizione) ? '' : 'Aggiungi almeno un punto valido.';
    case 'LineString': return linea(geo.coordinates) ? '' : 'Una linea richiede almeno 2 vertici validi.';
    case 'MultiLineString': return geo.coordinates.length && geo.coordinates.every(linea) ? '' : 'Ogni linea richiede almeno 2 vertici validi.';
    case 'Polygon': return poligono(geo.coordinates) ? '' : 'Ogni anello del poligono richiede almeno 3 vertici ed essere chiuso.';
    case 'MultiPolygon': return geo.coordinates.length && geo.coordinates.every(poligono) ? '' : 'Ogni poligono richiede almeno un anello chiuso con 3 vertici.';
    default: return '';
  }
}

/**
 * Annulla/ripeti.
 *
 * Ogni gesto sulla mappa è distruttivo — un clic di troppo aggiunge un vertice
 * che poi va cercato e cancellato — e finché non c'è un annullamento l'unico
 * modo di tornare indietro è rifare il disegno. La storia tiene ISTANTANEE del
 * GeoJSON (una geometria da migliaia di vertici pesa poco più del testo che si
 * vede accanto alla mappa, e il tetto la limita comunque).
 */
export function creaStoria(limite = 60) {
  let passato = [];
  let futuro = [];
  const testo = (geo) => JSON.stringify(geo);
  return {
    /** Registra lo stato PRECEDENTE a una modifica. Un nuovo ramo cancella il futuro. */
    registra(geo) {
      passato.push(testo(geo));
      if (passato.length > limite) passato.shift();
      futuro = [];
    },
    annulla(corrente) {
      if (!passato.length) return null;
      futuro.push(testo(corrente));
      return JSON.parse(passato.pop());
    },
    ripeti(corrente) {
      if (!futuro.length) return null;
      passato.push(testo(corrente));
      return JSON.parse(futuro.pop());
    },
    puoAnnullare: () => passato.length > 0,
    puoRipetere: () => futuro.length > 0,
    azzera() { passato = []; futuro = []; },
  };
}

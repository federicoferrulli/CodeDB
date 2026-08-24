'use strict';

/* ---------------------------------------------------------------------------
 * Tipi geometrici NATIVI di PostgreSQL <-> GeoJSON.
 *
 * PostgreSQL ha tipi geometrici propri fin da prima di PostGIS: `point`,
 * `lseg`, `box`, `path`, `polygon`, `line`, `circle`. Non sono geometrie
 * PostGIS — non li si può passare a `ST_AsGeoJSON` (CDB-A88) — e il driver `pg`
 * li consegna come oggetti JavaScript (`{x, y}`) che non si possono reinserire.
 *
 * L'interfaccia però parla una lingua sola, GeoJSON (vedi geometry.js): la
 * mappa, l'editor e la griglia sanno disegnare quello. Questo modulo fa da
 * traduttore nei due sensi, così una colonna `point` o `polygon` nativa si
 * legge e si MODIFICA con lo stesso editor delle geometrie PostGIS.
 *
 * Cosa è traducibile e cosa no, dichiarato invece che indovinato:
 *
 *   point    <-> Point            esatto
 *   lseg     <-> LineString(2)    esatto
 *   path     <-> LineString       (aperto) o Polygon (chiuso)
 *   polygon  <-> Polygon          un solo anello: PostgreSQL non ha i buchi
 *   box      -->  Polygon         il rettangolo; in scrittura si accetta un
 *                                 Polygon rettangolare e si riduce a due angoli
 *   line     ---                  è una retta infinita {A,B,C}: nessun
 *                                 equivalente GeoJSON, resta testo
 *   circle   ---                  centro e raggio: nessun equivalente GeoJSON,
 *                                 resta testo
 *
 * Per gli ultimi due il valore passa invariato: meglio mostrare `<(0,0),5>` e
 * lasciarlo modificare come testo che fingere una conversione che perderebbe
 * il significato del dato.
 * ------------------------------------------------------------------------- */

// Numeri di un letterale PostgreSQL, nell'ordine in cui compaiono. La sintassi
// dei tipi nativi è tutta parentesi e virgole, quindi estrarre i numeri e
// raggrupparli a coppie è più robusto di una grammatica per ciascun tipo.
function numeri(testo) {
  const trovati = String(testo).match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g);
  return trovati ? trovati.map(Number) : [];
}

function coppie(valori) {
  const out = [];
  for (let i = 0; i + 1 < valori.length; i += 2) out.push([valori[i], valori[i + 1]]);
  return out;
}

const num = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error('Coordinate non valide: attesi numeri finiti.');
  }
  // Evita la notazione esponenziale, che PostgreSQL accetta ma rende il
  // letterale illeggibile a chi lo rilegge nella griglia.
  return Number.isInteger(n) ? String(n) : String(n);
};

const punto = (p) => `(${num(p[0])},${num(p[1])})`;

/** Un anello di poligono è chiuso? (primo punto uguale all'ultimo) */
function chiuso(punti) {
  if (punti.length < 2) return false;
  const a = punti[0];
  const b = punti[punti.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Testo di un valore geometrico nativo -> GeoJSON.
 *
 * @param {string} tipo  nome del tipo PostgreSQL (point, polygon, ...)
 * @param {any} valore   testo del valore (`col::text`)
 * @returns oggetto GeoJSON, oppure il valore invariato se non traducibile
 */
function pgNativoAGeoJson(tipo, valore) {
  if (valore === null || valore === undefined) return valore;
  const testo = String(valore).trim();
  if (!testo) return valore;
  const t = String(tipo || '').trim().toLowerCase();
  const pts = coppie(numeri(testo));

  switch (t) {
    case 'point':
      return pts.length === 1 ? { type: 'Point', coordinates: pts[0] } : valore;
    case 'lseg':
      return pts.length === 2 ? { type: 'LineString', coordinates: pts } : valore;
    case 'path': {
      if (pts.length < 2) return valore;
      // `((...))` = percorso CHIUSO, `[(...)]` = aperto: la distinzione sta
      // nella parentesi iniziale ed è l'unica differenza fra i due.
      if (testo.startsWith('(')) {
        const anello = chiuso(pts) ? pts : [...pts, pts[0]];
        return { type: 'Polygon', coordinates: [anello] };
      }
      return { type: 'LineString', coordinates: pts };
    }
    case 'polygon': {
      if (pts.length < 3) return valore;
      // PostgreSQL non memorizza il punto di chiusura, GeoJSON lo pretende.
      const anello = chiuso(pts) ? pts : [...pts, pts[0]];
      return { type: 'Polygon', coordinates: [anello] };
    }
    case 'box': {
      if (pts.length !== 2) return valore;
      const [[x1, y1], [x2, y2]] = pts;
      return {
        type: 'Polygon',
        coordinates: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]],
      };
    }
    default:
      // line e circle: nessun equivalente GeoJSON, si mostra il testo.
      return valore;
  }
}

/**
 * GeoJSON -> letterale PostgreSQL nativo.
 *
 * @returns {string} il letterale da passare come parametro
 * @throws se la geometria non è rappresentabile in quel tipo — meglio un
 *   errore chiaro che una scrittura che perde silenziosamente una parte del
 *   disegno (i buchi di un poligono, per esempio).
 */
function geoJsonAPgNativo(tipo, geo) {
  const t = String(tipo || '').trim().toLowerCase();
  // Chi scrive già il letterale nativo (o modifica una cella come testo) deve
  // continuare a poterlo fare: non tutto passa dall'editor su mappa.
  if (typeof geo === 'string') return geo;
  // Gli export PostgreSQL precedenti alla normalizzazione leggevano `point`
  // con `SELECT *`: il driver `pg` lo serializza come `{ x, y }`. Accettare
  // quella forma mantiene reimportabili gli artefatti gia' creati, senza
  // estendere l'eccezione agli altri tipi o agli oggetti generici.
  if (t === 'point' && geo && typeof geo === 'object'
      && Object.prototype.hasOwnProperty.call(geo, 'x')
      && Object.prototype.hasOwnProperty.call(geo, 'y')) {
    return punto([geo.x, geo.y]);
  }
  if (!geo || typeof geo !== 'object' || !geo.type) {
    throw new Error(`Valore non valido per una colonna ${t}: attesa una geometria GeoJSON o il letterale PostgreSQL.`);
  }

  const coords = geo.coordinates;
  const errore = (atteso) => new Error(
    `Una colonna PostgreSQL "${t}" non può contenere una geometria ${geo.type}: ${atteso}.`
  );

  switch (t) {
    case 'point':
      if (geo.type !== 'Point') throw errore('serve un Point');
      return punto(coords);

    case 'lseg':
      if (geo.type !== 'LineString' || coords.length !== 2) {
        throw errore('serve una LineString di esattamente 2 punti');
      }
      return `[${punto(coords[0])},${punto(coords[1])}]`;

    case 'path':
      if (geo.type === 'LineString') {
        if (coords.length < 2) throw errore('una LineString deve avere almeno 2 punti');
        return `[${coords.map(punto).join(',')}]`;
      }
      if (geo.type === 'Polygon') {
        if (coords.length > 1) throw errore('PostgreSQL non rappresenta i buchi di un poligono');
        const anello = coords[0];
        // PostgreSQL non vuole il punto di chiusura ripetuto.
        const punti = chiuso(anello) ? anello.slice(0, -1) : anello;
        return `(${punti.map(punto).join(',')})`;
      }
      throw errore('servono una LineString o un Polygon');

    case 'polygon': {
      if (geo.type !== 'Polygon') throw errore('serve un Polygon');
      if (coords.length > 1) throw errore('PostgreSQL non rappresenta i buchi di un poligono');
      const anello = coords[0];
      if (!Array.isArray(anello) || anello.length < 3) throw errore('servono almeno 3 punti');
      const punti = chiuso(anello) ? anello.slice(0, -1) : anello;
      return `(${punti.map(punto).join(',')})`;
    }

    case 'box': {
      if (geo.type !== 'Polygon') throw errore('serve un Polygon rettangolare');
      const anello = coords[0] || [];
      if (anello.length < 4) throw errore('servono almeno 4 punti');
      // Un box è definito da due angoli opposti: si prendono gli estremi, così
      // un rettangolo disegnato in qualunque verso produce lo stesso box.
      const xs = anello.map((p) => p[0]);
      const ys = anello.map((p) => p[1]);
      return `(${num(Math.max(...xs))},${num(Math.max(...ys))}),(${num(Math.min(...xs))},${num(Math.min(...ys))})`;
    }

    default:
      // line e circle: non si costruiscono da GeoJSON. Se arriva del testo lo
      // si è già restituito sopra; qui vuol dire che è arrivata una geometria.
      throw new Error(
        `Le colonne PostgreSQL "${t}" non si scrivono dall'editor su mappa: `
        + 'inserisci il letterale PostgreSQL (per esempio "<(0,0),5>" per un circle).'
      );
  }
}

module.exports = { pgNativoAGeoJson, geoJsonAPgNativo, numeri, coppie };

'use strict';

/* ---------------------------------------------------------------------------
 * Il filtro come DATO, non come testo.
 *
 * Oggi lo stesso parametro `filter` significa tre cose diverse a seconda del
 * motore che lo riceve: un frammento di clausola SQL **grezzo** sui due motori
 * SQL, un documento MQL sul motore documentale. La firma è piccola —
 * `collectionFind(db, coll, { filter })` — ma l'invariante è enorme, e ogni
 * chiamante deve sapere in anticipo quale motore risponderà. È il contrario
 * della profondità: l'interfaccia sembra una, e sono tre.
 *
 * Le conseguenze non sono teoriche. Il frammento grezzo è la ragione per cui
 * esistono `auth/sqlClause.js` (analisi sintattica difensiva) e il metodo
 * separato `relatedRows` — il pannello delle chiavi esterne deve
 * parametrizzare dentro ciascuna strategia proprio perché il `filter` di
 * `collectionFind` non è parametrizzabile.
 *
 * Qui il filtro diventa un elenco di condizioni:
 *
 *   { condizioni: [{ campo, operatore, valore }], unione: 'e' | 'o' }
 *
 * e ogni motore lo rende nel proprio dialetto **parametrizzando**. Il valore
 * non attraversa mai il testo della query: è questa, e non un elenco di
 * caratteri vietati, la ragione per cui un valore ostile non può cambiare la
 * struttura di ciò che viene eseguito.
 *
 * Modulo puro: nessun driver, nessun DOM, nessuna dipendenza. Si prova senza
 * database.
 * ------------------------------------------------------------------------- */

/**
 * Gli operatori riconosciuti.
 *
 * `aritmetico` dice se l'operatore ha una traduzione diretta in entrambe le
 * famiglie di dialetto; gli altri hanno una resa propria per motore.
 * `vuole` dice quanti valori si aspetta: nessuno (`vuoto`), uno, o una lista.
 */
const OPERATORI = {
  uguale: { sql: '=', mongo: '$eq', vuole: 'uno' },
  diverso: { sql: '<>', mongo: '$ne', vuole: 'uno' },
  maggiore: { sql: '>', mongo: '$gt', vuole: 'uno' },
  maggioreUguale: { sql: '>=', mongo: '$gte', vuole: 'uno' },
  minore: { sql: '<', mongo: '$lt', vuole: 'uno' },
  minoreUguale: { sql: '<=', mongo: '$lte', vuole: 'uno' },
  contiene: { vuole: 'uno', testuale: true },
  iniziaCon: { vuole: 'uno', testuale: true },
  finisceCon: { vuole: 'uno', testuale: true },
  dentro: { vuole: 'lista' },
  vuoto: { vuole: 'nessuno' },
  nonVuoto: { vuole: 'nessuno' },
};

const UNIONI = { e: 'AND', o: 'OR' };

/** I nomi degli operatori, per i messaggi d'errore e per il frontend. */
const NOMI_OPERATORI = Object.keys(OPERATORI);

/**
 * Normalizza e VALIDA un filtro strutturato.
 *
 * Restituisce `null` quando non c'è filtro — che non è la stessa cosa di un
 * filtro vuoto: `null` significa «nessuna condizione», e chi lo riceve non
 * deve scrivere alcun WHERE.
 *
 * Rifiuta invece di correggere: un operatore sconosciuto, un campo assente o un
 * numero di valori sbagliato sono errori del chiamante, e indovinare cosa
 * intendesse produrrebbe una query che filtra per qualcos'altro senza dirlo.
 */
function normalizzaFiltro(input) {
  if (input == null || input === '') return null;
  const grezzo = typeof input === 'string' ? leggiJson(input) : input;
  if (!grezzo || typeof grezzo !== 'object') {
    throw new Error('Filtro non valido: atteso un oggetto { condizioni: [...] }.');
  }
  const condizioni = Array.isArray(grezzo.condizioni) ? grezzo.condizioni : null;
  if (!condizioni) {
    throw new Error('Filtro non valido: manca l\'elenco "condizioni".');
  }
  if (!condizioni.length) return null;

  const unione = String(grezzo.unione || 'e').toLowerCase();
  if (!UNIONI[unione]) {
    throw new Error(`Unione del filtro non valida: "${grezzo.unione}". Valori ammessi: e, o.`);
  }

  return {
    unione,
    condizioni: condizioni.map((c, i) => normalizzaCondizione(c, i)),
  };
}

function leggiJson(testo) {
  try {
    return JSON.parse(testo);
  } catch (err) {
    throw new Error(`Filtro non valido: ${err.message}`);
  }
}

function normalizzaCondizione(c, i) {
  const dove = `condizione ${i + 1}`;
  if (!c || typeof c !== 'object') throw new Error(`Filtro non valido: ${dove} non è un oggetto.`);

  const campo = String(c.campo == null ? '' : c.campo).trim();
  if (!campo) throw new Error(`Filtro non valido: ${dove} non indica il campo.`);
  // Il campo diventa un identificatore quotato, non un frammento: un nome che
  // contenga un NUL o un a capo non è un nome, e lasciarlo passare
  // significherebbe rimettere in circolo il testo grezzo dalla porta di
  // servizio.
  if (/[\0\r\n]/.test(campo)) {
    throw new Error(`Filtro non valido: ${dove} ha un nome di campo con caratteri di controllo.`);
  }
  // Un segmento che comincia per `$` NON è un nome di campo: su MongoDB
  // diventerebbe un OPERATORE. `{ campo: '$where', operatore: 'uguale' }`
  // renderebbe `{ $where: { $eq: 'return true' } }`, cioè esecuzione di
  // JavaScript sul server travestita da filtro — e lo stesso vale per un
  // percorso annidato come `profilo.$expr`. È la difesa che il metodo separato
  // delle righe riferite applicava sul suo `colonna`: tolto quello, deve vivere
  // qui, perché la causa è la stessa.
  if (campo.split('.').some((segmento) => !segmento || segmento.startsWith('$'))) {
    throw new Error(
      `Filtro non valido: ${dove} ha un nome di campo non valido ("${campo}"). `
      + 'Non usare segmenti vuoti né il prefisso $: su MongoDB sarebbe un operatore, non un campo.'
    );
  }

  const operatore = String(c.operatore == null ? '' : c.operatore).trim();
  const spec = OPERATORI[operatore];
  if (!spec) {
    throw new Error(
      `Filtro non valido: ${dove} usa l'operatore sconosciuto "${operatore}". `
      + `Quelli previsti sono: ${NOMI_OPERATORI.join(', ')}.`
    );
  }

  if (spec.vuole === 'nessuno') return { campo, operatore, valore: undefined };
  if (spec.vuole === 'lista') {
    const lista = Array.isArray(c.valore) ? c.valore : null;
    if (!lista || !lista.length) {
      throw new Error(`Filtro non valido: ${dove} ("${operatore}") vuole un elenco di valori non vuoto.`);
    }
    return { campo, operatore, valore: lista };
  }
  if (c.valore === undefined) {
    throw new Error(`Filtro non valido: ${dove} ("${operatore}") vuole un valore.`);
  }
  return { campo, operatore, valore: c.valore };
}

/* ==========================================================================
 * La resa SQL
 * ========================================================================== */

/**
 * Rende il filtro come clausola SQL PARAMETRIZZATA.
 *
 * `dialetto` porta le due sole cose che cambiano fra MySQL e PostgreSQL:
 * `qid(nome)` per quotare l'identificatore e `segnaposto(n)` per il segnaposto
 * del parametro (`?` contro `$n` numerato).
 *
 * `da` è il numero del primo parametro: serve quando la clausola non è la prima
 * cosa parametrizzata della query. Su MySQL è indifferente, su PostgreSQL no —
 * ed è il genere di dettaglio che, lasciato al chiamante, produce una query che
 * legge il limite al posto del filtro.
 *
 * @returns {{ sql: string, params: any[] }} `sql` è vuoto se il filtro è nullo.
 */
function rendiSql(filtro, dialetto, da = 1) {
  if (!filtro) return { sql: '', params: [] };
  const { qid, segnaposto, testoDi } = dialetto || {};
  if (typeof qid !== 'function' || typeof segnaposto !== 'function') {
    throw new Error('Dialetto del filtro incompleto: servono qid e segnaposto.');
  }

  const params = [];
  const prossimo = () => segnaposto(da + params.length);
  const pezzi = filtro.condizioni.map((c) => {
    const col = qid(c.campo);
    const spec = OPERATORI[c.operatore];

    if (c.operatore === 'vuoto') return `${col} IS NULL`;
    if (c.operatore === 'nonVuoto') return `${col} IS NOT NULL`;

    if (c.operatore === 'dentro') {
      const segni = c.valore.map((v) => { const s = prossimo(); params.push(v); return s; });
      return `${col} IN (${segni.join(', ')})`;
    }

    if (spec.testuale) {
      // Il LIKE si compone dal VALORE, non dal testo: i metacaratteri `%` e `_`
      // vengono neutralizzati, così chi cerca "50%" cerca la stringa "50%" e
      // non "tutto ciò che inizia per 50".
      const modello = modelloLike(c.operatore, c.valore);
      const s = prossimo();
      params.push(modello);
      // Nessuna clausola ESCAPE: la barra rovesciata è già il carattere di
      // escape predefinito del LIKE su ENTRAMBI i motori, e scriverla non
      // sarebbe innocuo — su MySQL `ESCAPE '\'` è una stringa non terminata,
      // perché lì la barra rovesciata vale anche dentro i letterali.
      // La colonna si confronta COME TESTO: su PostgreSQL `intero LIKE testo`
      // non esiste come operatore e la query fallisce, mentre su MySQL la
      // conversione e' implicita. La differenza la dichiara il dialetto.
      const espressione = typeof testoDi === 'function' ? testoDi(col) : col;
      return `${espressione} LIKE ${s}`;
    }

    const s = prossimo();
    params.push(c.valore);
    return `${col} ${spec.sql} ${s}`;
  });

  return { sql: pezzi.join(` ${UNIONI[filtro.unione]} `), params };
}

/** Neutralizza i metacaratteri di LIKE e compone il modello. */
function modelloLike(operatore, valore) {
  const testo = String(valore == null ? '' : valore).replace(/[\\%_]/g, (ch) => `\\${ch}`);
  if (operatore === 'iniziaCon') return `${testo}%`;
  if (operatore === 'finisceCon') return `%${testo}`;
  return `%${testo}%`;
}

/* ==========================================================================
 * La resa MongoDB
 * ========================================================================== */

/**
 * Rende il filtro come documento MQL.
 *
 * Il valore finisce sempre in posizione di VALORE, mai di operatore: un valore
 * che somigli a `{ $ne: null }` resta un oggetto confrontato per uguaglianza,
 * non diventa un operatore. È l'equivalente documentale del parametro.
 */
function rendiMongo(filtro) {
  if (!filtro) return {};
  const pezzi = filtro.condizioni.map((c) => {
    const spec = OPERATORI[c.operatore];

    if (c.operatore === 'vuoto') return { [c.campo]: null };
    if (c.operatore === 'nonVuoto') return { [c.campo]: { $ne: null } };
    if (c.operatore === 'dentro') return { [c.campo]: { $in: c.valore } };

    if (spec.testuale) {
      return { [c.campo]: { $regex: modelloRegex(c.operatore, c.valore), $options: 'i' } };
    }
    return { [c.campo]: { [spec.mongo]: c.valore } };
  });

  if (pezzi.length === 1 && filtro.unione === 'e') return pezzi[0];
  return { [filtro.unione === 'o' ? '$or' : '$and']: pezzi };
}

/** Il modello per la ricerca testuale, con i metacaratteri di regex neutralizzati. */
function modelloRegex(operatore, valore) {
  // Senza questo, chi cerca "S.p.A." otterrebbe un'espressione in cui il punto
  // vale "qualsiasi carattere", e una parentesi aperta farebbe fallire la query
  // invece di cercare una parentesi.
  const testo = String(valore == null ? '' : valore).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (operatore === 'iniziaCon') return `^${testo}`;
  if (operatore === 'finisceCon') return `${testo}$`;
  return testo;
}

module.exports = {
  normalizzaFiltro,
  rendiSql,
  rendiMongo,
  OPERATORI,
  NOMI_OPERATORI,
  UNIONI,
};

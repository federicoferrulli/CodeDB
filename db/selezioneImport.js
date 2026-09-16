'use strict';

/**
 * La selezione per l'import: quali oggetti dell'archivio entrano, con che
 * politica, e tutto ciò che resta fuori — deciso PRIMA di ogni scrittura.
 *
 * §3 del piano, passi 2 e 4: dall'archivio si può chiedere solo ciò che
 * contiene (mai dati assenti), e ogni oggetto ha la sua politica — crea se
 * assente, accoda, fondi via identità stabile, sostituisci l'oggetto. Nessun
 * `REPLACE` generico come sinonimo di merge: cancella e reinserisce, con tutti
 * gli effetti collaterali che ne seguono.
 *
 * Qui non si apre nessuna connessione e non si scrive nulla: entra
 * l'inventario dell'artefatto (manifest), esce un piano immutabile e firmato
 * come quelli della Fase 1 — stessa `sigilla`, stessa impronta, stessa regola:
 * anteprima ed esecuzione guardano lo stesso oggetto o l'esecuzione rifiuta.
 * L'esecuzione (adapter) resta lavoro futuro e dichiarato.
 */

const { sigilla, verificaImpronta } = require('./pianoComune');
const { tipoDb } = require('./artefatti');

const POLITICHE = Object.freeze(['crea-se-assente', 'accoda', 'fondi', 'sostituisci']);
const POLITICHE_VALIDE = new Set(POLITICHE);

function creaSelezioneImport({
  inventario,
  selezione = null,
  connection,
  targetDb,
  politicaDefault = 'crea-se-assente',
} = {}) {
  if (!POLITICHE_VALIDE.has(politicaDefault)) {
    throw new Error(`Politica di default sconosciuta: "${politicaDefault}". Ammesse: ${POLITICHE.join(', ')}.`);
  }
  const conn = String(connection || '').trim();
  if (!conn) throw new Error('Connessione di destinazione mancante.');
  const target = String(targetDb || '').trim();
  if (!target) throw new Error('Database/schema di destinazione mancante.');
  const dbType = tipoDb(inventario && inventario.dbType);
  const sourceDb = String(inventario && inventario.db || '').trim();
  if (!sourceDb) throw new Error('Database di origine mancante nell\u2019inventario.');

  const oggetti = Array.isArray(inventario.oggetti) ? inventario.oggetti : null;
  if (!oggetti) throw new Error('L\u2019inventario non elenca oggetti.');
  const indice = new Map();
  for (const raw of oggetti) {
    const id = String(raw && raw.id || '').trim();
    if (!id || indice.has(id)) throw new Error(`Oggetto duplicato o senza id nell'inventario: "${id}".`);
    indice.set(id, {
      id,
      tipo: String(raw.tipo || ''),
      nome: String(raw.nome || ''),
      haStruttura: raw.haStruttura !== false,
      haDati: raw.haDati === true,
      identita: raw.identita || null,
    });
  }

  const scelte = new Map();
  if (selezione && typeof selezione === 'object') {
    for (const chiave of Object.keys(selezione)) {
      // Non si possono richiedere dati assenti dall'archivio: quasi sempre è
      // un nome scritto male, e saltarlo produrrebbe un import incompleto che
      // si dichiara completo.
      if (!indice.has(chiave)) {
        throw new Error(`La selezione nomina un oggetto assente dall'archivio: ${chiave}.`);
      }
      scelte.set(chiave, selezione[chiave]);
    }
  }

  const voci = [];
  const esclusi = [];
  for (const oggetto of indice.values()) {
    const scelta = scelte.get(oggetto.id);
    // Senza selezione esplicita vale tutto l'inventario (struttura+dati dove
    // esistono): il default è la copia fedele del perimetro, come in export.
    const struttura = scelta && scelta.struttura != null ? !!scelta.struttura : true;
    let dati = scelta && scelta.dati != null ? !!scelta.dati : oggetto.haDati;
    const filtro = (scelta && scelta.filtro) || null;
    const politica = (scelta && scelta.politica) || politicaDefault;
    if (!struttura && !dati) {
      esclusi.push({
        id: oggetto.id,
        motivo: scelta ? 'escluso esplicitamente dalla selezione' : 'non selezionato',
      });
      continue;
    }
    if (struttura && !oggetto.haStruttura) {
      throw new Error(`"${oggetto.id}": l'archivio non contiene la struttura.`);
    }
    if (dati && !oggetto.haDati) {
      throw new Error(`"${oggetto.id}": l'archivio non contiene i dati.`);
    }
    if (filtro && !dati) {
      throw new Error(`"${oggetto.id}": un filtro sui dati richiede che i dati siano selezionati.`);
    }
    if (!POLITICHE_VALIDE.has(politica)) {
      throw new Error(`"${oggetto.id}": politica sconosciuta "${politica}". Ammesse: ${POLITICHE.join(', ')}.`);
    }
    // Fondere senza un'identità stabile non è un merge: è un accoda che non
    // lo dice, con duplicati a ogni riesecuzione.
    if (politica === 'fondi' && !oggetto.identita) {
      throw new Error(`"${oggetto.id}": fondere richiede un'identità stabile (PK/UNIQUE non nullable).`);
    }
    voci.push({
      id: oggetto.id, tipo: oggetto.tipo, nome: oggetto.nome,
      struttura, dati, filtro, politica,
      identita: oggetto.identita,
      esplicito: !!scelta,
    });
  }
  if (!voci.length) {
    throw new Error('La selezione di import non contiene alcun oggetto.');
  }

  // Solo dati: nessuna DDL implicita — l'esecuzione non dovrà creare né
  // modificare lo schema, e qui lo dichiara invece di sperarlo.
  const soloDati = voci.every((v) => !v.struttura);

  return sigilla({
    version: 1,
    kind: 'selezione-import',
    connection: conn,
    dbType,
    sourceDb,
    targetDb: target,
    politicaDefault,
    soloDati,
    voci,
    esclusi,
  });
}

module.exports = { creaSelezioneImport, verificaImpronta, POLITICHE };

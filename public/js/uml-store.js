'use strict';

/* ---------------------------------------------------------------------------
 * Dove vivono i diagrammi fra una sessione e l'altra.
 *
 * IndexedDB nativo, nessuna libreria: un documento di diagramma è un oggetto
 * JSON di qualche decina di kilobyte e l'unica cosa che `localStorage` non
 * saprebbe fare è reggerne parecchi senza occupare la quota sincrona
 * dell'origine.
 *
 * Due proprietà non ovvie:
 *
 * 1. LA CHIAVE È D'AMBITO. Un diagramma appartiene a (utente, connessione,
 *    database): riaprendo con un altro utente non deve ricomparire il lavoro
 *    del precedente, e due database omonimi su due connessioni sono due ambiti
 *    diversi. Una connessione non salvata usa un ambito temporaneo, perché la
 *    sua identità muore con la finestra.
 *
 * 2. IL SALVATAGGIO CONTROLLA LA REVISIONE. Due finestre sullo stesso
 *    diagramma sono due autosave sullo stesso record: senza controllo l'ultima
 *    a scrivere cancella il lavoro dell'altra senza che nessuna delle due lo
 *    sappia. `salva` rifiuta con `conflitto` se il record sul disco è più
 *    avanti della base da cui si è partiti, e chi chiama decide.
 * ------------------------------------------------------------------------- */

const NOME_DB = 'codedb-uml';
const NEGOZIO = 'diagrammi';
const VERSIONE_DB = 1;

let apertura = null;

function apri() {
  if (apertura) return apertura;
  apertura = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('IndexedDB non è disponibile: il diagramma non verrà salvato, ma può essere esportato.')); return; }
    const req = indexedDB.open(NOME_DB, VERSIONE_DB);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NEGOZIO)) {
        const store = db.createObjectStore(NEGOZIO, { keyPath: 'chiave' });
        store.createIndex('ambito', 'ambito', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Impossibile aprire l’archivio dei diagrammi.'));
  }).catch((err) => { apertura = null; throw err; });
  return apertura;
}

/**
 * Una transazione, un valore. `azione` riceve lo store e restituisce il valore
 * (o lo produce dai callback delle richieste); la promessa si risolve quando la
 * transazione ha COMMITTATO, non quando l'ultima richiesta ha risposto: è
 * l'unico istante in cui si può dire che il diagramma è sul disco.
 */
function transazione(modo, azione) {
  return apri().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(NEGOZIO, modo);
    const scatola = { valore: undefined };
    tx.oncomplete = () => resolve(scatola.valore);
    tx.onerror = () => reject(tx.error || new Error('Archivio dei diagrammi non disponibile.'));
    tx.onabort = () => reject(tx.error || new Error('Scrittura del diagramma interrotta: spazio esaurito o archivio bloccato.'));
    try { azione(tx.objectStore(NEGOZIO), scatola); } catch (err) { try { tx.abort(); } catch { /* già chiusa */ } reject(err); }
  }));
}

/** Ambito di un diagramma: chi lo può rivedere alla prossima apertura. */
export function ambitoDi({ utente = 'locale', conn = '', db = '' }) {
  return JSON.stringify([String(utente), String(conn), String(db)]);
}

export function chiaveDiagramma(ambito, id) {
  return `${ambito}\u0000${id}`;
}

/** Elenco (senza documento) dei diagrammi di un ambito, dal più recente. */
export function elenca(ambito) {
  return transazione('readonly', (store, scatola) => {
    const req = store.index('ambito').getAll(ambito);
    req.onsuccess = () => {
      scatola.valore = (req.result || [])
        .map((r) => ({ id: r.id, nome: r.nome, revisione: r.revisione, aggiornato: r.aggiornato }))
        .sort((a, b) => (b.aggiornato || 0) - (a.aggiornato || 0));
    };
  });
}

export function leggi(ambito, id) {
  return transazione('readonly', (store, scatola) => {
    const req = store.get(chiaveDiagramma(ambito, id));
    req.onsuccess = () => { scatola.valore = req.result || null; };
  });
}

/**
 * Salva il documento. `baseRevisione` è la revisione da cui si è partiti: se
 * sul disco ce n'è una più recente il salvataggio non avviene e il chiamante
 * riceve `{ conflitto: true, presente }`.
 */
export function salva(ambito, id, { nome, doc, baseRevisione = 0 }) {
  const chiave = chiaveDiagramma(ambito, id);
  return transazione('readwrite', (store, scatola) => {
    const letto = store.get(chiave);
    letto.onsuccess = () => {
      const presente = letto.result;
      if (presente && Number(presente.revisione || 0) > Number(baseRevisione)) {
        scatola.valore = { conflitto: true, presente };
        return;
      }
      const revisione = Number(baseRevisione) + 1;
      store.put({ chiave, ambito, id, nome, doc, revisione, aggiornato: Date.now() });
      scatola.valore = { conflitto: false, revisione };
    };
  });
}

export function elimina(ambito, id) {
  return transazione('readwrite', (store, scatola) => {
    store.delete(chiaveDiagramma(ambito, id));
    scatola.valore = true;
  });
}

/** Al cambio utente o alla revoca dei permessi: via tutto ciò che è di quell'ambito. */
export async function svuotaAmbito(ambito) {
  for (const d of await elenca(ambito)) await elimina(ambito, d.id);
}

'use strict';

/**
 * Legge un `.codedb.json` v1 SENZA materializzarlo.
 *
 * Il formato storico è un unico documento JSON in cui i dati stanno dentro
 * `collections[].docs[]`: leggerlo con `JSON.parse` significa tenere in memoria
 * l'intero database, ed è esattamente il limite che §2 del piano registra —
 * l'upload viaggiava già a blocchi, ma alla fine si faceva `join` e `parse`, e
 * un trasferimento a blocchi che finisce in una stringa unica non limita la
 * memoria, la sposta.
 *
 * Qui il file attraversa un tokenizzatore incrementale che tiene in memoria
 * soltanto l'**involucro** — nomi, DDL, indici, cioè la parte piccola e
 * limitata — ed emette i documenti **uno per uno**, come testo grezzo, man mano
 * che li incontra. Chi lo usa li scrive su disco e non ne conserva nessuno.
 *
 * Perché un tokenizzatore e non un'espressione regolare su `"docs": [`: dentro
 * una stringa JSON può esserci qualunque cosa — una graffa, una parentesi
 * quadra, un apice preceduto da backslash — e un cercatore di parentesi che non
 * sappia dove finiscono le stringhe taglia nel punto sbagliato. Non produce un
 * errore: produce documenti spezzati, che il `JSON.parse` successivo rifiuta
 * uno a uno lasciando credere che il file sia corrotto.
 *
 * Non è un parser JSON completo, e non deve esserlo: riconosce la STRUTTURA
 * (stringhe, contenitori, chiavi) e lascia la validazione di ogni documento a
 * `JSON.parse`, che è l'unico che debba dire se un documento è valido. Ciò che
 * questo modulo garantisce è di tagliare nel punto giusto e di FALLIRE invece
 * di indovinare quando la struttura non torna.
 */

const { StringDecoder } = require('string_decoder');

const LIMITE_INVOLUCRO = Number(process.env.CODEDB_MAX_ARTIFACT_ENVELOPE_BYTES) || 64 * 1024 * 1024;
const LIMITE_DOCUMENTO = Number(process.env.CODEDB_MAX_ARTIFACT_DOC_BYTES) || 16 * 1024 * 1024;

/**
 * @param {object} eventi
 * @param {(nome: string|null) => void} [eventi.onCollection]
 * @param {(nome: string|null, testo: string) => void} eventi.onDocumento un documento, come testo JSON grezzo
 * @param {(nome: string|null, quanti: number) => void} [eventi.onFineCollection]
 */
function creaLettoreCodedbJson({ onCollection = () => {}, onDocumento, onFineCollection = () => {} } = {}) {
  if (typeof onDocumento !== 'function') throw new Error('Lettore artefatto senza destinazione dei documenti.');

  /**
   * Una cornice per ogni contenitore aperto.
   *  · `chiave`         — negli oggetti, la chiave il cui valore si sta leggendo
   *  · `sottoChiave`    — sotto quale chiave vive QUESTO contenitore
   *  · `attesaChiave`   — negli oggetti, la prossima stringa è una chiave
   */
  const pila = [];
  let involucro = '';
  let inStringa = false;
  let fuga = false;
  let corpoStringa = ''; // contenuto grezzo della stringa in corso, senza apici

  let dentroDocs = false;
  let profondita = 0; // annidamento DENTRO il documento corrente
  let documento = '';
  let collectionCorrente = null;
  let contatore = 0;
  let chiuso = false;
  let resto = '';
  const decodificatore = new StringDecoder('utf8');

  const cima = () => (pila.length ? pila[pila.length - 1] : null);

  function aggiungi(pezzo) {
    involucro += pezzo;
    if (involucro.length > LIMITE_INVOLUCRO) {
      throw new Error(`Involucro dell'artefatto oltre il limite di ${LIMITE_INVOLUCRO} byte.`);
    }
  }

  /**
   * L'array che sta per aprirsi è `collections[].docs`?
   *
   * Il controllo è volutamente stretto: `collections` dev'essere un array
   * figlio DIRETTO dell'oggetto radice. Con un controllo largo, un campo
   * chiamato `docs` dentro un qualunque `collections` annidato altrove nel file
   * verrebbe scambiato per i dati — e i suoi elementi finirebbero scritti come
   * documenti di una collection che non esiste.
   */
  function apreDocs(sottoChiave) {
    if (sottoChiave !== 'docs') return false;
    const elemento = cima();
    if (!elemento || elemento.tipo !== '{') return false;
    const collections = pila[pila.length - 2];
    if (!collections || collections.tipo !== '[' || collections.sottoChiave !== 'collections') return false;
    const radice = pila[pila.length - 3];
    return !!radice && radice.tipo === '{' && pila.length === 3;
  }

  /**
   * Un carattere del documento in corso.
   *
   * Il tetto si applica QUI, non alla chiusura: controllarlo dopo aver
   * accumulato il testo significa aver gia' messo in memoria il documento che
   * si voleva rifiutare — cioe' andare in OOM prima di poter dire perche', in
   * un modulo che esiste proprio per non materializzare il file. L'involucro
   * era gia' controllato cosi' (`aggiungi`): le due vie ora si comportano
   * allo stesso modo.
   */
  function accumula(pezzo) {
    documento += pezzo;
    if (documento.length > LIMITE_DOCUMENTO) {
      throw new Error(`Documento oltre il limite di ${LIMITE_DOCUMENTO} byte.`);
    }
  }

  function chiudiDocumento() {
    const testo = documento.trim();
    documento = '';
    if (!testo) return;
    onDocumento(collectionCorrente, testo);
    contatore += 1;
  }

  function stringaChiusa() {
    const padre = cima();
    let valore = null;
    const decodifica = () => {
      try { return JSON.parse(`"${corpoStringa}"`); } catch { return null; }
    };
    if (padre && padre.tipo === '{' && padre.attesaChiave) {
      padre.chiave = decodifica();
      padre.attesaChiave = false;
    } else {
      valore = decodifica();
      // Il nome della collection è il valore della chiave `name` dentro un
      // elemento di `collections`: si legge qui, cioè PRIMA che si apra
      // l'array `docs` dello stesso oggetto — il formato lo scrive per primo.
      if (padre && padre.tipo === '{' && padre.chiave === 'name' && padre.sottoChiave === 'collections') {
        collectionCorrente = valore;
      }
    }
    corpoStringa = '';
  }

  function carattere(c) {
    /* --- dentro una stringa: nulla ha significato strutturale ------------- */
    if (inStringa) {
      if (dentroDocs) accumula(c); else { aggiungi(c); corpoStringa += c; }
      if (fuga) { fuga = false; return; }
      if (c === '\\') { fuga = true; return; }
      if (c === '"') {
        inStringa = false;
        if (dentroDocs) return;
        // `corpoStringa` include l'apice finale appena aggiunto.
        corpoStringa = corpoStringa.slice(0, -1);
        stringaChiusa();
      }
      return;
    }

    if (c === '"') {
      inStringa = true;
      fuga = false;
      corpoStringa = '';
      if (dentroDocs) accumula(c); else aggiungi(c);
      return;
    }

    /* --- dentro l'array dei documenti: si taglia e si emette -------------- */
    if (dentroDocs) {
      if (c === '{' || c === '[') { profondita += 1; accumula(c); return; }
      if (c === '}') {
        profondita -= 1;
        if (profondita < 0) throw new Error('Struttura dell artefatto non bilanciata dentro "docs".');
        accumula(c);
        return;
      }
      if (c === ']') {
        if (profondita === 0) {
          chiudiDocumento();
          dentroDocs = false;
          pila.pop(); // la cornice dell'array `docs`
          onFineCollection(collectionCorrente, contatore);
          // Nell'involucro resta un array VUOTO: la forma è quella attesa da
          // chi lo legge, senza i dati dentro.
          aggiungi(']');
          return;
        }
        profondita -= 1;
        accumula(c);
        return;
      }
      if (c === ',' && profondita === 0) { chiudiDocumento(); return; }
      accumula(c);
      return;
    }

    /* --- struttura dell'involucro ---------------------------------------- */
    if (c === '{' || c === '[') {
      const padre = cima();
      const sottoChiave = padre
        ? (padre.tipo === '{' ? padre.chiave : padre.sottoChiave)
        : null;
      const apre = apreDocs(sottoChiave);
      pila.push({ tipo: c, chiave: null, sottoChiave, attesaChiave: c === '{' });
      aggiungi(c);
      if (apre) {
        dentroDocs = true;
        profondita = 0;
        documento = '';
        contatore = 0;
        onCollection(collectionCorrente);
      }
      return;
    }

    if (c === '}' || c === ']') {
      const aperto = pila.pop();
      if (!aperto) throw new Error('Struttura dell artefatto non bilanciata.');
      if ((c === '}') !== (aperto.tipo === '{')) {
        throw new Error('Struttura dell artefatto non bilanciata: parentesi disallineate.');
      }
      aggiungi(c);
      return;
    }

    if (c === ',') {
      const padre = cima();
      if (padre) {
        if (padre.tipo === '{') { padre.attesaChiave = true; padre.chiave = null; }
        // Un nuovo elemento di `collections` avrà il proprio `name`: quello
        // vecchio non deve sopravvivergli.
        else if (padre.sottoChiave === 'collections') collectionCorrente = null;
      }
      aggiungi(c);
      return;
    }

    aggiungi(c);
  }

  return {
    scrivi(blocco) {
      if (chiuso) throw new Error('Lettore artefatto gia chiuso.');
      // Un carattere UTF-8 sta su uno a quattro byte e può cadere a cavallo di
      // due blocchi. `Buffer.toString('utf8')` su un blocco troncato NON
      // rimanda indietro i byte incompleti: ci mette un carattere di
      // sostituzione, cioè cambia il contenuto del file senza dirlo — un'emoji
      // dentro un documento diventerebbe «?» a seconda di dove il client ha
      // tagliato il blocco. `StringDecoder` è il pezzo della libreria standard
      // che esiste per questo: trattiene i byte incompleti fino al blocco dopo.
      const parte = Buffer.isBuffer(blocco) ? decodificatore.write(blocco) : String(blocco);
      for (let i = 0; i < parte.length; i += 1) carattere(parte[i]);
    },
    fine() {
      const coda = decodificatore.end();
      for (let i = 0; i < coda.length; i += 1) carattere(coda[i]);
      chiuso = true;
      if (inStringa) throw new Error('Artefatto troncato: stringa non chiusa.');
      if (pila.length) throw new Error('Artefatto troncato: struttura non chiusa.');
      let intestazione;
      try { intestazione = JSON.parse(involucro); }
      catch (err) { throw new Error(`Involucro dell artefatto non valido: ${err.message}`); }
      return intestazione;
    },
  };
}

module.exports = { creaLettoreCodedbJson };

'use strict';

export class ErroreCsv extends Error {
  constructor(messaggio, riga, colonna) {
    super(`CSV non valido alla riga ${riga}, colonna ${colonna}: ${messaggio}`);
    this.name = 'ErroreCsv';
    this.riga = riga;
    this.colonna = colonna;
  }
}

/** Analizza una volta sola il CSV e conserva le coordinate di ogni record. */
export function analizzaCsv(testo) {
  const righe = [];
  const posizioni = [];
  let record = [];
  let campo = '';
  let stato = 'inizio';
  let riga = 1;
  let colonna = 1;
  let rigaRecord = 1;

  const chiudiCampo = () => { record.push(campo); campo = ''; stato = 'inizio'; };
  const chiudiRecord = () => {
    chiudiCampo();
    // Una riga davvero vuota può essere ignorata; `,` invece è una riga con
    // due celle vuote e deve sopravvivere come qualunque altro record.
    if (record.length > 1 || record[0] !== '') {
      righe.push(record);
      posizioni.push(rigaRecord);
    }
    record = [];
    rigaRecord = riga + 1;
  };

  for (let i = 0; i < testo.length; i++) {
    const carattere = testo[i];
    const crlf = carattere === '\r' && testo[i + 1] === '\n';
    let crlfConsumito = false;
    if (stato === 'virgolette') {
      if (carattere === '"') stato = testo[i + 1] === '"' ? 'doppia' : 'chiusa';
      else campo += carattere;
    } else if (stato === 'doppia') {
      campo += '"';
      stato = 'virgolette';
    } else if (stato === 'chiusa') {
      if (carattere === ',') chiudiCampo();
      else if (carattere === '\r' || carattere === '\n') {
        chiudiRecord();
        if (crlf) { i++; crlfConsumito = true; }
      } else {
        throw new ErroreCsv('carattere inatteso dopo la virgoletta di chiusura', riga, colonna);
      }
    } else if (carattere === ',' ) {
      chiudiCampo();
    } else if (carattere === '\r' || carattere === '\n') {
      chiudiRecord();
      if (crlf) { i++; crlfConsumito = true; }
    } else if (carattere === '"') {
      if (stato !== 'inizio' || campo) throw new ErroreCsv('virgolette ammesse solo all’inizio del campo', riga, colonna);
      stato = 'virgolette';
    } else {
      campo += carattere;
      stato = 'testo';
    }

    if (carattere === '\n' || (carattere === '\r' && (!crlf || crlfConsumito))) {
      riga++;
      colonna = 1;
    } else colonna++;
  }

  if (stato === 'virgolette' || stato === 'doppia') {
    throw new ErroreCsv('campo tra virgolette non chiuso', riga, colonna);
  }
  if (campo !== '' || record.length || stato === 'chiusa') chiudiRecord();
  return { righe, posizioni };
}

/** Valida tutto il file prima di costruire il primo oggetto mutabile/importabile. */
export function preparaImportCsv(testo) {
  const analisi = analizzaCsv(testo);
  const { righe, posizioni } = analisi;
  if (righe.length < 2) {
    throw new Error('CSV vuoto o senza righe di dati: serve una riga di intestazione più almeno una riga.');
  }
  const intestazione = righe[0].map((nome) => nome.trim());
  if (intestazione.some((nome) => !nome)) throw new Error('La riga di intestazione del CSV contiene colonne senza nome.');
  const viste = new Set();
  for (const nome of intestazione) {
    if (viste.has(nome)) throw new Error(`Intestazione duplicata nel CSV: "${nome}".`);
    viste.add(nome);
  }
  for (let i = 1; i < righe.length; i++) {
    if (righe[i].length !== intestazione.length) {
      throw new Error(`La riga ${posizioni[i]} contiene ${righe[i].length} campi, ma l’intestazione ne dichiara ${intestazione.length}.`);
    }
  }
  const documenti = righe.slice(1).map((valori) => Object.fromEntries(
    intestazione.map((nome, indice) => [nome, valori[indice] === '' ? null : valori[indice]])
  ));
  return { ...analisi, intestazione, documenti };
}

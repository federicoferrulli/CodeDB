'use strict';

const { serialize } = require('bson');
const { decodificaMetadati } = require('./mongoSchemaBson');

// È il codice eseguito da mongosh. Verifica l'intero perimetro prima della
// prima DROP, compresi i nomi destinati soltanto ai documenti.
async function applicaStruttura(destinazione, oggetti, suCreazione = () => {}) {
  const nomi = oggetti.map(o => o.nome);
  const presenti = new Map((await destinazione.getCollectionInfos({ name: { $in: nomi } })).map(o => [o.name, o]));
  for (const o of oggetti) {
    const attuale = presenti.get(o.nome);
    if (attuale && attuale.type !== o.tipo) {
      throw new Error('"' + o.nome + '" è di tipo ' + attuale.type + ', il file richiede ' + o.tipo + '.');
    }
    if (attuale?.options?.encryptedFields) throw new Error('"' + o.nome + '" usa Queryable Encryption sulla destinazione.');
    if (attuale && o.modalita === 'crea') throw new Error('"' + o.nome + '" esiste già sulla destinazione.');
    if (!attuale && o.modalita === 'solo-dati') throw new Error('La collection "' + o.nome + '" deve esistere per caricarne i dati.');
  }
  async function comando(cmd) {
    const risposta = await destinazione.runCommand(cmd);
    if (Number(risposta.ok) !== 1 || risposta.writeConcernError) {
      throw new Error(risposta.writeConcernError?.errmsg || risposta.errmsg || 'Comando di struttura MongoDB non riuscito.');
    }
  }
  for (const o of oggetti) {
    const attuale = presenti.get(o.nome);
    if (o.modalita === 'solo-dati' || (attuale && o.modalita === 'se-assente')) continue;
    if (attuale) {
      // Le collection ordinarie espongono un UUID: il server controlla che
      // il nome indichi ancora la stessa collection al momento della DROP.
      const uuid = attuale.info?.uuid;
      if (!uuid) {
        const [corrente] = await destinazione.getCollectionInfos({ name: o.nome });
        if (corrente?.type !== o.tipo) throw new Error('È cambiato il tipo di "' + o.nome + '" prima della rimozione.');
      }
      await comando({ drop: o.nome, ...(uuid ? { collectionUUID: uuid } : {}) });
    }
    try {
      await comando({ create: o.nome, ...o.opzioni });
    } catch (errore) {
      if (attuale) throw new Error('"' + o.nome + '" è stato rimosso ma la ricreazione è fallita. ' + errore.message, { cause: errore });
      throw errore;
    }
    await suCreazione(o, !!attuale);
    if (o.tipo === 'timeseries') {
      // Il server può creare l'indice meta/tempo anche se nell'origine era
      // stato rimosso. Operiamo soltanto sulla time-series appena creata.
      const richiesti = new Set(o.indici.map(i => i.name));
      for (const indice of await destinazione.getCollection(o.nome).getIndexes()) {
        if (!richiesti.has(indice.name)) await comando({ dropIndexes: o.nome, index: indice.name });
      }
    }
    for (const indice of o.indici) await comando({ createIndexes: o.nome, indexes: [indice] });
  }
}

function preparaStrutturaMongo({ plan, tables, catalogoMongo, indiciPer }) {
  const opzioni = plan.opzioniMongo || {};
  const perId = new Map(plan.oggetti.map(o => [o.id, o]));
  const ordine = [...plan.ordine.creazione, ...tables.filter(t => !t.struttura).map(t => t.id)];
  return ordine.map(id => {
    const o = perId.get(id);
    const info = catalogoMongo.get(o.nome);
    const tipo = info?.type;
    if (!info || (o.tipo === 'vista' ? tipo !== 'view' : !['collection', 'timeseries'].includes(tipo))) {
      throw new Error(`È cambiato il tipo di "${o.nome}": rigenerare l'anteprima di export.`);
    }
    if (info.options?.encryptedFields) throw new Error(`"${o.nome}" usa Queryable Encryption e richiede anche le collection di stato e la configurazione delle chiavi.`);
    if (tipo === 'timeseries' && o.dati && (opzioni.documenti || 'inserisci') !== 'inserisci') {
      throw new Error(`La time-series "${o.nome}" supporta l'inserimento di misure nello script. Scegliere «Inserisci» per esportarne i dati.`);
    }
    let modalita = opzioni.collection || 'crea';
    if (!o.struttura) modalita = 'solo-dati';
    else if (modalita === 'ricrea' && o.aggiuntoPerDipendenza) modalita = 'se-assente';
    let creazione = {}, indici = [];
    if (o.struttura) {
      creazione = { ...info.options, ...(info.idIndex ? { idIndex: info.idIndex } : {}) };
    }
    if (o.struttura && tipo !== 'view') {
      indici = indiciPer(id).filter(i => !i.clustered && i.name !== '_id_')
        .map(i => {
          const { ns, ...spec } = i;
          // listIndexes omette la collation "simple". Con un'altra collation
          // di default, ometterla nella CREATE cambierebbe l'indice.
          if (creazione.collation && !spec.collation) spec.collation = { locale: 'simple' };
          return spec;
        });
    }
    return { nome: o.nome, tipo, modalita, opzioni: creazione, indici };
  });
}

function strutturaMongosh({ plan, tables, meta, catalogoMongo, espressioneBson }) {
  const oggetti = preparaStrutturaMongo({ plan, tables, catalogoMongo, indiciPer: id => meta.get(id).indexes.map(decodificaMetadati) });
  const righe = oggetti.map(o => {
    const espressione = doc => espressioneBson(serialize(doc, { ignoreUndefined: false }), o.nome);
    return `  { nome: ${JSON.stringify(o.nome)}, tipo: ${JSON.stringify(o.tipo)}, modalita: ${JSON.stringify(o.modalita)}, opzioni: ${espressione(o.opzioni)}, indici: [${o.indici.map(espressione).join(', ')}] }`;
  });
  return `await (${applicaStruttura.toString()})(destinazione, [\n${righe.join(',\n')}\n]);\n`;
}

module.exports = { strutturaMongosh, preparaStrutturaMongo, applicaStruttura };

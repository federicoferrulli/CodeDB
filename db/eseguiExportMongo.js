'use strict';

const BSON = require('bson');
const { verificaImpronta, databaseDiSistema } = require('./exportPlan');
const { apriLettura } = require('./mongoTopologia');
const { scriviRaw } = require('./mongoBson');
const { preparaStrutturaMongo, applicaStruttura } = require('./exportMongoStruttura');
const { applicaDocumento } = require('./exportMongoScript');

const tipiNativi = { promoteValues: false, bsonRegExp: true };
const catalogoPrimario = { ...tipiNativi, readPreference: 'primary' };

async function controllaAlias(sorgente, destinazione, infos, db, dbOrigine) {
  const errore = () => new Error('Origine e destinazione indicano lo stesso database MongoDB. Scegli un altro database.');
  if (sorgente.client === destinazione.client) throw errore();
  // L'inventario completo include system.views e i bucket delle time-series:
  // così resta una prova fisica anche in una selezione composta di sole viste.
  const ancheQui = await db.listCollections({}, catalogoPrimario).toArray();
  const uuid = elenco => new Set(elenco.flatMap(i => i.info?.uuid ? [i.info.uuid.toString('hex')] : []));
  const origine = uuid(infos), obiettivo = uuid(ancheQui);
  if ([...origine].some(id => obiettivo.has(id))) throw errore();
  const [a, b] = await Promise.all([sorgente, destinazione].map(st =>
    st.client.db('admin').command({ hello: 1 }, { readPreference: 'primary' })));
  const pid = h => h.topologyVersion?.processId?.toHexString();
  if (pid(a) && pid(a) === pid(b)) throw errore();
  if (pid(a) && pid(b) && !a.setName && !b.setName && a.msg !== 'isdbgrid' && b.msg !== 'isdbgrid') return;
  // Due router o due primari a cavallo di un'elezione possono avere processi
  // distinti sullo stesso deployment. Un UUID sorgente ancora presente DOPO
  // la lettura della destinazione distingue gli inventari; se nel frattempo
  // è stato ricreato tutto, serve una nuova anteprima.
  const attuali = uuid(await dbOrigine.listCollections({}, catalogoPrimario).toArray());
  if ([...origine].some(id => attuali.has(id) && !obiettivo.has(id))) return;
  throw new Error('Impossibile distinguere con certezza i due database omonimi. Scegli un nome di destinazione diverso.');
}

async function eseguiExportMongo({ sorgente, destinazione, plan, dbDestinazione, onProgress = () => {}, check = () => {} }) {
  const risultato = { inseriti: 0, aggiornati: 0, sostituiti: 0, mantenuti: 0,
    collectionCreate: 0, collectionRicreate: 0, visteCreate: 0, visteRicreate: 0 };
  let lettura;
  let rows = 0;
  const progress = collection => onProgress({ collection, rows, risultato: { ...risultato } });
  try {
    verificaImpronta(plan);
    if (plan.dbType !== 'mongodb' || plan.formato !== 'mongosh' || !sorgente?.client || !destinazione?.client) {
      throw new Error('La copia diretta richiede un piano MongoDB e due connessioni MongoDB aperte.');
    }
    if (typeof dbDestinazione !== 'string' || !dbDestinazione.trim() || databaseDiSistema('mongodb', dbDestinazione)) {
      throw new Error('Scegli un database di destinazione diverso dai database di sistema.');
    }
    if (!plan.destinazioneMongo || plan.destinazioneMongo.db !== dbDestinazione) {
      throw new Error('Il database di destinazione non coincide con quello confermato nel piano.');
    }
    if (plan.oggetti.some(o => o.filtro)) throw new Error('La copia diretta non supporta filtri sui documenti.');
    const modo = plan.opzioniMongo.documenti;
    const origine = sorgente.client.db(plan.sourceDb);
    const arrivo = destinazione.client.db(dbDestinazione);
    const comando = cmd => { check(); return arrivo.command(cmd, { readPreference: 'primary' }); };
    check();
    const infos = await origine.listCollections({}, catalogoPrimario).toArray();
    if (plan.sourceDb.toLowerCase() === dbDestinazione.toLowerCase()) {
      await controllaAlias(sorgente, destinazione, infos, arrivo, origine);
    }
    const catalogoMongo = new Map(infos.map(o => [o.name, o]));
    const tabelle = plan.oggetti.filter(o => o.tipo === 'collection');
    const indici = new Map();
    for (const t of tabelle.filter(t => t.struttura)) {
      check();
      indici.set(t.id, await origine.collection(t.nome).indexes(catalogoPrimario));
    }
    const oggetti = preparaStrutturaMongo({ plan, tables: tabelle, catalogoMongo, indiciPer: id => indici.get(id) });
    lettura = await apriLettura(sorgente.client);
    const conteggi = new Map();
    const dati = tabelle.filter(t => t.dati);
    for (const t of dati) {
      check();
      conteggi.set(t.id, await origine.collection(t.nome).countDocuments({}, lettura.options));
    }
    await applicaStruttura({
      getCollectionInfos: filtro => arrivo.listCollections(filtro, catalogoPrimario).toArray(),
      getCollection: nome => ({ getIndexes: () => arrivo.collection(nome).indexes(catalogoPrimario) }),
      runCommand: comando,
    }, oggetti, (o, ricreata) => {
      const azione = o.tipo === 'view' ? (ricreata ? 'visteRicreate' : 'visteCreate')
        : (ricreata ? 'collectionRicreate' : 'collectionCreate');
      risultato[azione]++;
      return progress(o.nome);
    });
    for (const t of dati) {
      const coll = origine.collection(t.nome);
      const attesi = conteggi.get(t.id);
      let letti = 0;
      await progress(t.nome);
      const cursor = coll.find({}, { ...lettura.options, raw: true }).batchSize(100);
      try {
        for await (const raw of cursor) {
          check();
          let esito;
          if (modo === 'inserisci') {
            // Il protocollo BSON preserva anche date fuori range, campi
            // duplicati e misure time-series senza _id.
            const r = await scriviRaw(arrivo, t.nome, raw, { readPreference: 'primary' });
            if (r.n !== 1) throw new Error('Inserimento MongoDB non confermato.');
            esito = 'inseriti';
          } else {
            const doc = BSON.deserialize(raw, tipiNativi);
            if (!BSON.serialize(doc).equals(raw)) {
              throw new Error(`Il BSON di "${t.nome}" non si può convertire fedelmente per il confronto o la modifica per _id. Scegli Inserisci in una collection vuota.`);
            }
            esito = await applicaDocumento(comando, modo, t.nome, doc);
          }
          risultato[esito]++;
          letti++; rows++;
          if (letti % 100 === 0) await progress(t.nome);
        }
      } finally { await cursor.close(); }
      if (letti !== attesi || attesi !== await coll.countDocuments({}, lettura.options)) {
        throw new Error(`Il conteggio di "${t.nome}" è cambiato durante la copia. Ripeti senza scritture concorrenti.`);
      }
      await progress(t.nome);
    }
    return risultato;
  } catch (err) {
    err.risultato = { ...risultato };
    throw err;
  } finally {
    try { await lettura?.close(); }
    catch (err) { err.risultato = { ...risultato }; throw err; }
  }
}

module.exports = { eseguiExportMongo };

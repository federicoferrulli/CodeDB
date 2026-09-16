'use strict';

/**
 * Il piano di export, con le stesse proprietà del piano di import: immutabile,
 * firmato da un'impronta, e costruito PRIMA che qualunque cosa venga letta o
 * scritta. È il contratto che l'anteprima mostra e che l'esecuzione esegue; se
 * le due impronte non coincidono l'esecuzione viene rifiutata, perché la
 * conferma dell'utente descriveva un'operazione diversa.
 *
 * Qui dentro non c'è nulla che sappia di MySQL, PostgreSQL o MongoDB, e nulla
 * che apra una connessione: il CATALOGO arriva come dato (`db/exportCatalogo.js`
 * lo legge dal motore) e tutto ciò che questo modulo fa è decidere. È la
 * ragione per cui l'ordine delle barriere, la chiusura delle dipendenze e le
 * esclusioni si provano senza alcun database.
 *
 * Due cose che questo modulo NON fa, e che non sono dimenticanze:
 *
 *  · non chiude le dipendenze dei DATI. La chiusura dello schema non è la
 *    chiusura dei dati (§6.3 del piano): esportare gli ordini filtrati richiede
 *    anche i clienti referenziati, e quell'espansione va CHIESTA, perché può
 *    moltiplicare il perimetro. Qui le dipendenze dati vengono DICHIARATE, una
 *    per una, con lo stato in cui restano;
 *  · non deduce relazioni. Il grafo viene dal catalogo reale — vincoli
 *    dichiarati, dipendenze di view, tabella di un trigger — mai dalle
 *    euristiche UML di `DbStrategy.detectRelations`, che indovinano un legame
 *    dal nome di una colonna. Indovinare qui significa esportare una tabella
 *    che nessuno ha chiesto, o non esportarne una che serviva.
 */

const { sigilla, verificaImpronta } = require('./pianoComune');
const { tipoDb } = require('./artefatti');

/** Le quattro modalità globali di §1 del piano. La quinta non esiste. */
const MODALITA = Object.freeze({
  STRUTTURA_E_DATI: 'struttura-e-dati',
  SOLO_STRUTTURA: 'solo-struttura',
  SOLO_DATI: 'solo-dati',
  PERSONALIZZATA: 'personalizzata',
});
const MODALITA_VALIDE = new Set(Object.values(MODALITA));

/** I tipi di oggetto che un catalogo può dichiarare. */
const TIPI = Object.freeze([
  'tabella', 'collection', 'vista', 'routine', 'trigger', 'evento', 'sequenza',
]);
const TIPI_VALIDI = new Set(TIPI);

/** Gli oggetti che PORTANO righe: gli unici su cui «dati» ha un significato. */
const TIPI_CON_DATI = new Set(['tabella', 'collection']);

/**
 * Database che contengono metadati del server, non dati dell'utente.
 *
 * Il controllo viveva SOLO in `public/js/exportimport.js`, cioè nel browser:
 * chiunque parlasse direttamente con il socket poteva chiedere l'export di
 * `mysql` o di `pg_catalog`. Qui è dentro la costruzione del piano, che è il
 * punto da cui passano UI, CLI e MCP.
 */
const DB_DI_SISTEMA = Object.freeze({
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  // Su PostgreSQL il livello «database» dell'interfaccia è lo SCHEMA: qui
  // vanno quindi gli schemi di sistema, non i database.
  postgresql: ['information_schema', 'pg_catalog', 'pg_toast'],
  mongodb: ['admin', 'config', 'local'],
});

function databaseDiSistema(dbType, nome) {
  const elenco = DB_DI_SISTEMA[tipoDb(dbType)] || [];
  return elenco.includes(String(nome || '').toLowerCase());
}

/** L'identificatore di un oggetto nel grafo: `tipo:nome`, mai il solo nome. */
function idOggetto(oggetto) {
  return `${oggetto.tipo}:${oggetto.nome}`;
}

function normalizzaCatalogo(catalogo) {
  if (!catalogo || typeof catalogo !== 'object') throw new Error('Catalogo di export mancante.');
  const oggetti = Array.isArray(catalogo.oggetti) ? catalogo.oggetti : null;
  if (!oggetti) throw new Error('Il catalogo di export non elenca oggetti.');
  const visti = new Set();
  const normalizzati = oggetti.map((raw) => {
    const tipo = String(raw && raw.tipo || '').trim();
    const nome = String(raw && raw.nome || '').trim();
    if (!TIPI_VALIDI.has(tipo)) {
      throw new Error(`Tipo di oggetto sconosciuto nel catalogo: "${tipo}". Ammessi: ${TIPI.join(', ')}.`);
    }
    if (!nome) throw new Error(`Oggetto di tipo "${tipo}" senza nome nel catalogo.`);
    const id = `${tipo}:${nome}`;
    if (visti.has(id)) throw new Error(`Oggetto dichiarato due volte nel catalogo: ${id}.`);
    visti.add(id);
    return {
      tipo,
      nome,
      id,
      // Stima, non conteggio: vale `null` quando il motore non la conosce, e
      // quel «non so» non va confuso con zero.
      righeStimate: raw.righeStimate == null ? null : Number(raw.righeStimate),
      identita: raw.identita || null,
      tabella: raw.tabella ? String(raw.tabella) : null,
    };
  });
  return { oggetti: normalizzati, indice: new Map(normalizzati.map((o) => [o.id, o])) };
}

/**
 * Le dipendenze del catalogo, ripulite.
 *
 * `esterna: true` significa che il bersaglio sta FUORI dal database esportato:
 * non è un oggetto da aggiungere, è un prerequisito che la destinazione dovrà
 * già avere. Confondere i due casi produce un export che si dichiara completo
 * e non lo è.
 */
function normalizzaDipendenze(catalogo, indice) {
  const righe = Array.isArray(catalogo.dipendenze) ? catalogo.dipendenze : [];
  const archi = [];
  const esterne = [];
  const nonDeducibili = [];
  for (const raw of righe) {
    const da = String(raw && raw.da || '').trim();
    if (!da) throw new Error('Dipendenza senza origine nel catalogo.');
    if (!indice.has(da)) throw new Error(`Dipendenza da un oggetto assente dal catalogo: ${da}.`);
    const tipo = String(raw.tipo || 'sconosciuta');
    if (raw.a == null) {
      // Un corpo di routine con SQL dinamico ha dipendenze che nessun catalogo
      // conosce. Vanno DICHIARATE, non date per assenti (§6.3).
      nonDeducibili.push({ da, tipo, nota: String(raw.nota || 'dipendenza non deducibile dal catalogo') });
      continue;
    }
    const a = String(raw.a).trim();
    if (raw.esterna) {
      esterne.push({ da, a, tipo, db: raw.db ? String(raw.db) : null });
      continue;
    }
    if (!indice.has(a)) {
      throw new Error(`Dipendenza verso un oggetto assente dal catalogo e non dichiarata esterna: ${a}.`);
    }
    archi.push({ da, a, tipo, campo: raw.campo ? String(raw.campo) : null });
  }
  return { archi, esterne, nonDeducibili };
}

/**
 * Che cosa la modalità globale impone a un oggetto NON nominato dalla selezione.
 *
 * In modalità personalizzata la base è **niente**: l'utente sta elencando ciò
 * che vuole, e ciò che non ha nominato non lo vuole. Con la base «tutto» la
 * modalità personalizzata sarebbe indistinguibile da struttura+dati finché non
 * si esclude qualcosa esplicitamente — cioè chiedere una sola vista
 * esporterebbe l'intero database.
 */
function modalitaBase(modalita, oggetto) {
  const portaDati = TIPI_CON_DATI.has(oggetto.tipo);
  if (modalita === MODALITA.PERSONALIZZATA) return { struttura: false, dati: false };
  if (modalita === MODALITA.SOLO_STRUTTURA) return { struttura: true, dati: false };
  if (modalita === MODALITA.SOLO_DATI) return { struttura: false, dati: portaDati };
  return { struttura: true, dati: portaDati };
}

/**
 * Applica la selezione per oggetto sopra la modalità globale.
 *
 * Una selezione che nomina un oggetto assente dal catalogo è un ERRORE, non una
 * riga da saltare: quasi sempre è un nome scritto male, e saltarla in silenzio
 * produce un export che non contiene ciò che è stato chiesto, senza dirlo.
 */
function applicaSelezione(oggetti, modalita, selezione) {
  const scelte = new Map();
  if (selezione && typeof selezione === 'object') {
    const noti = new Set(oggetti.map((o) => o.id));
    for (const chiave of Object.keys(selezione)) {
      if (!noti.has(chiave)) {
        throw new Error(`La selezione nomina un oggetto assente dal catalogo: ${chiave}.`);
      }
      scelte.set(chiave, selezione[chiave]);
    }
  }
  return oggetti.map((oggetto) => {
    const base = modalitaBase(modalita, oggetto);
    const scelta = scelte.get(oggetto.id);
    if (!scelta) return { ...oggetto, ...base, filtro: null, esplicito: false };
    const struttura = scelta.struttura == null ? base.struttura : !!scelta.struttura;
    let dati = scelta.dati == null ? base.dati : !!scelta.dati;
    const filtro = scelta.filtro || null;
    if (filtro && !dati) {
      throw new Error(`"${oggetto.id}": un filtro sui dati richiede che i dati siano selezionati.`);
    }
    if (dati && !TIPI_CON_DATI.has(oggetto.tipo)) {
      throw new Error(`"${oggetto.id}": un oggetto di tipo "${oggetto.tipo}" non porta righe.`);
    }
    return { ...oggetto, struttura, dati, filtro, esplicito: true };
  });
}

/**
 * Chiusura delle dipendenze di STRUTTURA.
 *
 * Un oggetto selezionato per la struttura tira dentro ciò da cui dipende, in
 * modo transitivo, e ogni aggiunta porta con sé il MOTIVO — quale oggetto l'ha
 * richiesta e con quale tipo di legame. Senza il motivo, un albero di selezione
 * mostra oggetti comparsi dal nulla.
 *
 * Le dipendenze di CHIAVE ESTERNA non partecipano alla chiusura della struttura
 * nello stesso modo delle altre: una FK si applica dopo il caricamento dei
 * dati, quindi non vincola l'ordine di CREAZIONE. Vincola però il perimetro: la
 * tabella riferita deve esserci, altrimenti il vincolo non si può ricreare.
 */
function chiudiStruttura(scelte, archi, indice) {
  const stato = new Map(scelte.map((s) => [s.id, { ...s }]));
  const aggiunti = [];
  const perOrigine = new Map();
  for (const arco of archi) {
    if (!perOrigine.has(arco.da)) perOrigine.set(arco.da, []);
    perOrigine.get(arco.da).push(arco);
  }
  const coda = scelte.filter((s) => s.struttura).map((s) => s.id);
  const visitati = new Set(coda);
  while (coda.length) {
    const id = coda.shift();
    for (const arco of perOrigine.get(id) || []) {
      // La chiave esterna e' l'unica dipendenza che NON allarga il perimetro.
      // §3 del piano: «una FK verso una tabella esclusa richiede includerla
      // oppure dichiararla prerequisito esterno» — cioe' e' una decisione, non
      // una conseguenza. Una vista senza la sua tabella non esiste affatto;
      // una tabella senza quella che riferisce esiste benissimo, e includere
      // d'ufficio i clienti perche' si sono chiesti gli ordini puo' trascinare
      // dentro mezzo database senza che nessuno l'abbia chiesto. Il vincolo
      // resta dichiarato in `ordine.vincoli` e in `vincoliOmessi`.
      if (arco.tipo === 'fk') continue;
      const bersaglio = stato.get(arco.a);
      if (!bersaglio) continue;
      if (!bersaglio.struttura) {
        bersaglio.struttura = true;
        bersaglio.aggiuntoPerDipendenza = true;
        aggiunti.push({
          id: arco.a,
          richiestoDa: id,
          tipo: arco.tipo,
          motivo: `richiesto da ${id} (${arco.tipo})`,
        });
      }
      if (!visitati.has(arco.a)) {
        visitati.add(arco.a);
        coda.push(arco.a);
      }
    }
  }
  return { stato: [...stato.values()].map((s) => ({ ...s, oggetto: indice.get(s.id) })), aggiunti };
}

/**
 * Ordine di ricostruzione.
 *
 * Tre liste distinte, e la separazione è il punto: le chiavi esterne si
 * applicano DOPO i dati, quindi un ciclo di FK — `a` riferisce `b` e `b`
 * riferisce `a`, che è legale e comune — non impedisce di creare le tabelle.
 * Se invece un ciclo resta fra le dipendenze di creazione (due routine che si
 * chiamano a vicenda), si dichiara: fingere un ordine sarebbe peggio che dire
 * che non ce n'è uno.
 */
function ordina(stato, archi) {
  const inclusi = new Set(stato.filter((s) => s.struttura).map((s) => s.id));
  const creazione = archi.filter((a) => a.tipo !== 'fk' && inclusi.has(a.da) && inclusi.has(a.a));
  const gradi = new Map([...inclusi].map((id) => [id, 0]));
  const uscenti = new Map([...inclusi].map((id) => [id, []]));
  for (const arco of creazione) {
    // `da` dipende da `a`: `a` va creato prima.
    uscenti.get(arco.a).push(arco.da);
    gradi.set(arco.da, gradi.get(arco.da) + 1);
  }
  // A parità di vincoli si conserva l'ordine del catalogo, così due esecuzioni
  // sullo stesso database producono lo stesso piano e la stessa impronta.
  const ordineCatalogo = stato.filter((s) => inclusi.has(s.id)).map((s) => s.id);
  const pronti = ordineCatalogo.filter((id) => gradi.get(id) === 0);
  const risultato = [];
  while (pronti.length) {
    const id = pronti.shift();
    risultato.push(id);
    for (const successivo of uscenti.get(id)) {
      gradi.set(successivo, gradi.get(successivo) - 1);
      if (gradi.get(successivo) === 0) {
        // Reinserito rispettando l'ordine del catalogo.
        const posizione = pronti.findIndex((altro) => ordineCatalogo.indexOf(altro) > ordineCatalogo.indexOf(successivo));
        if (posizione < 0) pronti.push(successivo); else pronti.splice(posizione, 0, successivo);
      }
    }
  }
  const cicli = ordineCatalogo.filter((id) => !risultato.includes(id));
  return {
    creazione: [...risultato, ...cicli],
    cicli,
    dati: stato.filter((s) => s.dati).map((s) => s.id),
    vincoli: archi
      .filter((a) => a.tipo === 'fk' && inclusi.has(a.da))
      .map((a) => ({ da: a.da, a: a.a, campo: a.campo, presente: inclusi.has(a.a) })),
  };
}

/**
 * Le dipendenze dei DATI, dichiarate e mai chiuse d'ufficio.
 *
 * Una FK il cui bersaglio è nel perimetro ma senza dati, o con dati filtrati,
 * produrrà righe orfane nella destinazione. Non è un errore da fermare qui —
 * può essere esattamente ciò che si vuole — ma non può restare invisibile.
 */
function dipendenzeDati(stato, archi) {
  const per = new Map(stato.map((s) => [s.id, s]));
  const fuori = [];
  for (const arco of archi) {
    if (arco.tipo !== 'fk') continue;
    const origine = per.get(arco.da);
    const bersaglio = per.get(arco.a);
    if (!origine || !origine.dati) continue;
    if (!bersaglio || !bersaglio.dati) {
      fuori.push({ da: arco.da, a: arco.a, campo: arco.campo, stato: 'bersaglio-senza-dati' });
    } else if (bersaglio.filtro || origine.filtro) {
      fuori.push({ da: arco.da, a: arco.a, campo: arco.campo, stato: 'chiusura-dati-non-garantita' });
    }
  }
  return fuori;
}

/**
 * Costruisce e congela il piano di export.
 *
 * @param {object} opts
 * @param {object} opts.catalogo   oggetti e dipendenze reali del database
 * @param {string} opts.connection nome della connessione (su cui poggiano i permessi)
 * @param {string} opts.modalita   una delle quattro di MODALITA
 * @param {object} [opts.selezione] scelte per oggetto, chiave `tipo:nome`
 * @param {string} [opts.formato]  contenitore dell'artefatto
 * @param {object} [opts.destinazione] dove finisce l'artefatto
 */
function creaPianoExport({
  catalogo,
  connection,
  modalita = MODALITA.STRUTTURA_E_DATI,
  selezione = null,
  formato = 'codedb-backup',
  destinazione = { kind: 'server' },
  backend = 'incorporato',
  consistenza = 'nessuna-garanzia',
  compressione = true,
  verificaDati = 'conteggi',
} = {}) {
  if (!MODALITA_VALIDE.has(modalita)) {
    throw new Error(`Modalità di export sconosciuta: "${modalita}". Ammesse: ${[...MODALITA_VALIDE].join(', ')}.`);
  }
  const conn = String(connection || '').trim();
  if (!conn) throw new Error('Connessione di origine mancante.');
  const dbType = tipoDb(catalogo && catalogo.dbType);
  const sourceDb = String(catalogo && catalogo.db || '').trim();
  if (!sourceDb) throw new Error('Database di origine mancante nel catalogo.');
  if (databaseDiSistema(dbType, sourceDb)) {
    throw new Error(`"${sourceDb}" è un database di sistema: contiene metadati del server, non dati esportabili.`);
  }
  if (modalita === MODALITA.PERSONALIZZATA && !selezione) {
    throw new Error('La modalità personalizzata richiede una selezione per oggetto.');
  }

  const { oggetti, indice } = normalizzaCatalogo(catalogo);
  const { archi, esterne, nonDeducibili } = normalizzaDipendenze(catalogo, indice);
  const scelte = applicaSelezione(oggetti, modalita, selezione);
  const { stato, aggiunti } = chiudiStruttura(scelte, archi, indice);
  const ordine = ordina(stato, archi);

  const inclusi = stato.filter((s) => s.struttura || s.dati);
  if (!inclusi.length) {
    throw new Error('Il piano di export non contiene alcun oggetto: né struttura né dati sono stati selezionati.');
  }
  const esclusi = stato
    .filter((s) => !s.struttura && !s.dati)
    .map((s) => ({
      id: s.id,
      motivo: s.esplicito ? 'escluso esplicitamente dalla selezione' : 'non selezionato',
    }));

  // Solo struttura non scorre i dati: il piano lo DICHIARA, così nessuna fase
  // può decidere per conto proprio di lanciare un COUNT(*) «tanto per sapere».
  const contaRighe = stato.some((s) => s.dati);

  const body = {
    version: 1,
    kind: 'export-database',
    connection: conn,
    dbType,
    sourceDb,
    modalita,
    formato,
    backend,
    compressione: !!compressione,
    destinazione,
    consistenza,
    contaRighe,
    // La lettura passa dal driver nativo, fuori dal proxy autorizzante: serve
    // la capability sull'INTERA connessione, non su un singolo database.
    capability: { connessione: 'read', ambito: 'intera-connessione' },
    verifica: {
      artefatto: true,
      schema: stato.some((s) => s.struttura),
      dati: contaRighe ? verificaDati : 'nessuna',
    },
    oggetti: inclusi.map((s) => ({
      id: s.id,
      tipo: s.tipo,
      nome: s.nome,
      struttura: s.struttura,
      dati: s.dati,
      filtro: s.filtro || null,
      righeStimate: s.dati ? s.righeStimate : null,
      identita: s.identita || null,
      aggiuntoPerDipendenza: !!s.aggiuntoPerDipendenza,
    })),
    dipendenzeAggiunte: aggiunti,
    prerequisitiEsterni: esterne.filter((e) => inclusi.some((s) => s.id === e.da)),
    dipendenzeNonDeducibili: nonDeducibili.filter((d) => inclusi.some((s) => s.id === d.da)),
    dipendenzeDati: dipendenzeDati(stato, archi),
    // I vincoli che NON si potranno ricreare, in una voce propria invece che
    // sepolti in fondo all'ordine: sono la conseguenza piu' facile da non
    // vedere di una selezione parziale, e vanno decisi prima di esportare.
    vincoliOmessi: ordine.vincoli.filter((v) => !v.presente),
    esclusi,
    ordine,
  };
  return sigilla(body);
}

module.exports = {
  creaPianoExport,
  verificaImpronta,
  databaseDiSistema,
  MODALITA,
  TIPI,
};

'use strict';

/* ---------------------------------------------------------------------------
 * Le decisioni del diagramma UML, separate dal disegno.
 *
 * Qui non c'è DOM, non c'è JointJS e non c'è socket: c'è l'identità di un
 * oggetto dello schema, come si fondono due pagine di metadati, che cosa è
 * davvero UN collegamento (una FK composta è uno solo, non N), dove finiscono i
 * nodi quando si chiede «Disponi», che cosa significa annullare un gesto e che
 * cosa si accetta da un file importato.
 *
 * Sta a parte per la ragione di `geo-modifica.js` e `grafo-comandi.js`: queste
 * regole, sbagliate, producono un diagramma che SEMBRA giusto. Due FK composte
 * disegnate come quattro frecce, o due tabelle omonime di schemi diversi fuse
 * in un nodo solo, non danno alcun errore — danno un modello falso. Provate da
 * `test/unit-uml-modello.js`, senza browser.
 *
 * Tre scelte che non sono ovvie:
 *
 * 1. L'IDENTITÀ È UNA TUPLA CODIFICATA, non una concatenazione con punti. Uno
 *    schema può chiamarsi `a.b` e una tabella `c`, e `a.b.c` sarebbe allora
 *    indistinguibile da schema `a` + tabella `b.c`. Il JSON di un array non ha
 *    quell'ambiguità e resta una chiave di Map.
 *
 * 2. L'ANNULLAMENTO LAVORA SU ISTANTANEE, non su comandi invertibili. Un
 *    comando invertibile per ciascuno dei quindici gesti è quindici occasioni
 *    di scrivere l'inverso sbagliato; il documento è piccolo (posizioni, note,
 *    entità di progetto: nessuna riga di database ci entra mai) e copiarlo
 *    costa meno di quanto costi mantenere quella simmetria.
 *
 * 3. CIÒ CHE SI IMPORTA È RICOSTRUITO CAMPO PER CAMPO, mai adottato. Un JSON
 *    esterno che diventa il documento è un JSON esterno che decide che cosa il
 *    programma disegna: `validaDocumento` copia solo i campi ammessi, forza i
 *    tipi, taglia le stringhe e rifiuta le coordinate non finite.
 * ------------------------------------------------------------------------- */

/** Origini di un collegamento, in ordine di affidabilità dichiarata. */
export const VINCOLO = 'vincolo';
export const RILEVATA = 'rilevata';
export const LOGICA = 'logica';

export const MAX_TESTO_NOTA = 2000;
export const MAX_ELEMENTI_IMPORT = 5000;
const MAX_COORD = 200000;

/* ------------------------------- Identità -------------------------------- */

/**
 * Chiave stabile di un oggetto dello schema. `conn` distingue due database
 * omonimi su due connessioni, `db` due tabelle omonime in due schemi.
 */
export function chiaveOggetto({ conn = '', db = '', tipo = 'tabella', nome = '' }) {
  return JSON.stringify([String(conn), String(db), String(tipo), String(nome)]);
}

/** Inverso di `chiaveOggetto`, o `null` se la chiave non è una delle nostre. */
export function leggiChiave(chiave) {
  try {
    const t = JSON.parse(chiave);
    if (!Array.isArray(t) || t.length !== 4 || t.some((p) => typeof p !== 'string')) return null;
    return { conn: t[0], db: t[1], tipo: t[2], nome: t[3] };
  } catch { return null; }
}

/* ------------------------------ Schema letto ------------------------------ */

/**
 * Fonde una pagina di schema in quella già caricata.
 *
 * I CAMPI SI UNISCONO PER NOME, non «si tiene l'elenco più lungo». Con i
 * cursori indipendenti una pagina successiva porta le colonne 200-399 di una
 * tabella: sono TRE le cose che quella pagina non deve poter fare — sostituire
 * le prime 200 (che sparirebbero), essere scartata perché più corta (e le nuove
 * non arriverebbero mai), o essere accodata alla cieca (e un rinvio ripetuto
 * duplicherebbe le colonne). Unire per nome le esclude tutte e tre, e conserva
 * l'ordine: la prima comparsa decide il posto, l'ultima lettura il contenuto.
 *
 * La `fieldsPage` che sopravvive è quella che dichiara di essere arrivata PIÙ
 * AVANTI: una pagina che si ferma prima non deve poter dire che il resto manca
 * ancora, e una che dichiara `complete` non deve essere declassata da una
 * ripetizione della prima pagina.
 */
export function unisciSchema(base, pagina) {
  const collections = new Map();
  for (const c of (base && base.collections) || []) collections.set(c.name, c);
  for (const c of pagina.collections || []) {
    const vecchia = collections.get(c.name);
    collections.set(c.name, {
      ...vecchia,
      ...c,
      fields: unisciCampi((vecchia && vecchia.fields) || [], c.fields || []),
      fieldsPage: paginaCampiPiuAvanti(vecchia && vecchia.fieldsPage, c.fieldsPage),
    });
  }
  const relations = new Map();
  for (const r of (base && base.relations) || []) relations.set(chiaveRelazione(r), r);
  for (const r of pagina.relations || []) relations.set(chiaveRelazione(r), r);
  const uniteCollezioni = [...collections.values()];
  const uniteRelazioni = [...relations.values()];
  const sp = unisciPagine(base && base.schemaPage, pagina.schemaPage, uniteCollezioni, uniteRelazioni);
  return {
    ...pagina,
    collections: uniteCollezioni,
    relations: uniteRelazioni,
    ...(sp ? { schemaPage: sp } : {}),
  };
}

/**
 * Fonde lo stato di paginazione: la pagina fusa dichiara ciò che manca
 * ANCORA, non ciò che mancava nell'ultima risposta.
 *
 * Senza questa fusione, finita la prima fetta di catalogo la risposta diceva
 * «completo» mentre le colonne oltre il tetto di una tabella della fetta
 * precedente non erano mai state chieste: il chiamante si fermava e quelle
 * colonne restavano irraggiungibili in silenzio. I cursori dei campi si
 * uniscono (l'ultima lettura vince per tabella), il catalogo e le relazioni
 * seguono l'ultima pagina — i loro cursori sono globali — e la completezza si
 * ricalcola sul totale fuso.
 */
export function unisciPagine(vecchia, nuova, collections, relations) {
  if (!vecchia) return nuova || null;
  if (!nuova) return vecchia;
  const campi = { ...((vecchia.cursori && vecchia.cursori.campi) || {}) };
  for (const c of collections || []) {
    if (c.fieldsPage && c.fieldsPage.nextCursor != null) campi[c.name] = c.fieldsPage.nextCursor;
    else delete campi[c.name];
  }
  const fineCollezioni = nuova.fine ? !!nuova.fine.collezioni : nuova.nextCursor == null;
  const fineRelazioni = nuova.fine
    ? !!nuova.fine.relazioni
    : !(nuova.cursori && nuova.cursori.relazioni != null);
  const fineCampi = Object.keys(campi).length === 0;
  const totals = nuova.totals || vecchia.totals;
  const campiLetti = (collections || []).reduce((s, c) => s + ((c.fields || []).length), 0);
  return {
    ...nuova,
    complete: fineCollezioni && fineRelazioni && fineCampi,
    cursori: {
      collezioni: nuova.cursori ? nuova.cursori.collezioni : null,
      relazioni: nuova.cursori ? nuova.cursori.relazioni : null,
      campi,
    },
    fine: { collezioni: fineCollezioni, relazioni: fineRelazioni, campi: fineCampi },
    omitted: totals ? {
      collections: Math.max(0, totals.collections - (collections || []).length),
      fields: Math.max(0, totals.fields - campiLetti),
      relations: Math.max(0, totals.relations - (relations || []).length),
    } : nuova.omitted,
  };
}

function unisciCampi(vecchi, nuovi) {
  if (!nuovi.length) return vecchi;
  const per = new Map();
  for (const f of vecchi) if (f && f.name) per.set(f.name, f);
  for (const f of nuovi) if (f && f.name) per.set(f.name, { ...per.get(f.name), ...f });
  return [...per.values()];
}

function paginaCampiPiuAvanti(vecchia, nuova) {
  if (!vecchia) return nuova;
  if (!nuova) return vecchia;
  // «Più avanti» = dichiara di aver letto di più: completa batte tutto, e fra
  // due parziali vince quella la cui continuazione parte da più lontano.
  const quanto = (p) => (p.complete ? Number.MAX_SAFE_INTEGER : Number(p.nextCursor || p.cursor || 0));
  return quanto(nuova) >= quanto(vecchia) ? nuova : vecchia;
}

function chiaveRelazione(r) {
  return JSON.stringify([r.from, r.field, r.to, r.toDb || '', r.constraint || '']);
}

/**
 * Raggruppa le relazioni grezze in COLLEGAMENTI. Una FK composta arriva come
 * una riga per colonna e qui torna a essere un collegamento solo, con tutte le
 * coppie ordinate: disegnarne quattro fra gli stessi due nodi direbbe che ci
 * sono quattro chiavi esterne, che è un'altra cosa.
 *
 * Due FK distinte fra gli stessi due nodi restano invece due collegamenti,
 * perché hanno due vincoli diversi; le relazioni solo ipotizzate non hanno
 * vincolo e si raggruppano per campo, cioè restano una ciascuna.
 */
export function collegamenti(schema, { conn = '', db = '' } = {}) {
  const perGruppo = new Map();
  for (const r of (schema && schema.relations) || []) {
    if (!r || !r.from || !r.to) continue;
    const origine = r.origine === 'vincolo' ? VINCOLO : RILEVATA;
    const gruppo = origine === VINCOLO && r.constraint
      ? JSON.stringify(['v', r.from, r.constraint])
      : JSON.stringify(['e', r.from, r.field, r.to]);
    let link = perGruppo.get(gruppo);
    if (!link) {
      link = {
        id: gruppo,
        origine,
        nome: r.constraint || null,
        da: chiaveOggetto({ conn, db, nome: r.from }),
        a: chiaveOggetto({ conn, db: r.toDb || db, nome: r.to }),
        daNome: r.from,
        aNome: r.to,
        aDb: r.toDb || db,
        esterna: !!r.external,
        auto: r.from === r.to && (!r.toDb || r.toDb === db),
        molti: !!r.many,
        coppie: [],
      };
      perGruppo.set(gruppo, link);
    }
    link.coppie.push({
      campo: r.field,
      colonna: r.toField || null,
      ordine: Number(r.ordine) || link.coppie.length + 1,
    });
  }
  for (const link of perGruppo.values()) {
    link.coppie.sort((a, b) => a.ordine - b.ordine);
    link.composta = link.coppie.length > 1;
    link.etichetta = link.coppie.map((p) => p.campo).join(', ') + (link.molti ? ' [N]' : '');
  }
  return [...perGruppo.values()];
}

/* ------------------------------ Disposizione ------------------------------ */

/**
 * Disposizione a livelli: le radici (nessun collegamento entrante) nella prima
 * colonna, i riferiti in quelle successive. Non è dagre — non incrocia meno
 * linee di quanto farebbe lui — ma è un ordine LEGGIBILE senza una dipendenza
 * in più, e il caso che conta è «ho appena aperto il diagramma e non voglio
 * venti nodi impilati sullo stesso punto».
 *
 * I nodi bloccati non si spostano e non liberano il loro posto: chi li ha
 * bloccati li ha messi dove voleva.
 */
export function disposizione(chiavi, links, opzioni = {}) {
  const {
    bloccati = new Set(), altezze = new Map(),
    passoX = 320, passoY = 48, perColonna = 5,
  } = opzioni;
  const presenti = new Set(chiavi);
  const uscenti = new Map(chiavi.map((k) => [k, []]));
  const gradoEntrata = new Map(chiavi.map((k) => [k, 0]));
  for (const l of links) {
    if (!presenti.has(l.da) || !presenti.has(l.a) || l.da === l.a) continue;
    uscenti.get(l.da).push(l.a);
    gradoEntrata.set(l.a, gradoEntrata.get(l.a) + 1);
  }
  // Livello = distanza dalla radice. La visita si ferma da sé sui cicli: un
  // livello non può superare il numero di nodi.
  const livello = new Map();
  const coda = chiavi.filter((k) => gradoEntrata.get(k) === 0);
  for (const k of coda) livello.set(k, 0);
  for (let i = 0; i < coda.length; i++) {
    const k = coda[i];
    const prossimo = livello.get(k) + 1;
    if (prossimo >= chiavi.length) continue;
    for (const succ of uscenti.get(k)) {
      if (!livello.has(succ) || livello.get(succ) < prossimo) {
        livello.set(succ, prossimo);
        coda.push(succ);
      }
    }
  }
  // I nodi di un ciclo puro non hanno radice: restano al livello zero.
  for (const k of chiavi) if (!livello.has(k)) livello.set(k, 0);

  const perLivello = new Map();
  for (const k of chiavi) {
    if (bloccati.has(k)) continue;
    const lv = livello.get(k);
    if (!perLivello.has(lv)) perLivello.set(lv, []);
    perLivello.get(lv).push(k);
  }
  const posizioni = new Map();
  let colonna = 0;
  for (const lv of [...perLivello.keys()].sort((a, b) => a - b)) {
    const gruppo = perLivello.get(lv).slice().sort();
    for (let i = 0; i < gruppo.length; i += perColonna) {
      let y = 40;
      for (const k of gruppo.slice(i, i + perColonna)) {
        posizioni.set(k, { x: 40 + colonna * passoX, y });
        y += (altezze.get(k) || 160) + passoY;
      }
      colonna++;
    }
  }
  return posizioni;
}

/* --------------------------- Allinea e distribuisci ----------------------- */

/** I sei allineamenti possibili, con l'etichetta che l'interfaccia mostra. */
export const ALLINEAMENTI = Object.freeze({
  sinistra: 'Allinea a sinistra',
  centroX: 'Centra in orizzontale',
  destra: 'Allinea a destra',
  alto: 'Allinea in alto',
  centroY: 'Centra in verticale',
  basso: 'Allinea in basso',
});

/**
 * Nuove posizioni per allineare un gruppo di riquadri.
 *
 * Allineare «a sinistra» non è portarli tutti alla x più piccola per caso: è
 * portarli al BORDO del gruppo, e il bordo va calcolato sui riquadri che si
 * possono muovere. Includere anche i bloccati nel calcolo del bordo è la
 * scelta giusta — sono lì apposta, e allinearsi a loro è quasi sempre ciò che
 * si vuole — ma spostarli no.
 *
 * `riquadri` = `[{ chiave, x, y, w, h, bloccato }]`. Restituisce una Map con le
 * sole posizioni CAMBIATE: chi non si muove non deve comparire in una voce di
 * storia come se si fosse mosso.
 */
export function allinea(riquadri, modo) {
  if (!ALLINEAMENTI[modo] || riquadri.length < 2) return new Map();
  const bordo = {
    sinistra: Math.min(...riquadri.map((r) => r.x)),
    destra: Math.max(...riquadri.map((r) => r.x + r.w)),
    alto: Math.min(...riquadri.map((r) => r.y)),
    basso: Math.max(...riquadri.map((r) => r.y + r.h)),
  };
  const centroX = (bordo.sinistra + bordo.destra) / 2;
  const centroY = (bordo.alto + bordo.basso) / 2;
  const out = new Map();
  for (const r of riquadri) {
    if (r.bloccato) continue;
    let { x, y } = r;
    if (modo === 'sinistra') x = bordo.sinistra;
    else if (modo === 'destra') x = bordo.destra - r.w;
    else if (modo === 'centroX') x = Math.round(centroX - r.w / 2);
    else if (modo === 'alto') y = bordo.alto;
    else if (modo === 'basso') y = bordo.basso - r.h;
    else if (modo === 'centroY') y = Math.round(centroY - r.h / 2);
    if (x !== r.x || y !== r.y) out.set(r.chiave, { x: Math.round(x), y: Math.round(y) });
  }
  return out;
}

/**
 * Spazi UGUALI fra i riquadri, lungo un asse.
 *
 * Non è «stessa distanza fra i centri»: con riquadri di larghezza diversa quella
 * lascia spazi visibilmente diversi, che è proprio la cosa che si stava
 * cercando di togliere. Si distribuisce lo spazio LIBERO, cioè la distanza fra
 * i bordi. I due estremi non si muovono: sono loro a definire l'area.
 */
export function distribuisci(riquadri, asse = 'x') {
  if (riquadri.length < 3) return new Map();
  const lato = asse === 'x' ? 'w' : 'h';
  const ordinati = riquadri.slice().sort((a, b) => a[asse] - b[asse]);
  const primo = ordinati[0];
  const ultimo = ordinati[ordinati.length - 1];
  const estensione = (ultimo[asse] + ultimo[lato]) - primo[asse];
  const occupato = ordinati.reduce((somma, r) => somma + r[lato], 0);
  const spazio = (estensione - occupato) / (ordinati.length - 1);
  const out = new Map();
  let cursore = primo[asse] + primo[lato] + spazio;
  for (const r of ordinati.slice(1, -1)) {
    const valore = Math.round(cursore);
    if (!r.bloccato && valore !== r[asse]) {
      out.set(r.chiave, asse === 'x' ? { x: valore, y: r.y } : { x: r.x, y: valore });
    }
    cursore = (r.bloccato ? r[asse] : valore) + r[lato] + spazio;
  }
  return out;
}

/* -------------------------------- Gruppi ---------------------------------- */

/**
 * Riscrive i collegamenti quando un gruppo è COMPRESSO.
 *
 * Un gruppo compresso nasconde i propri membri, e un collegamento che punta a
 * un nodo non disegnato è un collegamento che sparisce: comprimere farebbe
 * allora perdere di vista proprio le relazioni che dicono a che cosa serve quel
 * gruppo. I capi che cadono dentro un gruppo compresso si spostano quindi SUL
 * gruppo, e i collegamenti che finiscono con entrambi i capi lì dentro
 * scompaiono davvero — sono interni, e non attraversano più nulla di visibile.
 *
 * Due collegamenti diversi che dopo la riscrittura collegano la stessa coppia
 * restano DUE: fonderli direbbe che c'è una relazione sola dove ce ne sono due.
 */
export function collegamentiCompressi(links, dentroGruppo) {
  const out = [];
  for (const link of links) {
    const da = dentroGruppo.get(link.da) || link.da;
    const a = dentroGruppo.get(link.a) || link.a;
    if (da === a && (dentroGruppo.has(link.da) || dentroGruppo.has(link.a))) continue;
    out.push(da === link.da && a === link.a ? link : { ...link, da, a, auto: da === a });
  }
  return out;
}

/* ---------------------------- Gruppi annidati ---------------------------- */

/**
 * Un gruppo può contenere un altro gruppo, ma ogni figlio ha UN padre solo e
 * i cicli sono vietati: senza queste due regole la compressione non saprebbe a
 * quale segnaposto riscrivere gli archi e il segnaposto non saprebbe dove stare.
 *
 * `normalizzaGruppi` impone entrambe le regole su un elenco già costruito
 * (è la via dell'import, dove il file può dire qualunque cosa) e racconta in
 * `avvisi` ciò che ha tolto. L'interfaccia non può creare cicli — raggruppare
 * crea sempre una radice nuova — quindi qui non serve altro.
 */
export function normalizzaGruppi(gruppi) {
  const avvisi = [];
  const perId = new Map();
  for (const g of gruppi) perId.set(g.id, { ...g, membri: [...g.membri] });
  for (const g of perId.values()) {
    if (g.membri.includes(g.id)) {
      g.membri = g.membri.filter((m) => m !== g.id);
      avvisi.push(`Il gruppo «${g.nome}» conteneva sé stesso: tolto.`);
    }
  }
  // Un figlio, un padre — foglie e gruppi: vince l'ULTIMO gruppo dell'elenco,
  // come già faceva la riscrittura degli archi prima dei gruppi annidati.
  const padre = new Map();
  const nomeDi = (id) => (perId.has(id) ? `«${perId.get(id).nome}»` : id);
  for (const g of perId.values()) {
    for (const m of [...g.membri]) {
      if (padre.has(m) && padre.get(m) !== g.id) {
        const prima = perId.get(padre.get(m));
        prima.membri = prima.membri.filter((x) => x !== m);
        avvisi.push(`${nomeDi(m)} stava in due gruppi: resta in «${g.nome}».`);
      }
      padre.set(m, g.id);
    }
  }
  // Cicli: seguendo i padri da un gruppo si deve sempre uscire. Quando il
  // cammino si chiude, l'arco che lo chiude va tolto — ed è quello appena
  // percorso, non uno a caso del ciclo.
  for (const g of perId.values()) {
    for (;;) {
      const visti = new Set();
      let nodo = g.id;
      let prec = null;
      while (nodo && perId.has(nodo) && !visti.has(nodo)) {
        visti.add(nodo);
        prec = nodo;
        nodo = padre.get(nodo);
      }
      if (!nodo || !visti.has(nodo)) break;
      const chiude = perId.get(nodo);
      chiude.membri = chiude.membri.filter((m) => m !== prec);
      padre.delete(prec);
      avvisi.push(`Appartenenza ciclica fra «${perId.get(prec).nome}» e «${chiude.nome}»: tolta.`);
    }
  }
  return { gruppi: [...perId.values()], avvisi };
}

/**
 * Dove si nasconde ogni elemento: il segnaposto che lo copre è il gruppo
 * compresso PIÙ ESTERNO che lo contiene. Con un solo livello è la mappa di
 * prima; con l'annidamento un arco verso un membro di un gruppo compresso
 * dentro un gruppo compresso punta al segnaposto esterno, che è l'unico
 * disegnato.
 *
 * Restituisce solo gli elementi nascosti (mappa id → id del segnaposto): chi
 * non c'è è visibile. I cicli residui — un documento costruito a mano che
 * salta la normalizzazione — fermano il cammino invece di girarlo per sempre.
 */
export function nascondiglioGruppi(gruppi) {
  const perId = new Map(gruppi.map((g) => [g.id, g]));
  const padre = new Map();
  for (const g of gruppi) for (const m of g.membri) padre.set(m, g.id);
  const memo = new Map();
  const risolvi = (id) => {
    if (memo.has(id)) return memo.get(id);
    const visti = new Set();
    let corsa = id;
    let esterno = null;
    while (corsa && !visti.has(corsa)) {
      visti.add(corsa);
      const p = padre.get(corsa);
      if (!p) break;
      if (perId.get(p) && perId.get(p).compresso) esterno = p;
      corsa = p;
    }
    memo.set(id, esterno);
    return esterno;
  };
  const dentro = new Map();
  for (const g of gruppi) {
    const n = risolvi(g.id);
    if (n) dentro.set(g.id, n);
    for (const m of g.membri) {
      const r = risolvi(m);
      if (r) dentro.set(m, r);
    }
  }
  return dentro;
}

/** Profondità di ogni gruppo (0 = radice): le cornici esterne si disegnano sotto. */
export function profonditaGruppi(gruppi) {
  const perId = new Map(gruppi.map((g) => [g.id, g]));
  const padre = new Map();
  for (const g of gruppi) for (const m of g.membri) if (perId.has(m)) padre.set(m, g.id);
  const memo = new Map();
  const altezza = (id) => {
    if (memo.has(id)) return memo.get(id);
    const visti = new Set();
    let corsa = id;
    let n = 0;
    while (padre.has(corsa) && !visti.has(corsa)) {
      visti.add(corsa);
      corsa = padre.get(corsa);
      n++;
    }
    memo.set(id, n);
    return n;
  };
  return new Map(gruppi.map((g) => [g.id, altezza(g.id)]));
}

/**
 * Foglie di un gruppo: nodi, entità e note contenute a qualunque profondità,
 * senza duplicati e senza cicli. Gli id ignoti (un membro rimosso altrove) non
 * sono foglie: contarli gonfierebbe il segnaposto di elementi che non esistono.
 */
export function foglieGruppo(doc, gruppo) {
  const perId = new Map(((doc && doc.gruppi) || []).map((g) => [g.id, g]));
  const presente = (id) => !!((doc && doc.nodi && doc.nodi[id])
    || ((doc && doc.entita) || []).some((e) => e && e.id === id)
    || ((doc && doc.note) || []).some((n) => n && n.id === id));
  const out = [];
  const visti = new Set();
  const visita = (id) => {
    if (visti.has(id)) return;
    visti.add(id);
    const g = perId.get(id);
    if (!g) {
      if (presente(id)) out.push(id);
      return;
    }
    for (const m of g.membri) visita(m);
  };
  for (const m of gruppo.membri) visita(m);
  return out;
}

/** Dove sta il segnaposto: sopra le foglie del gruppo, a qualunque profondità. */
export function posizioneSegnaposto(doc, gruppo) {
  let x = Infinity;
  let y = Infinity;
  for (const m of foglieGruppo(doc, gruppo)) {
    const nodo = (doc.nodi && doc.nodi[m])
      || (doc.entita || []).find((e) => e.id === m)
      || (doc.note || []).find((n) => n.id === m);
    if (!nodo) continue;
    x = Math.min(x, Number(nodo.x) || 0);
    y = Math.min(y, Number(nodo.y) || 0);
  }
  if (x === Infinity) return { x: 40, y: 40 };
  return { x: x - 24, y: y - 24 };
}

/* ------------------------------- Documento -------------------------------- */

/**
 * Due documenti hanno la STESSA STRUTTURA quando differiscono solo per le
 * posizioni: stesse chiavi, stessi flag di forma (bloccato/compresso cambiano
 * la misura), stessi testi, stesse relazioni e stessi gruppi. Serve a
 * «Annulla»: un trascinamento annullato riposiziona le celle esistenti invece
 * di ricostruire l'intero grafo, che su cento nodi costerebbe secondi.
 */
export function stessaStruttura(a, b) {
  const scheletro = (doc) => {
    const senzaPosizione = (n) => {
      const { x, y, ...resto } = n || {};
      return resto;
    };
    const perChiave = (obj) => Object.fromEntries(
      Object.entries((obj) || {}).sort(([k1], [k2]) => (k1 < k2 ? -1 : 1))
        .map(([k, n]) => [k, senzaPosizione(n)]));
    const perId = (lista) => (lista || [])
      .map((e) => senzaPosizione(e))
      .sort((e1, e2) => (String(e1.id) < String(e2.id) ? -1 : 1));
    return {
      nodi: perChiave(doc && doc.nodi),
      entita: perId(doc && doc.entita),
      note: perId(doc && doc.note),
      logiche: perId(doc && doc.logiche),
      gruppi: perId(doc && doc.gruppi),
      instradamenti: doc && doc.instradamenti ? doc.instradamenti : {},
    };
  };
  return JSON.stringify(scheletro(a)) === JSON.stringify(scheletro(b));
}

export function documentoVuoto(nome = 'Diagramma') {  return { versione: 1, nome, nodi: {}, note: [], entita: [], logiche: [], gruppi: [], instradamenti: {} };
}

/**
 * Storia del documento. Un gesto = una voce, e la voce si registra PRIMA della
 * modifica: `segna()` all'inizio del gesto, non alla fine, così un
 * trascinamento multiplo torna indietro in una volta sola.
 */
export class Cronologia {
  constructor(massimo = 100) {
    this.massimo = massimo;
    this.indietro = [];
    this.avanti = [];
  }

  segna(doc) {
    this.indietro.push(clona(doc));
    if (this.indietro.length > this.massimo) this.indietro.shift();
    this.avanti.length = 0;
  }

  get puoAnnullare() { return this.indietro.length > 0; }

  get puoRipetere() { return this.avanti.length > 0; }

  annulla(docCorrente) {
    if (!this.indietro.length) return null;
    this.avanti.push(clona(docCorrente));
    return this.indietro.pop();
  }

  ripeti(docCorrente) {
    if (!this.avanti.length) return null;
    this.indietro.push(clona(docCorrente));
    return this.avanti.pop();
  }

  azzera() { this.indietro.length = 0; this.avanti.length = 0; }
}

export function clona(v) {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

/* -------------------------------- Import ---------------------------------- */

const testo = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const numero = (v, fallback = 0) => (Number.isFinite(Number(v))
  ? Math.max(-MAX_COORD, Math.min(MAX_COORD, Number(v)))
  : fallback);
const booleano = (v) => v === true;

let contatore = 0;
export function nuovoId(prefisso) {
  contatore += 1;
  return `${prefisso}-${Date.now().toString(36)}-${contatore.toString(36)}`;
}

/**
 * Ricostruisce un documento da un JSON esterno. Non adotta l'oggetto ricevuto:
 * ne copia i soli campi ammessi, con il tipo forzato. Restituisce sempre un
 * documento valido più l'elenco di ciò che è stato scartato, perché
 * «importato» su un file mezzo rifiutato è la falsa riuscita da evitare.
 */
export function validaDocumento(grezzo) {
  const avvisi = [];
  const doc = documentoVuoto();
  if (!grezzo || typeof grezzo !== 'object' || Array.isArray(grezzo)) {
    return { doc, avvisi: ['Il file non contiene un documento di diagramma.'] };
  }
  if (Number(grezzo.versione) !== 1) {
    avvisi.push(`Versione ${testo(String(grezzo.versione), 20)} non riconosciuta: letta come versione 1.`);
  }
  doc.nome = testo(grezzo.nome, 120) || 'Diagramma';

  let contati = 0;
  let troncato = false;
  const entro = () => {
    contati += 1;
    if (contati <= MAX_ELEMENTI_IMPORT) return true;
    troncato = true;
    return false;
  };

  const nodiGrezzi = grezzo.nodi && typeof grezzo.nodi === 'object' && !Array.isArray(grezzo.nodi) ? grezzo.nodi : {};
  for (const [chiave, nodo] of Object.entries(nodiGrezzi)) {
    if (!entro()) break;
    if (!leggiChiave(chiave)) { avvisi.push('Nodo con identità non valida: ignorato.'); continue; }
    if (!nodo || typeof nodo !== 'object') continue;
    doc.nodi[chiave] = {
      x: numero(nodo.x),
      y: numero(nodo.y),
      bloccato: booleano(nodo.bloccato),
      compresso: booleano(nodo.compresso),
    };
  }
  for (const nota of Array.isArray(grezzo.note) ? grezzo.note : []) {
    if (!entro()) break;
    if (!nota || typeof nota !== 'object') continue;
    doc.note.push({
      id: testo(nota.id, 64) || nuovoId('nota'),
      x: numero(nota.x),
      y: numero(nota.y),
      w: Math.max(80, numero(nota.w, 220)),
      h: Math.max(40, numero(nota.h, 110)),
      testo: testo(nota.testo, MAX_TESTO_NOTA),
    });
  }
  for (const ent of Array.isArray(grezzo.entita) ? grezzo.entita : []) {
    if (!entro()) break;
    if (!ent || typeof ent !== 'object') continue;
    doc.entita.push({
      id: testo(ent.id, 64) || nuovoId('ent'),
      nome: testo(ent.nome, 120) || 'entità',
      x: numero(ent.x),
      y: numero(ent.y),
      bloccato: booleano(ent.bloccato),
      campi: (Array.isArray(ent.campi) ? ent.campi : []).slice(0, 200).map((c) => ({
        nome: testo(c && c.nome, 120),
        tipo: testo(c && c.tipo, 60),
      })).filter((c) => c.nome),
    });
  }
  // I gruppi si leggono in DUE passate: un gruppo può contenere un gruppo
  // definito DOPO di lui nel file, e filtrare i membri prima di conoscere
  // tutti gli id butterebbe l'appartenenza. Dopo il filtro, la normalizzazione
  // toglie sé stessi, doppi padri e cicli — un file può dire qualunque cosa.
  const gruppiGrezzi = Array.isArray(grezzo.gruppi) ? grezzo.gruppi : [];
  const idGruppi = new Set(gruppiGrezzi
    .filter((g) => g && typeof g === 'object')
    .map((g) => testo(g.id, 64))
    .filter(Boolean));
  for (const gruppo of gruppiGrezzi) {
    if (!entro()) break;
    if (!gruppo || typeof gruppo !== 'object') continue;
    const membri = (Array.isArray(gruppo.membri) ? gruppo.membri : [])
      .map((m) => testo(m, 400))
      .filter((m) => m in doc.nodi || doc.entita.some((e) => e.id === m) || idGruppi.has(m));
    if (!membri.length) { avvisi.push('Gruppo senza membri presenti nel file: ignorato.'); continue; }
    doc.gruppi.push({
      id: testo(gruppo.id, 64) || nuovoId('grp'),
      nome: testo(gruppo.nome, 120) || 'Gruppo',
      membri,
      compresso: booleano(gruppo.compresso),
      x: numero(gruppo.x),
      y: numero(gruppo.y),
    });
  }
  {
    const { gruppi, avvisi: avvisiGruppi } = normalizzaGruppi(doc.gruppi);
    doc.gruppi = gruppi;
    avvisi.push(...avvisiGruppi);
  }
  const identita = new Set([...Object.keys(doc.nodi), ...doc.entita.map((e) => e.id), ...doc.gruppi.map((g) => g.id)]);
  for (const log of Array.isArray(grezzo.logiche) ? grezzo.logiche : []) {
    if (!entro()) break;
    if (!log || typeof log !== 'object') continue;
    const da = testo(log.da, 400);
    const a = testo(log.a, 400);
    if (!identita.has(da) || !identita.has(a)) {
      avvisi.push('Relazione logica verso un elemento assente dal file: ignorata.');
      continue;
    }
    doc.logiche.push({
      id: testo(log.id, 64) || nuovoId('log'),
      da,
      a,
      etichetta: testo(log.etichetta, 120),
      cardinalita: ['1-1', '1-N', 'N-N'].includes(log.cardinalita) ? log.cardinalita : '1-N',
      campoDa: testo(log.campoDa, 120),
      campoA: testo(log.campoA, 120),
    });
  }
  // Vertici manuali dei collegamenti: coppie di coordinate finite, entro il
  // limite. Un file che dichiara vertici per un arco che non c'è non rompe
  // nulla — alla prima apertura restano semplicemente inutilizzati — ma un
  // array che non è fatto di punti viene scartato e dichiarato.
  const instrGrezzi = grezzo.instradamenti && typeof grezzo.instradamenti === 'object' && !Array.isArray(grezzo.instradamenti)
    ? grezzo.instradamenti : {};
  for (const [id, punti] of Object.entries(instrGrezzi)) {
    if (!entro()) break;
    const chiave = testo(id, 400);
    // La CHIAVE va validata quanto il valore. Le altre voci del documento
    // hanno un identificatore che il modulo sa riconoscere (`leggiChiave` per
    // i nodi); qui la chiave è l'id di un collegamento, che non è
    // ricostruibile, quindi si rifiutano almeno i nomi che non sono chiavi ma
    // leve sul prototipo. `JSON.parse` — la via da cui questo oggetto arriva
    // davvero (`importa()`) — crea `__proto__` come proprietà PROPRIA, quindi
    // scriverla riassegna il prototipo dell'oggetto invece di aggiungere una
    // voce. Non è teorico: misurato, un file con `"__proto__": [due punti]`
    // faceva restituire a `instradamenti["0"]` dei vertici che quel
    // collegamento non ha mai avuto, e senza alcun avviso — cioè un
    // instradamento inventato su un arco a caso, la falsa riuscita che questa
    // funzione esiste per togliere.
    if (chiave === '__proto__' || chiave === 'constructor' || chiave === 'prototype') {
      avvisi.push('Instradamento con un identificatore riservato: ignorato.');
      continue;
    }
    if (!Array.isArray(punti)) { avvisi.push('Instradamento non valido: ignorato.'); continue; }
    const puliti = punti.slice(0, 50)
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({ x: numero(p.x), y: numero(p.y) }));
    if (puliti.length) doc.instradamenti[chiave] = puliti;
    else avvisi.push('Instradamento senza punti validi: ignorato.');
  }
  if (troncato) avvisi.push(`Oltre ${MAX_ELEMENTI_IMPORT} elementi: il resto del file è stato ignorato.`);
  return { doc, avvisi };
}

/**
 * Riconcilia il documento con lo schema appena riletto. Un oggetto sparito dal
 * database NON viene cancellato dal diagramma: diventa un riferimento non
 * risolto, perché cancellarlo perderebbe in silenzio la disposizione di un
 * lavoro che magari va solo ricollegato.
 */
export function riconcilia(doc, chiaviPresenti) {
  const presenti = new Set(chiaviPresenti);
  const irrisolti = Object.keys(doc.nodi).filter((k) => !presenti.has(k));
  const nuovi = [...presenti].filter((k) => !(k in doc.nodi));
  return { irrisolti, nuovi };
}

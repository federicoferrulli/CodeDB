'use strict';

/* ---------------------------------------------------------------------------
 * Geometria della Split-View: dove stanno i pannelli e quanto sono grandi.
 *
 * Modulo FOGLIA — nessun import, nessun DOM — per la stessa ragione di
 * `cell-stats.js` e `theme-colori.js`: sbagliata, questa matematica non lancia
 * errori e non produce una schermata rotta, produce proporzioni plausibili e
 * storte, oppure un pannello che sparisce dall'albero pur restando vivo nella
 * mappa delle sessioni. Sta a parte perché così si prova in Node
 * (`test/unit-split-layout.js`) invece che a occhio.
 *
 * Forma dei nodi:
 *   { type: 'pane', paneId: 'pane_3' }
 *   { type: 'row'|'col', children: [...], sizes: [0.6, 0.4] }   // somma 1
 *
 * Le quote vivono NELL'ALBERO e non in stili inline: il DOM della Split-View
 * viene rimontato a ogni aggiunta o chiusura di pannello, quindi qualunque
 * dimensione scritta sull'elemento sarebbe azzerata dal primo re-render — ed è
 * esattamente ciò che accadeva. Vivendo qui, le proporzioni sopravvivono al
 * re-render, alla serializzazione dello snapshot di sessione e al F5.
 *
 * Tutte le funzioni sono IMMUTABILI: restituiscono un albero nuovo e non
 * toccano l'argomento. Lo stesso albero finisce in `getSplitStateSnapshot()`,
 * e una mutazione in posto farebbe divergere in silenzio ciò che si vede da ciò
 * che verrà ripristinato.
 * ------------------------------------------------------------------------- */

/** Larghezza minima di un pannello affiancato (px). Sotto, la toolbar del
 *  pannello non è più leggibile e non resta spazio per una colonna di dati. */
export const MIN_PANE_LARGHEZZA = 220;
/** Altezza minima di un pannello impilato (px): testata + toolbar + una riga. */
export const MIN_PANE_ALTEZZA = 120;

/* ------------------------------ utilità ---------------------------------- */

function isPane(n) {
  return !!n && n.type === 'pane' && typeof n.paneId === 'string' && n.paneId !== '';
}

function isContenitore(n) {
  return !!n && (n.type === 'row' || n.type === 'col') && Array.isArray(n.children);
}

function clona(n) {
  if (isPane(n)) return { type: 'pane', paneId: n.paneId };
  if (isContenitore(n)) {
    return { type: n.type, children: n.children.map(clona), sizes: dimensioniNormalizzate(n) };
  }
  return null;
}

/**
 * Riporta un elenco di quote a somma 1 con `n` elementi. Serve su tre fronti:
 * alberi salvati da versioni che le quote non le avevano, quote residue dopo la
 * rimozione di un figlio, e valori arrivati da `sessionStorage`, che è dato
 * esterno e può contenere qualunque cosa.
 */
export function normalizza(sizes, n) {
  const quanti = Number.isInteger(n) && n > 0 ? n : (Array.isArray(sizes) ? sizes.length : 0);
  if (quanti <= 0) return [];
  const eq = Array.from({ length: quanti }, () => 1 / quanti);
  if (!Array.isArray(sizes) || sizes.length !== quanti) return eq;

  const puliti = sizes.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const somma = puliti.reduce((a, b) => a + b, 0);
  if (!(somma > 0)) return eq;
  return puliti.map((v) => v / somma);
}

/** Quote di un contenitore, generate o riparate se mancanti/incoerenti. */
export function dimensioniNormalizzate(nodo) {
  if (!isContenitore(nodo)) return [];
  return normalizza(nodo.sizes, nodo.children.length);
}

function orientamentoDi(dir) {
  return dir === 'right' || dir === 'left' ? 'row' : 'col';
}

function inseriscePrima(dir) {
  return dir === 'left' || dir === 'top';
}

/* ------------------------------ lettura ---------------------------------- */

/** Id dei pannelli nell'ordine in cui si vedono (sinistra→destra, alto→basso). */
export function elencoPane(albero) {
  const out = [];
  const visita = (n) => {
    if (isPane(n)) out.push(n.paneId);
    else if (isContenitore(n)) n.children.forEach(visita);
  };
  visita(albero);
  return out;
}

export function contaPane(albero) {
  return elencoPane(albero).length;
}

/**
 * Contenitore che ospita DIRETTAMENTE `paneId`, con l'indice del pannello fra i
 * suoi figli. `null` se il pannello è la radice o non esiste: è il caso in cui
 * non c'è alcun vicino con cui scambiare e nessun orientamento da ruotare.
 */
export function contenitoreDi(albero, paneId) {
  let trovato = null;
  const visita = (n) => {
    if (!isContenitore(n) || trovato) return;
    const i = n.children.findIndex((c) => isPane(c) && c.paneId === paneId);
    if (i >= 0) { trovato = { nodo: n, indice: i }; return; }
    n.children.forEach(visita);
  };
  visita(albero);
  return trovato;
}

/* ----------------------------- costruzione -------------------------------- */

export function creaAlbero(idEsistente, idNuovo, dir) {
  const primo = inseriscePrima(dir) ? idNuovo : idEsistente;
  const secondo = inseriscePrima(dir) ? idEsistente : idNuovo;
  return {
    type: orientamentoDi(dir),
    children: [{ type: 'pane', paneId: primo }, { type: 'pane', paneId: secondo }],
    sizes: [0.5, 0.5],
  };
}

/**
 * Aggiunge `idNuovo` accanto a `idBersaglio` nella direzione `dir`.
 *
 * Quando il contenitore del bersaglio ha GIÀ l'orientamento richiesto si
 * aggiunge un fratello invece di annidare un nuovo contenitore: annidando, un
 * albero costruito con quattro trascinamenti a destra diventa profondo quattro
 * livelli, e il separatore più esterno sposta insieme tutti i pannelli che ha
 * dentro — un comportamento che dal disegno sullo schermo non è prevedibile.
 * Lo spazio per il nuovo pannello lo cede il solo bersaglio: gli altri restano
 * dove sono, che è ciò che l'utente si aspetta guardando dove ha rilasciato.
 */
export function inserisci(albero, idBersaglio, idNuovo, dir) {
  if (!albero) return { type: 'pane', paneId: idNuovo };

  if (isPane(albero)) {
    return albero.paneId === idBersaglio
      ? creaAlbero(idBersaglio, idNuovo, dir)
      : clona(albero);
  }
  if (!isContenitore(albero)) return { type: 'pane', paneId: idNuovo };

  const sizes = dimensioniNormalizzate(albero);
  const idx = albero.children.findIndex((c) => isPane(c) && c.paneId === idBersaglio);

  if (idx >= 0 && albero.type === orientamentoDi(dir)) {
    const figli = albero.children.map(clona);
    const s = sizes.slice();
    const meta = s[idx] / 2;
    const pos = inseriscePrima(dir) ? idx : idx + 1;
    s[idx] = meta;
    figli.splice(pos, 0, { type: 'pane', paneId: idNuovo });
    s.splice(pos, 0, meta);
    return { type: albero.type, children: figli, sizes: normalizza(s) };
  }

  return {
    type: albero.type,
    children: albero.children.map((c) => inserisci(c, idBersaglio, idNuovo, dir)),
    sizes,
  };
}

/**
 * Toglie un pannello. La sua quota va ai fratelli superstiti in proporzione a
 * quanto già occupavano (dividerla in parti uguali cambierebbe rapporti che
 * l'utente ha impostato a mano), e un contenitore rimasto con un figlio solo
 * collassa: il figlio prende il suo posto, e quindi anche la sua quota nel
 * nonno. Senza il collasso l'albero accumulerebbe livelli inerti a ogni
 * chiusura, ognuno con un separatore che non separa nulla.
 */
export function rimuovi(albero, paneId) {
  if (isPane(albero)) return albero.paneId === paneId ? null : clona(albero);
  if (!isContenitore(albero)) return null;

  const sizes = dimensioniNormalizzate(albero);
  const figli = [];
  const s = [];
  albero.children.forEach((c, i) => {
    const r = rimuovi(c, paneId);
    if (r) { figli.push(r); s.push(sizes[i]); }
  });

  if (figli.length === 0) return null;
  if (figli.length === 1) return figli[0];
  return { type: albero.type, children: figli, sizes: normalizza(s) };
}

/**
 * Ripara un albero rispetto ai pannelli realmente vivi.
 *
 * È il fix strutturale del ripristino di sessione: lo snapshot arriva da
 * `sessionStorage` e può citare pannelli che non esistono più (o citarne uno due
 * volte). I riferimenti morti vengono potati; un pannello vivo che nell'albero
 * non compare viene invece AGGIUNTO in coda — senza, resterebbe nella mappa
 * delle sessioni senza essere disegnato da nessuna parte, cioè invisibile e
 * impossibile da chiudere.
 */
export function valida(albero, idsVivi) {
  const vivi = idsVivi instanceof Set ? idsVivi : new Set(idsVivi || []);
  const visti = new Set();

  const pota = (n) => {
    if (isPane(n)) {
      if (!vivi.has(n.paneId) || visti.has(n.paneId)) return null;
      visti.add(n.paneId);
      return { type: 'pane', paneId: n.paneId };
    }
    if (!isContenitore(n)) return null;
    const sizes = dimensioniNormalizzate(n);
    const figli = [];
    const s = [];
    n.children.forEach((c, i) => {
      const r = pota(c);
      if (r) { figli.push(r); s.push(sizes[i]); }
    });
    if (figli.length === 0) return null;
    if (figli.length === 1) return figli[0];
    return { type: n.type, children: figli, sizes: normalizza(s) };
  };

  let out = pota(albero);
  const mancanti = [...vivi].filter((id) => !visti.has(id));
  for (const id of mancanti) {
    if (!out) { out = { type: 'pane', paneId: id }; continue; }
    if (isPane(out)) { out = creaAlbero(out.paneId, id, 'right'); continue; }
    const figli = out.children.concat([{ type: 'pane', paneId: id }]);
    const quota = 1 / figli.length;
    const s = dimensioniNormalizzate(out).map((v) => v * (1 - quota)).concat([quota]);
    out = { type: out.type, children: figli, sizes: normalizza(s) };
  }
  return out;
}

/* ---------------------------- manipolazione ------------------------------- */

/**
 * Sposta il confine fra i figli `indice` e `indice+1`.
 *
 * Il delta arriva in pixel (è un trascinamento) ma viene convertito in quota:
 * così il rapporto sopravvive al ridimensionamento della finestra, e non serve
 * ricalcolare nulla quando la Split-View viene rimontata. Lo spazio si sposta
 * solo fra i due vicini del separatore — gli altri non si muovono, altrimenti
 * trascinare un confine farebbe saltare mezza schermata.
 *
 * `minPx` è il minimo per pannello. Quando i due vicini insieme non hanno spazio
 * per due minimi (finestra molto stretta) il minimo si riduce alla metà dello
 * spazio disponibile: meglio due pannelli ugualmente stretti che un clamp che
 * non converge e un separatore che non si muove più.
 */
export function trascina(sizes, indice, deltaPx, pxDisponibili, minPx = 0) {
  const s = normalizza(sizes);
  if (!(indice >= 0 && indice < s.length - 1)) return s;
  if (!(Number.isFinite(pxDisponibili) && pxDisponibili > 0)) return s;
  if (!Number.isFinite(deltaPx)) return s;

  const coppia = s[indice] + s[indice + 1];
  let min = Math.max(0, minPx) / pxDisponibili;
  if (min * 2 > coppia) min = coppia / 2;

  let a = s[indice] + deltaPx / pxDisponibili;
  a = Math.max(min, Math.min(coppia - min, a));

  const out = s.slice();
  out[indice] = a;
  out[indice + 1] = coppia - a;
  return out;
}

/**
 * Quote uguali. Con `paneId` pareggia il solo contenitore che lo ospita (è il
 * doppio clic su un separatore, che deve riguardare quel separatore e non
 * l'intera schermata); senza, pareggia tutto l'albero.
 */
export function pareggia(albero, paneId) {
  if (!isContenitore(albero)) return clona(albero);

  if (paneId != null) {
    const bersaglio = contenitoreDi(albero, paneId);
    if (!bersaglio) return clona(albero);
    const rifai = (n) => {
      if (!isContenitore(n)) return clona(n);
      const figli = n.children.map(rifai);
      const sizes = n === bersaglio.nodo
        ? normalizza(null, figli.length)
        : dimensioniNormalizzate(n);
      return { type: n.type, children: figli, sizes };
    };
    return rifai(albero);
  }

  const tutti = (n) => {
    if (!isContenitore(n)) return clona(n);
    const figli = n.children.map(tutti);
    return { type: n.type, children: figli, sizes: normalizza(null, figli.length) };
  };
  return tutti(albero);
}

/** Scambia di posto due pannelli. Le quote restano al posto, non al pannello:
 *  scambiando due riquadri ci si aspetta che il contenuto si sposti, non che le
 *  proporzioni della schermata cambino. */
export function scambia(albero, idA, idB) {
  if (idA === idB) return clona(albero);
  const scambiaId = (n) => {
    if (isPane(n)) {
      if (n.paneId === idA) return { type: 'pane', paneId: idB };
      if (n.paneId === idB) return { type: 'pane', paneId: idA };
      return { type: 'pane', paneId: n.paneId };
    }
    if (!isContenitore(n)) return null;
    return { type: n.type, children: n.children.map(scambiaId), sizes: dimensioniNormalizzate(n) };
  };
  return scambiaId(albero);
}

/** Riga ↔ colonna sul contenitore che ospita `paneId`: due pannelli affiancati
 *  diventano impilati e viceversa, senza rifare il layout da capo. */
export function ruotaOrientamento(albero, paneId) {
  const bersaglio = contenitoreDi(albero, paneId);
  if (!bersaglio) return clona(albero);
  const rifai = (n) => {
    if (!isContenitore(n)) return clona(n);
    const figli = n.children.map(rifai);
    const tipo = n === bersaglio.nodo ? (n.type === 'row' ? 'col' : 'row') : n.type;
    return { type: tipo, children: figli, sizes: dimensioniNormalizzate(n) };
  };
  return rifai(albero);
}

/**
 * Nodo raggiunto seguendo un percorso di indici dalla radice (`[]` = radice).
 *
 * Serve ai separatori: catturare l'oggetto-nodo alla creazione non funziona,
 * perché ogni operazione qui dentro è immutabile e SOSTITUISCE i nodi — dopo un
 * "pareggia" il separatore continuerebbe a scrivere le quote su un ramo staccato
 * dall'albero vivo, cioè smetterebbe di ridimensionare senza dare segno.
 * Il percorso resta valido finché la struttura non cambia, e quando cambia
 * (aggiunta o chiusura di un pannello) il layout viene comunque rimontato.
 */
export function nodoAlPercorso(albero, percorso) {
  let n = albero;
  for (const i of percorso || []) {
    if (!isContenitore(n)) return null;
    n = n.children[i];
  }
  return n || null;
}

/** Vicino di `paneId` nell'ordine visivo. `null` se non c'è (estremi). */
export function vicinoDi(albero, paneId, verso) {
  const ids = elencoPane(albero);
  const i = ids.indexOf(paneId);
  if (i < 0) return null;
  const j = verso === 'prev' ? i - 1 : i + 1;
  return j >= 0 && j < ids.length ? ids[j] : null;
}

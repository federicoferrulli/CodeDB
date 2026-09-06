/* ---------------------------------------------------------------------------
 * CodeDB — Euristiche di analisi dello schema (relazioni implicite, cammino
 * minimo, dipendenze, PII, salute dello schema).
 *
 * ESISTE PERCHÉ ERANO DUE COPIE. Le stesse cinque funzioni vivevano in
 * `public/js/graph3d.js` (interfaccia) e in `mcp/McpGateway.js` (gateway per i
 * client AI), scritte due volte e senza alcun legame. Tre erano identiche
 * carattere per carattere — compreso un ordinamento topologico sbagliato, che
 * è stato quindi scritto due volte — e la quarta, l'euristica PII, era GIÀ
 * divergente: il gateway riconosceva sei termini che l'interfaccia non aveva.
 * Due risposte diverse alla stessa domanda sullo stesso database, a seconda di
 * dove la si pone, è il difetto peggiore per uno strumento diagnostico: nessuno
 * dei due lati dice di essere incompleto.
 *
 * Il modulo è ESM e **foglia** (nessun import): il browser lo carica come
 * qualunque altro modulo di `public/js/`, e il gateway MCP — che è CommonJS —
 * lo carica con un `import()` dinamico memoizzato. Una copia sola, un solo
 * punto da correggere.
 * ------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
 * Relazioni implicite: `cliente_id` → tabella `cliente` o `clientes`.
 *
 * Il plurale riconosciuto è quello inglese (`+s`): `clienti` NON viene
 * associata a `cliente_id`. È il comportamento storico e non lo si cambia qui
 * per non spostare in silenzio ciò che il grafo disegna e ciò che l'assistente
 * riferisce; è però un limite reale sugli schemi italiani, ed è dichiarato.
 * ------------------------------------------------------------------------ */

export function detectImplicitRelations(collections, existingRelations) {
  const existingSet = new Set((existingRelations || []).map((r) => `${r.from}.${r.field}->${r.to}`));
  const implicit = [];

  for (const c of collections || []) {
    for (const f of c.fields || []) {
      if (f.name === '_id' || f.pk) continue;
      const low = f.name.toLowerCase();
      const match = low.match(/^(.+?)_?ids?$/);
      if (!match) continue;
      const base = match[1];
      const target = (collections || []).find(
        (x) => x.name.toLowerCase() === base || x.name.toLowerCase() === base + 's'
      );
      if (!target || target.name === c.name) continue;
      const key = `${c.name}.${f.name}->${target.name}`;
      if (existingSet.has(key)) continue;
      implicit.push({ from: c.name, field: f.name, to: target.name, many: true, implicit: true });
      existingSet.add(key);
    }
  }
  return implicit;
}

/* --------------------------------------------------------------------------
 * Cammino minimo fra due tabelle (BFS su grafo non orientato).
 * ------------------------------------------------------------------------ */

export function computeShortestPath(schema, startNode, endNode, includeImplicit = true) {
  if (!schema || !schema.collections) return null;
  const adj = new Map();
  for (const c of schema.collections) adj.set(c.name, []);

  const rels = [...(schema.relations || [])];
  if (includeImplicit) rels.push(...detectImplicitRelations(schema.collections, rels));

  for (const r of rels) {
    if (adj.has(r.from)) adj.get(r.from).push({ to: r.to, field: r.field });
    if (adj.has(r.to)) adj.get(r.to).push({ to: r.from, field: r.field });
  }

  if (!adj.has(startNode) || !adj.has(endNode)) return null;

  const queue = [[startNode]];
  const visited = new Set([startNode]);

  while (queue.length > 0) {
    const path = queue.shift();
    const curr = path[path.length - 1];

    if (curr === endNode) {
      const edges = [];
      for (let i = 0; i < path.length - 1; i++) edges.push(`${path[i]}->${path[i + 1]}`);
      return { found: true, from: startNode, to: endNode, distance: path.length - 1, path, edges };
    }

    for (const n of adj.get(curr) || []) {
      if (visited.has(n.to)) continue;
      visited.add(n.to);
      queue.push([...path, n.to]);
    }
  }

  return {
    found: false,
    from: startNode,
    to: endNode,
    message: `Nessun cammino trovato tra ${startNode} e ${endNode}`,
  };
}

/* --------------------------------------------------------------------------
 * Dipendenze e ordine di popolamento.
 *
 * L'ordinamento è un Kahn sull'outDegree: una tabella è popolabile quando tutte
 * quelle da cui dipende (le sue FK uscenti) lo sono già, quindi si parte da chi
 * non ha FK uscenti e si decrementa il contatore dei PREDECESSORI — il che
 * richiede l'adiacenza INVERSA. La versione precedente inizializzava i
 * contatori con l'outDegree ma li decrementava sul bersaglio, cioè su un
 * insieme di archi diverso da quello percorso: il ciclo terminava subito e le
 * tabelle restanti venivano accodate nell'ordine del catalogo. Il risultato era
 * un elenco plausibile in cui `ordini` poteva precedere `clienti`.
 * ------------------------------------------------------------------------ */

export function analyzeDependencies(schema, includeImplicit = false) {
  if (!schema || !schema.collections || !schema.collections.length) {
    return {
      root_tables: [], leaf_tables: [], seeding_order: [], cyclic_tables: [],
      strongly_connected_components: [], blocked_by_cycles: [], external_dependencies: [], total_tables: 0,
    };
  }
  const names = new Set(schema.collections.map((c) => c.name));
  const rels = [...(schema.relations || [])];
  if (includeImplicit) rels.push(...detectImplicitRelations(schema.collections, rels));
  const external = [];
  const internal = [];
  const viste = new Set();
  for (const r of rels) {
    if (!r) continue;
    if (!names.has(r.from) || !names.has(r.to) || r.external === true) {
      external.push(r);
      continue;
    }
    const chiave = `${r.from}>${r.to}`;
    if (viste.has(chiave)) continue;
    viste.add(chiave);
    internal.push(r);
  }
  const outDegree = new Map([...names].map((name) => [name, 0]));
  const inDegree = new Map([...names].map((name) => [name, 0]));
  const dependencies = new Map([...names].map((name) => [name, []]));
  for (const r of internal) {
    outDegree.set(r.from, outDegree.get(r.from) + 1);
    inDegree.set(r.to, inDegree.get(r.to) + 1);
    dependencies.get(r.from).push(r.to);
  }
  const rootTables = schema.collections.filter((c) => (outDegree.get(c.name) || 0) === 0).map((c) => c.name);
  const leafTables = schema.collections.filter((c) => (inDegree.get(c.name) || 0) === 0).map((c) => c.name);

  // Tarjan: soltanto una componente fortemente connessa è un ciclo. Kahn da
  // solo confondeva con il ciclo anche ogni tabella che dipendeva da esso.
  let index = 0;
  const indexes = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = (node) => {
    indexes.set(node, index);
    low.set(node, index++);
    stack.push(node);
    onStack.add(node);
    for (const next of dependencies.get(node)) {
      if (!indexes.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indexes.get(next)));
      }
    }
    if (low.get(node) === indexes.get(node)) {
      const component = [];
      let current;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      components.push(component.sort());
    }
  };
  for (const name of names) if (!indexes.has(name)) visit(name);
  const selfLoops = new Set(internal.filter((r) => r.from === r.to).map((r) => r.from));
  const cyclicComponents = components.filter((component) => component.length > 1 || selfLoops.has(component[0]));
  const cyclic = cyclicComponents.flat();

  // Ordine topologico delle sole tabelle non cicliche; le dipendenze esterne
  // non entrano mai nel grado e quindi non bloccano una tabella osservata.
  const cyclicSet = new Set(cyclic);
  const blocked = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, deps] of dependencies) {
      if (!cyclicSet.has(name) && !blocked.has(name)
          && deps.some((dep) => cyclicSet.has(dep) || blocked.has(dep))) {
        blocked.add(name);
        changed = true;
      }
    }
  }
  const restanti = new Map([...names].filter((name) => !cyclicSet.has(name) && !blocked.has(name)).map((name) => [
    name, dependencies.get(name).filter((dep) => !cyclicSet.has(dep)).length,
  ]));
  const reverse = new Map([...restanti.keys()].map((name) => [name, []]));
  for (const [from, deps] of dependencies) {
    if (!reverse.has(from)) continue;
    for (const dep of deps) if (reverse.has(dep)) reverse.get(dep).push(from);
  }
  const queue = [...restanti].filter(([, degree]) => degree === 0).map(([name]) => name).sort();
  const seedingOrder = [];
  while (queue.length) {
    const node = queue.shift();
    seedingOrder.push(node);
    for (const dependent of reverse.get(node)) {
      restanti.set(dependent, restanti.get(dependent) - 1);
      if (restanti.get(dependent) === 0) queue.push(dependent);
    }
    queue.sort();
  }

  return {
    root_tables: rootTables,
    leaf_tables: leafTables,
    seeding_order: seedingOrder,
    cyclic_tables: cyclic,
    strongly_connected_components: cyclicComponents,
    blocked_by_cycles: [...blocked].sort(),
    external_dependencies: external,
    total_tables: schema.collections.length,
  };
}

/* --------------------------------------------------------------------------
 * PII.
 *
 * I termini si confrontano con i TOKEN del nome, non con le sottostringhe.
 * Con la ricerca di sottostringa quattro termini corti e comunissimi — `ip`,
 * `pass`, `auth`, `tax` — catturavano mezza base dati: `ip` prende `tipo`,
 * `descrizione`, `zip`, `shipping`, `principale`, `script`; `pass` prende
 * `passeggero` e `bypass`; `auth` prende `author` e `authorized_at`. Su uno
 * schema italiano, dove `tipo` e `descrizione` sono fra i nomi di colonna più
 * frequenti in assoluto, quasi ogni tabella risultava contenere dati personali
 * — e da lì nasceva un report GDPR.
 *
 * Ogni corrispondenza porta con sé il TERMINE che l'ha prodotta, così un falso
 * positivo si può valutare invece di doverlo indovinare.
 * ------------------------------------------------------------------------ */

// Termini che valgono come token intero o come prefisso di parola composta.
const PII_TERMINI = [
  'email', 'mail', 'phone', 'telefono', 'telephone', 'cellulare',
  'password', 'passwd', 'pwd', 'secret', 'token', 'apikey',
  'ssn', 'fiscal', 'codicefiscale', 'cf', 'vat', 'piva', 'partitaiva', 'tax',
  'creditcard', 'card', 'iban', 'auth',
  'address', 'indirizzo', 'dob', 'birth', 'nascita',
  'ip', 'ipaddress',
];

// Termini che valgono SOLO come token intero. Sono corti o sono prefisso di
// parole comunissime: `auth` è il prefisso di `author` e `authorized_at`, `ip`
// compare dentro `tipo` e `zip`, `card` dentro `cardinalita`.
const PII_SOLO_ESATTI = new Set(['ip', 'auth', 'tax', 'cf', 'dob', 'vat', 'card', 'mail', 'birth']);

/** Spezza un nome di colonna nei suoi token: `clientIpAddress` → client/ip/address. */
function tokenizzaNome(nome) {
  return String(nome || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * Il nome del campo contiene un termine sensibile? Restituisce il termine che
 * ha prodotto la corrispondenza, oppure null.
 */
export function terminePii(nome) {
  const token = tokenizzaNome(nome);
  const insieme = new Set(token);
  const compatto = token.join('');
  for (const t of PII_TERMINI) {
    if (insieme.has(t)) return t;
    // I termini dell'elenco "solo esatti" non valgono come prefisso: `auth`
    // catturerebbe `author`, `ip` catturerebbe `tipo`.
    if (PII_SOLO_ESATTI.has(t)) continue;
    if (token.some((tok) => tok.startsWith(t))) return t;
    // Nomi scritti tutti attaccati e in minuscolo (`codicefiscale`), dove la
    // divisione in token non ha nulla su cui appoggiarsi.
    if (t.length >= 5 && compatto.includes(t)) return t;
  }
  return null;
}

export function analyzePii(schema) {
  if (!schema || !schema.collections) {
    return { total_pii_fields: 0, affected_tables_count: 0, pii_by_table: {} };
  }

  const piiByTable = {};
  let totalPiiFields = 0;

  for (const c of schema.collections) {
    const sensitiveFields = [];
    for (const f of c.fields || []) {
      const termine = terminePii(f.name);
      if (!termine) continue;
      sensitiveFields.push({ field: f.name, types: f.types || [], presence: f.presence, matched_term: termine });
      totalPiiFields++;
    }
    if (sensitiveFields.length > 0) piiByTable[c.name] = sensitiveFields;
  }

  return {
    total_pii_fields: totalPiiFields,
    affected_tables_count: Object.keys(piiByTable).length,
    pii_by_table: piiByTable,
  };
}

/* --------------------------------------------------------------------------
 * Salute dello schema.
 *
 * Le penalità sono PROPORZIONALI alla dimensione dello schema e senza tetto.
 * Con penalità assolute limitate a 30/20/30 il punteggio non poteva scendere
 * sotto 20 — quindi l'intervallo dichiarato "0-100" era in realtà 20-100 — e
 * tre tabelle orfane costavano 30 punti sia in uno schema di tre tabelle, dove
 * sono il 100% del database, sia in uno di trecento, dove sono l'1%. Poiché
 * ogni penalità saturava con due o tre occorrenze, qualunque schema di medie
 * dimensioni con qualche imperfezione atterrava sullo stesso numero, e il
 * numero smetteva di distinguere.
 * ------------------------------------------------------------------------ */

// Peso massimo di ciascun difetto se riguardasse il 100% delle tabelle.
// I pesi sommano a 100: uno schema in cui OGNI tabella è orfana e priva di
// chiave primaria arriva davvero a 0, e l'intervallo dichiarato è quello vero.
const PESO_ORFANE = 35;
const PESO_OVERSIZE = 20;
const PESO_SENZA_PK = 65;

export function auditSchema(schema) {
  if (!schema || !schema.collections || !schema.collections.length) {
    return { health_score: 100, total_tables: 0, issues: [], metric_summary: {} };
  }

  const issues = [];
  const totale = schema.collections.length;

  const degreeMap = new Map();
  for (const c of schema.collections) degreeMap.set(c.name, 0);
  for (const r of schema.relations || []) {
    degreeMap.set(r.from, (degreeMap.get(r.from) || 0) + 1);
    degreeMap.set(r.to, (degreeMap.get(r.to) || 0) + 1);
  }

  const orphanTables = schema.collections.filter((c) => (degreeMap.get(c.name) || 0) === 0).map((c) => c.name);
  const oversizedTables = schema.collections
    .filter((c) => c.fields && c.fields.length > 25)
    .map((c) => `${c.name} (${c.fields.length} campi)`);
  const missingPkTables = schema.collections
    .filter((c) => !(c.fields || []).some((f) => f.pk || f.name === '_id'))
    .map((c) => c.name);

  const penalita = (quante, peso) => (quante / totale) * peso;
  const score = Math.max(0, Math.round(
    100
    - penalita(orphanTables.length, PESO_ORFANE)
    - penalita(oversizedTables.length, PESO_OVERSIZE)
    - penalita(missingPkTables.length, PESO_SENZA_PK)
  ));

  if (orphanTables.length) {
    issues.push({
      type: 'warn',
      title: `Tabelle Orfane (${orphanTables.length} su ${totale})`,
      description: `Tabelle senza alcuna relazione: ${orphanTables.join(', ')}`,
    });
  }
  if (oversizedTables.length) {
    issues.push({
      type: 'warn',
      title: `Tabelle Oversize (${oversizedTables.length} su ${totale})`,
      description: `Tabelle con più di 25 campi: ${oversizedTables.join(', ')}`,
    });
  }
  if (missingPkTables.length) {
    issues.push({
      type: 'bad',
      title: `Tabelle Senza Chiave Primaria (${missingPkTables.length} su ${totale})`,
      description: `Tabelle prive di PK o _id: ${missingPkTables.join(', ')}`,
    });
  }

  return {
    health_score: score,
    total_tables: totale,
    issues,
    metric_summary: {
      orphan_tables: orphanTables,
      oversized_tables: oversizedTables,
      missing_pk_tables: missingPkTables,
      // Le tre metriche normalizzate: sono il dato onesto, il punteggio unico
      // è solo una loro sintesi.
      orphan_ratio: orphanTables.length / totale,
      oversized_ratio: oversizedTables.length / totale,
      missing_pk_ratio: missingPkTables.length / totale,
    },
  };
}

'use strict';

/* ---------------------------------------------------------------------------
 * Risorse dinamiche (`schema://`, `graph://`), loader condiviso delle
 * euristiche analitiche (`schema-analisi.js`) e prompt guidati MCP.
 * ------------------------------------------------------------------------- */

const path = require('path');
const url = require('url');
const { z } = require('zod');
const { ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');

// Identificatore compatibile con la sintassi erDiagram di Mermaid.
function mermaidId(name) {
  return String(name || '').replace(/[^A-Za-z0-9_]/g, '_') || '_';
}

// Disambigua le collisioni tra nomi diversi che si riducono allo stesso
// identificatore sanitizzato (es. "a-b" e "a_b" → "a_b").
function makeMermaidEntityIdResolver() {
  const used = new Set();
  const cache = new Map();
  return function entityId(name) {
    if (cache.has(name)) return cache.get(name);
    const base = mermaidId(name);
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}_${n++}`;
    used.add(id);
    cache.set(name, id);
    return id;
  };
}

// Cella di tabella markdown: neutralizza `|` e a capo nei nomi di campo.
function cellaMd(v) {
  return String(v == null ? '' : v)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

// Tetto in byte del documento prodotto dalle risorse MCP.
function tettoRisorsaBytes(env = process.env) {
  const n = parseInt(env.CODEDB_MAX_RESULT_BYTES, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 32 * 1024 * 1024) : 32 * 1024 * 1024;
}

function renderSchemaMarkdown(db, schema, env = process.env) {
  const collections = (schema && schema.collections) || [];
  const relations = (schema && schema.relations) || [];
  const entityId = makeMermaidEntityIdResolver();
  for (const c of collections) entityId(c.name);

  const tetto = tettoRisorsaBytes(env);
  let byte = 0;
  let troncatoA = -1;

  // Costruzione a blocchi per COLLEZIONE, così il troncamento cade su un
  // confine leggibile invece che a metà di una tabella markdown.
  const testa = [`# Schema di \`${db}\``, '', '## Diagramma UML (Mermaid)', '', '```mermaid', 'erDiagram'];
  const corpoUml = [];
  for (let k = 0; k < collections.length; k++) {
    const c = collections[k];
    const blocco = [`  ${entityId(c.name)} {`];
    for (const f of c.fields || []) {
      blocco.push(`    ${mermaidId((f.types || []).join('_'))} ${mermaidId(f.name)}`);
    }
    blocco.push('  }');
    const dim = blocco.join('\n').length;
    if (byte + dim > tetto) { troncatoA = k; break; }
    byte += dim;
    corpoUml.push(...blocco);
  }
  const mostrate = troncatoA < 0 ? collections.length : troncatoA;

  const lines = [...testa, ...corpoUml];
  for (const r of relations) {
    lines.push(`  ${entityId(r.from)} ${r.many ? '}o--o{' : '}o--||'} ${entityId(r.to)} : "${mermaidId(r.field)}"`);
  }
  lines.push('```', '', '## Dizionario dati', '');
  for (const c of collections.slice(0, mostrate)) {
    lines.push(`### ${c.name}`, '', '| Campo | Tipi | Presenza % |', '| --- | --- | --- |');
    for (const f of c.fields || []) {
      lines.push(`| ${cellaMd(f.name)} | ${cellaMd((f.types || []).join(', '))} | ${cellaMd(f.presence)} |`);
    }
    lines.push('');
  }
  if (relations.length) {
    lines.push('## Relazioni', '');
    for (const r of relations) {
      lines.push(`- \`${r.from}.${r.field}\` → \`${r.to}\`${r.many ? ' (uno-a-molti)' : ''}`);
    }
    lines.push('');
  }
  if (troncatoA >= 0) {
    lines.push(
      `> ⚠ Schema troncato: mostrate ${mostrate} collezioni su ${collections.length} `
      + `(limite di ${Math.round(tetto / 1048576)} MB per risorsa). `
      + 'Per il dettaglio di una singola tabella usa lo strumento `get_schema`.',
      ''
    );
  }
  return lines.join('\n');
}

// Le euristiche analitiche vivono in un solo posto (`public/js/schema-analisi.js`,
// ESM condiviso col browser): da CommonJS si usa un `import()` dinamico memoizzato.
let analisiPromise = null;
function caricaAnalisi() {
  if (!analisiPromise) {
    const fileUrl = url.pathToFileURL(
      path.join(__dirname, '..', 'public', 'js', 'schema-analisi.js')
    ).href;
    analisiPromise = import(fileUrl);
  }
  return analisiPromise;
}

async function buildGraphData(schema, includeImplicit = true) {
  if (!schema || !schema.collections) {
    return { nodes: [], links: [], stats: { node_count: 0, edge_count: 0, implicit_count: 0 } };
  }

  const degreeMap = new Map();
  for (const c of schema.collections) degreeMap.set(c.name, 0);

  const rels = [...(schema.relations || [])];
  let implicitCount = 0;
  if (includeImplicit) {
    const { detectImplicitRelations } = await caricaAnalisi();
    const implicitRels = detectImplicitRelations(schema.collections, rels);
    implicitCount = implicitRels.length;
    rels.push(...implicitRels);
  }

  for (const r of rels) {
    degreeMap.set(r.from, (degreeMap.get(r.from) || 0) + 1);
    degreeMap.set(r.to, (degreeMap.get(r.to) || 0) + 1);
  }

  const nodes = schema.collections.map((c) => ({
    id: c.name,
    name: c.name,
    degree: degreeMap.get(c.name) || 0,
    fieldCount: (c.fields && c.fields.length) || 0,
    fields: (c.fields || []).map((f) => ({ name: f.name, types: f.types || [], pk: !!f.pk })),
  }));

  const links = rels.map((r) => ({
    source: r.from,
    target: r.to,
    label: r.field,
    many: !!r.many,
    implicit: !!r.implicit,
  }));

  return {
    nodes,
    links,
    stats: {
      node_count: nodes.length,
      edge_count: links.length,
      implicit_count: implicitCount,
    },
  };
}

function registraRisorseEPrompt({ server, requireDbSession, env }) {
  server.registerResource(
    'schema',
    new ResourceTemplate('schema://{connectionId}/{db}', { list: undefined }),
    {
      title: 'Schema del database (UML + dizionario dati)',
      description:
        'Diagramma UML in formato Mermaid (erDiagram) e dizionario dati del database indicato, ' +
        'con campi, tipi, presenza % e relazioni (foreign key reali ed euristiche). ' +
        'Generato al momento della lettura, quindi sempre aggiornato allo schema corrente. ' +
        'URI: schema://{connectionId}/{db}, dove connectionId è quello restituito da connect_database.',
      mimeType: 'text/markdown',
    },
    async (uri, { connectionId, db }) => {
      const sess = requireDbSession(connectionId);
      const dbName = String(db || '').trim();
      if (!dbName) throw new Error('Nome del database mancante nell\'URI (schema://{connectionId}/{db}).');
      const schema = await sess.strategy.dbSchema(dbName);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderSchemaMarkdown(dbName, schema, env) }] };
    }
  );

  server.registerResource(
    'graph',
    new ResourceTemplate('graph://{connectionId}/{db}', { list: undefined }),
    {
      title: 'Grafo relazionale (Nodi & Archi 3D/2D JSON)',
      description:
        'Struttura JSON a nodi ed archi del grafo relazionale (Graph 3D/2D), con degree centrality, campi e relazioni (esplicite ed implicite). ' +
        'URI: graph://{connectionId}/{db}, dove connectionId è quello restituito da connect_database.',
      mimeType: 'application/json',
    },
    async (uri, { connectionId, db }) => {
      const sess = requireDbSession(connectionId);
      const dbName = String(db || '').trim();
      if (!dbName) throw new Error('Nome del database mancante nell\'URI (graph://{connectionId}/{db}).');
      const schema = await sess.strategy.dbSchema(dbName);
      const graphData = await buildGraphData(schema, true);
      let testo = JSON.stringify(graphData, null, 2);
      const tetto = tettoRisorsaBytes(env);
      if (Buffer.byteLength(testo) > tetto) {
        const quanti = Math.max(1, Math.floor(graphData.nodes.length * (tetto / Buffer.byteLength(testo)) * 0.9));
        const tenuti = new Set(graphData.nodes.slice(0, quanti).map((n) => n.id));
        testo = JSON.stringify({
          ...graphData,
          nodes: graphData.nodes.slice(0, quanti),
          links: graphData.links.filter((l) => tenuti.has(l.source) && tenuti.has(l.target)),
          truncated: true,
          truncation_note:
            `Grafo troncato: ${quanti} nodi su ${graphData.nodes.length} (limite di `
            + `${Math.round(tetto / 1048576)} MB per risorsa). Usa lo strumento get_graph su un `
            + 'database più piccolo, oppure get_schema per una singola tabella.',
        }, null, 2);
      }
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: testo }] };
    }
  );

  server.registerPrompt('genera-report', {
    title: 'Genera report da un database',
    description: 'Produce un report analitico in markdown su un database, usando i tools di sola lettura del server.',
    argsSchema: {
      connessione: z.string().describe('Nome della connessione salvata (vedi list_saved_connections)'),
      db: z.string().describe('Database da analizzare'),
      periodo: z.string().optional().describe('Periodo di interesse, es. "ultimo mese" o "2026"'),
    },
  }, ({ connessione, db, periodo }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text:
          `Genera un report analitico sul database "${db}" della connessione salvata "${connessione}"` +
          (periodo ? `, limitato al periodo: ${periodo}` : '') + '.\n\n' +
          'Procedi così:\n' +
          `1. Apri la connessione con connect_database (saved: "${connessione}").\n` +
          `2. Studia la struttura con get_schema (o la risorsa schema://{connection_id}/${db}) prima di scrivere query.\n` +
          '3. Esegui con execute_query solo interrogazioni di sola lettura mirate (limit bassi, proiezioni/SELECT dei soli campi utili): volumi per collection/tabella, distribuzioni e metriche significative' +
          (periodo ? ' filtrate sul periodo indicato usando i campi data disponibili' : '') + '.\n' +
          '4. Componi un report in markdown con: panoramica delle entità e delle relazioni, numeri chiave, eventuali anomalie (campi poco presenti, valori sospetti) e osservazioni finali.\n' +
          '5. Alla fine chiudi la connessione con disconnect_database.',
      },
    }],
  }));

  server.registerPrompt('esplora-database', {
    title: 'Esplora una connessione',
    description: 'Esplorazione guidata di una connessione: topologia, schema e campioni, con dizionario dati commentato come risultato.',
    argsSchema: {
      connessione: z.string().describe('Nome della connessione salvata (vedi list_saved_connections)'),
      db: z.string().optional().describe('Database specifico; se assente, esplora la topologia e scegli i più rilevanti'),
    },
  }, ({ connessione, db }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text:
          `Esplora la connessione salvata "${connessione}"${db ? `, concentrandoti sul database "${db}"` : ''}.\n\n` +
          'Procedi così:\n' +
          `1. Apri la connessione con connect_database (saved: "${connessione}").\n` +
          (db
            ? `2. Elenca le collection/tabelle di "${db}" con get_databases_and_collections.\n`
            : '2. Elenca i database con get_databases_and_collections e individua quelli applicativi (ignora quelli di sistema).\n') +
          '3. Per il database di interesse leggi lo schema con get_schema e osserva qualche documento/riga reale con execute_query (limit 5).\n' +
          '4. Produci un dizionario dati commentato in markdown: per ogni collection/tabella scopo presunto, campi principali con tipi, relazioni con le altre entità e note su qualità/particolarità dei dati.\n' +
          '5. Alla fine chiudi la connessione con disconnect_database.',
      },
    }],
  }));

  server.registerPrompt('analizza-gdpr', {
    title: 'Analisi di conformità GDPR e PII',
    description: 'Scansiona il database alla ricerca di campi sensibili (PII) e suggerisce misure per la conformità GDPR.',
    argsSchema: {
      connessione: z.string().describe('Nome della connessione salvata'),
      db: z.string().describe('Database da analizzare'),
    },
  }, ({ connessione, db }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text:
          `Esegui un'analisi della privacy e dei dati sensibili (PII/GDPR) sul database "${db}" della connessione "${connessione}".\n\n` +
          'Procedi così:\n' +
          `1. Apri la connessione con connect_database (saved: "${connessione}").\n` +
          `2. Esegui il tool analyze_pii su "${db}".\n` +
          '3. Ispeziona gli schemi o le tabelle interessate con get_schema ed execute_query se occorre verificare dati campione.\n' +
          '4. Produci un report in markdown con l\'elenco delle tabelle contenenti PII, la classificazione dei rischi e le raccomandazioni di cifratura/anonimizzazione.\n' +
          '5. Chiudi la connessione con disconnect_database.',
      },
    }],
  }));

  server.registerPrompt('diagnostica-schema', {
    title: 'Diagnostica architettonica e audit schema',
    description: 'Esegue un audit completo sullo schema (salute, tabelle orfane/oversize, dipendenze ed ordine di seeding).',
    argsSchema: {
      connessione: z.string().describe('Nome della connessione salvata'),
      db: z.string().describe('Database da analizzare'),
    },
  }, ({ connessione, db }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text:
          `Esegui una diagnostica architettonica dello schema sul database "${db}" della connessione "${connessione}".\n\n` +
          'Procedi così:\n' +
          `1. Apri la connessione con connect_database (saved: "${connessione}").\n` +
          `2. Esegui audit_schema e analyze_dependencies su "${db}".\n` +
          '3. Identifica le tabelle Root, Leaf, le eventuali tabelle orfane o prive di chiavi primarie, ed il punteggio di salute.\n' +
          '4. Produci un report in markdown con la valutazione della salute dello schema, le raccomandazioni di refactoring e la sequenza ottima di popolamento/seeding.\n' +
          '5. Chiudi la connessione con disconnect_database.',
      },
    }],
  }));
}

module.exports = {
  caricaAnalisi,
  buildGraphData,
  renderSchemaMarkdown,
  tettoRisorsaBytes,
  registraRisorseEPrompt,
};

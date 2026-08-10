/* ---------------------------------------------------------------------------
 * CodeDB — Generatori e lettori di schema (Mermaid, DBML, DDL SQL).
 *
 * Modulo FOGLIA (nessun import) estratto da `graph3d.js` per la stessa ragione
 * di `chart-option.js` e `cell-stats.js`: sono funzioni pure che producono un
 * artefatto che l'utente PORTA VIA — uno script DDL da eseguire, un file DBML
 * da aprire in dbdiagram.io, uno snapshot JSON da confrontare. Un diagramma
 * disegnato storto si vede; un `CREATE TABLE` con due clausole PRIMARY KEY si
 * scopre quando qualcuno prova a eseguirlo, e una relazione attribuita alla
 * tabella sbagliata non si scopre affatto.
 *
 * Stando fuori dal DOM sono provabili in Node (`test/unit-schema-export.js`).
 * ------------------------------------------------------------------------- */

/** Identificatore sicuro per Mermaid: solo lettere, cifre e underscore. */
export function sanitizeName(str) {
  if (!str) return 'entity';
  return String(str).replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Colonna bersaglio di una relazione verso `tabella`.
 *
 * Serve perché i due export dichiaravano bersagli DIVERSI per la stessa
 * relazione: il DDL scriveva sempre `REFERENCES tabella (id)` e il DBML sempre
 * `> "tabella"."_id"`, e nessuno dei due leggeva la chiave primaria vera. Ora
 * la si cerca dove è già scritta (`fields[].pk`), con `_id` come ripiego su
 * MongoDB e `id` come ultima spiaggia.
 */
export function colonnaBersaglio(collections, nomeTabella) {
  const t = (collections || []).find((c) => c.name === nomeTabella);
  const pk = ((t && t.fields) || []).filter((f) => f.pk).map((f) => f.name);
  if (pk.length) return pk[0];
  if (((t && t.fields) || []).some((f) => f.name === '_id')) return '_id';
  return 'id';
}

/* --------------------------------- Mermaid -------------------------------- */

export function buildMermaidDiagram(schema) {
  const collections = (schema && schema.collections) || [];
  if (!collections.length) return '';
  const relations = (schema && schema.relations) || [];
  const lines = ['erDiagram'];
  for (const c of collections) {
    lines.push(`    ${sanitizeName(c.name)} {`);
    for (const f of c.fields || []) {
      const typeStr = (f.types && f.types[0]) ? sanitizeName(f.types[0]) : 'string';
      lines.push(`        ${typeStr} ${sanitizeName(f.name)}`);
    }
    lines.push('    }');
  }
  for (const r of relations) {
    lines.push(`    ${sanitizeName(r.from)} ||--o{ ${sanitizeName(r.to)} : "${sanitizeName(r.field)}"`);
  }
  return lines.join('\n');
}

/* ----------------------------------- DBML --------------------------------- */

export function buildDbmlDiagram(schema, { db = 'database', dbType = 'MySQL' } = {}) {
  const collections = (schema && schema.collections) || [];
  if (!collections.length) return '';
  const relations = (schema && schema.relations) || [];
  const lines = [
    '// Database Markup Language (DBML) per dbdiagram.io',
    `Project "${db}" {`,
    `  database_type: '${dbType}'`,
    '}',
    '',
  ];
  for (const c of collections) {
    lines.push(`Table "${c.name}" {`);
    for (const f of c.fields || []) {
      const typeStr = (f.types && f.types[0]) ? f.types[0] : 'varchar';
      const isPk = f.pk || f.name === '_id';
      lines.push(`  "${f.name}" ${typeStr}${isPk ? ' [pk]' : ''}`);
    }
    lines.push('}\n');
  }
  for (const r of relations) {
    lines.push(`Ref: "${r.from}"."${r.field}" > "${r.to}"."${colonnaBersaglio(collections, r.to)}"`);
  }
  return lines.join('\n');
}

/* ----------------------------------- DDL ---------------------------------- */

export function buildSqlDdl(schema, { db = 'db' } = {}) {
  const collections = (schema && schema.collections) || [];
  if (!collections.length) return '';
  const relations = (schema && schema.relations) || [];
  const lines = [`-- Script DDL generato per database ${db}`, ''];
  for (const c of collections) {
    lines.push(`CREATE TABLE \`${c.name}\` (`);
    const colDefs = [];
    const pk = [];
    for (const f of c.fields || []) {
      const isPk = f.pk || f.name === '_id';
      const type = (f.types && f.types[0]) ? f.types[0].toUpperCase() : 'VARCHAR(255)';
      // La clausola PRIMARY KEY va emessa UNA VOLTA SOLA, in coda: metterla su
      // ogni colonna con `pk` produceva due PRIMARY KEY nella stessa CREATE
      // TABLE su una chiave composta, e sia MySQL sia PostgreSQL la rifiutano.
      colDefs.push(`  \`${f.name}\` ${type}${isPk ? ' NOT NULL' : ''}`);
      if (isPk) pk.push(f.name);
    }
    if (pk.length) colDefs.push(`  PRIMARY KEY (${pk.map((n) => `\`${n}\``).join(', ')})`);
    lines.push(colDefs.join(',\n'));
    lines.push(');\n');
  }
  for (const r of relations) {
    const bersaglio = colonnaBersaglio(collections, r.to);
    lines.push(
      `ALTER TABLE \`${r.from}\` ADD CONSTRAINT \`fk_${r.from}_${r.field}\` `
      + `FOREIGN KEY (\`${r.field}\`) REFERENCES \`${r.to}\` (\`${bersaglio}\`);`
    );
  }
  return lines.join('\n');
}

/* ------------------------------ Lettura schema ---------------------------- */

/**
 * Divide il corpo di una CREATE TABLE nelle sue voci.
 *
 * Sulla VIRGOLA a profondità zero, non sull'a capo: una `CREATE TABLE` scritta
 * su una riga sola — la forma che produce `SHOW CREATE TABLE` compattato, e
 * quella che si incolla più spesso — sarebbe letta come un'unica colonna.
 * La profondità serve perché `DECIMAL(10, 2)` e `PRIMARY KEY (a, b)` hanno
 * virgole loro.
 */
function vociCorpoSql(body) {
  const voci = [];
  let corrente = '';
  let profondita = 0;
  for (const ch of String(body)) {
    if (ch === '(') profondita++;
    else if (ch === ')') profondita = Math.max(0, profondita - 1);
    if (ch === ',' && profondita === 0) { voci.push(corrente); corrente = ''; continue; }
    corrente += ch;
  }
  if (corrente.trim()) voci.push(corrente);
  return voci;
}

function campiDaCorpoSql(body) {
  const fields = [];
  const pkComposta = [];
  for (const riga of vociCorpoSql(body)) {
    const trimmed = riga.trim().replace(/,$/, '');
    if (!trimmed || trimmed.startsWith('--')) continue;
    const su = trimmed.toUpperCase();
    if (su.startsWith('PRIMARY KEY')) {
      // `PRIMARY KEY (a, b)` in coda: le colonne elencate sono chiave, e senza
      // questa riga una chiave composta veniva importata come se non ci fosse.
      const m = trimmed.match(/\(([^)]*)\)/);
      if (m) for (const n of m[1].split(',')) pkComposta.push(n.trim().replace(/[`"[\]]/g, ''));
      continue;
    }
    if (su.startsWith('CONSTRAINT') || su.startsWith('FOREIGN KEY') || su.startsWith('KEY ') || su.startsWith('INDEX ') || su.startsWith('UNIQUE ')) continue;
    const parts = trimmed.split(/\s+/);
    if (!parts.length) continue;
    fields.push({
      name: parts[0].replace(/[`"]/g, ''),
      types: [parts[1] || 'VARCHAR'],
      pk: su.includes('PRIMARY KEY'),
    });
  }
  for (const f of fields) if (pkComposta.includes(f.name)) f.pk = true;
  return fields;
}

/**
 * Legge uno schema da un testo DBML o SQL.
 *
 * Le FOREIGN KEY di un file SQL si cercano DENTRO il corpo di ciascuna
 * `CREATE TABLE` (e poi negli `ALTER TABLE … ADD CONSTRAINT`), non con una
 * regex globale sull'intero testo: quella non sa in quale tabella si trovasse
 * la clausola, e il codice se la cavava scrivendo `from: 'imported'`, cioè
 * attribuendo OGNI relazione a una tabella che non esiste. Il ramo DBML faceva
 * già la cosa giusta, perché la sintassi `Ref:` porta con sé l'origine.
 */
export function parseSchemaInput(text, format) {
  const collections = [];
  const relations = [];
  const src = String(text || '');

  if (format === 'dbml') {
    const tableRegex = /Table\s+["']?([a-zA-Z0-9_]+)["']?\s*\{([^}]+)\}/gi;
    let match;
    while ((match = tableRegex.exec(src)) !== null) {
      const fields = [];
      for (const riga of match[2].split('\n')) {
        const trimmed = riga.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;
        const parts = trimmed.split(/\s+/);
        if (!parts.length) continue;
        fields.push({
          name: parts[0].replace(/["']/g, ''),
          types: [parts[1] || 'varchar'],
          pk: trimmed.includes('[pk]'),
        });
      }
      collections.push({ name: match[1], fields });
    }

    const refRegex = /Ref:\s*["']?([a-zA-Z0-9_]+)["']?\."?([a-zA-Z0-9_]+)"?\s*>\s*["']?([a-zA-Z0-9_]+)["']?\."?([a-zA-Z0-9_]+)"?/gi;
    let refMatch;
    while ((refMatch = refRegex.exec(src)) !== null) {
      relations.push({ from: refMatch[1], field: refMatch[2], to: refMatch[3], many: true });
    }
    return { collections, relations };
  }

  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([a-zA-Z0-9_]+)[`"]?\s*\(([^;]+)\);/gi;
  let match;
  while ((match = tableRegex.exec(src)) !== null) {
    const tableName = match[1];
    const body = match[2];
    collections.push({ name: tableName, fields: campiDaCorpoSql(body) });

    // FK dichiarate DENTRO questa CREATE TABLE: l'origine è questa tabella.
    const fkRegex = /FOREIGN\s+KEY\s*\(\s*[`"]?([a-zA-Z0-9_]+)[`"]?\s*\)\s*REFERENCES\s*[`"]?([a-zA-Z0-9_]+)[`"]?\s*\(\s*[`"]?([a-zA-Z0-9_]+)[`"]?\s*\)/gi;
    let fk;
    while ((fk = fkRegex.exec(body)) !== null) {
      relations.push({ from: tableName, field: fk[1], to: fk[2], many: true });
    }
  }

  // FK aggiunte fuori dal corpo: qui la tabella d'origine la porta l'ALTER.
  const alterRegex = /ALTER\s+TABLE\s+[`"]?([a-zA-Z0-9_]+)[`"]?[\s\S]*?FOREIGN\s+KEY\s*\(\s*[`"]?([a-zA-Z0-9_]+)[`"]?\s*\)\s*REFERENCES\s*[`"]?([a-zA-Z0-9_]+)[`"]?\s*\(\s*[`"]?([a-zA-Z0-9_]+)[`"]?\s*\)/gi;
  let alter;
  while ((alter = alterRegex.exec(src)) !== null) {
    relations.push({ from: alter[1], field: alter[2], to: alter[3], many: true });
  }

  return { collections, relations };
}

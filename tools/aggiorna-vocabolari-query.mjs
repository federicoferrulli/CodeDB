/** Rigenera i cataloghi dell'editor dalle fonti ufficiali, senza dipendenze. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, 'test-reports/query-languages');
const fonti = {
  pg: 'https://www.postgresql.org/docs/18/sql-keywords-appendix.html',
  mysql: 'https://raw.githubusercontent.com/mysql/mysql-server/mysql-8.4.0/sql/lex.h',
  mysqlfunctions: 'https://raw.githubusercontent.com/mysql/mysql-server/mysql-8.4.0/sql/item_create.cc',
  mongo: 'https://www.mongodb.com/docs/v8.0/reference/operator/aggregation/',
  stages: 'https://www.mongodb.com/docs/v8.0/reference/operator/aggregation-pipeline/',
  mongoquery: 'https://www.mongodb.com/docs/v8.0/reference/operator/query/',
  mongoupdate: 'https://www.mongodb.com/docs/v8.0/reference/operator/update/',
  mongoaccumulatori: 'https://www.mongodb.com/docs/manual/reference/mql/accumulators/',
  mongofinestra: 'https://www.mongodb.com/docs/v8.0/reference/operator/aggregation/setWindowFields/',
};
for (const area of ['math', 'string', 'binarystring', 'datetime', 'enum', 'geometry', 'net', 'textsearch',
  'uuid', 'xml', 'json', 'sequence', 'conditional', 'array', 'range', 'aggregate', 'window', 'info', 'admin']) {
  fonti[`pg-${area}`] = `https://www.postgresql.org/docs/18/functions-${area}.html`;
}
await fs.mkdir(cache, { recursive: true });
const documenti = Object.fromEntries(await Promise.all(Object.entries(fonti).map(async ([id, url]) => {
  const file = path.join(cache, `${id}.${id.startsWith('mysql') ? 'txt' : 'html'}`);
  if (!process.argv.includes('--offline')) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
    await fs.writeFile(file, await res.text());
  }
  return [id, await fs.readFile(file, 'utf8')];
})));
const unici = valori => [...new Set(valori)].sort();
const pgRighe = [...documenti.pg.matchAll(/<tr>\s*<td><code class="token">([^<]+)<\/code><\/td>\s*<td>([\s\S]*?)<\/td>/g)];
const pgParole = pgRighe.filter(m => m[2].includes('reserved')).map(m => m[1]);
const pgRiservate = pgRighe.filter(m => /^reserved/.test(m[2])).map(m => m[1]);
const mysqlParole = [...documenti.mysql.matchAll(/\{SYM(?:_HK)?\("([A-Z][A-Z0-9_]*)"/g)].map(m => m[1]);
const mysqlFunzioni = [...documenti.mysql.matchAll(/\{SYM_FN\("([A-Z][A-Z0-9_]*)"/g),
  ...documenti.mysqlfunctions.matchAll(/\{"([A-Z][A-Z0-9_]*)",\s*SQL_(?:FN|FACTORY)/g)].map(m => m[1]).filter(s => !s.startsWith('INTERNAL_'));
const pgFunzioni = Object.entries(documenti).filter(([id]) => id.startsWith('pg-')).flatMap(([, html]) =>
  [...html.matchAll(/<p class="func_signature">([\s\S]*?)<\/p>/g)].flatMap(blocco =>
    [...blocco[1].matchAll(/<code class="function">([a-zA-Z_][a-zA-Z0-9_]*)/g)].map(m => m[1].toUpperCase())));
const operatori = id => unici([...documenti[id].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].flatMap(riga => {
  const cella = /<td[^>]*>([\s\S]*?)<\/td>/.exec(riga[1]);
  return cella ? [...cella[1].matchAll(/>(\$[a-zA-Z][a-zA-Z0-9]*)</g)].map(m => m[1]) : [];
}));
const sezioneFinestra = documenti.mongofinestra.slice(documenti.mongofinestra.indexOf('id="window-operators"')).split('<h2')[0];
const cataloghi = {
  KEYWORDS_MYSQL: unici(mysqlParole), KEYWORDS_POSTGRESQL: unici(pgParole), RISERVATE_POSTGRESQL: unici(pgRiservate),
  FUNZIONI_MYSQL: unici(mysqlFunzioni), FUNZIONI_POSTGRESQL: unici(pgFunzioni),
  ESPRESSIONI_MONGO: operatori('mongo'), STADI_MONGO: operatori('stages'),
  FILTRI_MONGO: operatori('mongoquery'), AGGIORNAMENTI_MONGO: operatori('mongoupdate'),
  ACCUMULATORI_MONGO: operatori('mongoaccumulatori'),
  FINESTRA_MONGO: unici([...sezioneFinestra.matchAll(/>(\$[a-zA-Z][a-zA-Z0-9]*)</g)].map(m => m[1]))
    .filter(v => v !== '$setWindowFields'),
};
for (const [nome, lista] of Object.entries(cataloghi)) {
  const minimo = nome.startsWith('KEYWORDS') ? 400 : nome.startsWith('FUNZIONI') ? 200 : nome.startsWith('RISERVATE') ? 50 : 10;
  if (lista.length < minimo) throw new Error(`${nome}: solo ${lista.length} voci; verificare il formato della fonte.`);
  console.log(`${nome}: ${lista.length}`);
}
const righe = ['/** Cataloghi generati da tools/aggiorna-vocabolari-query.mjs. Non modificare a mano.',
  ' * MySQL 8.4, PostgreSQL 18, MongoDB 8.0. La disponibilità dipende dalla versione del server.',
  ...Object.entries(fonti).map(([id, url]) => ` * ${id}: ${url}`), ' */'];
for (const [nome, lista] of Object.entries(cataloghi)) {
  righe.push(`export const ${nome} = (`);
  for (let i = 0; i < lista.length; i += 8) righe.push(`  ${JSON.stringify(lista.slice(i, i + 8).join(' ') + (i + 8 < lista.length ? ' ' : ''))}${i + 8 < lista.length ? ' +' : ''}`);
  righe.push(").split(' ');", '');
}
await fs.writeFile(path.join(root, 'public/js/query-cataloghi.mjs'), righe.join('\n'));

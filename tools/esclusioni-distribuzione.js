'use strict';

/* ---------------------------------------------------------------------------
 * CodeDB — Elenco UNICO dei file che non devono finire in un pacchetto.
 *
 * Esistevano DUE elenchi indipendenti — `IGNORE` in tools/build-desktop.mjs
 * (@electron/packager, usato da `npm run dist:*`) e `build.files` in
 * package.json (electron-builder, usato da `npm run build:*` e `release:*`) —
 * e nessuno dei due escludeva tutto ciò che il `.gitignore` considera privato.
 * Mancavano in entrambi `vault.json` e `provenienza/`, e nel solo percorso
 * packager anche `.env`, `ui-audit.log` e `data/conns/**`.
 *
 * Cosa significa in concreto: un installer o uno zip si aprono come un
 * archivio (`app.asar` compreso, che non è cifrato), quindi chiunque lo
 * scarichi troverebbe il salt scrypt e la DEK avvolta dello sviluppatore —
 * materiale su cui montare offline esattamente l'attacco che il formato v2 del
 * vault esiste per rendere impraticabile — e il registro dei marcatori di
 * provenienza, che la documentazione tiene fuori da git con la motivazione
 * esplicita che pubblicarlo «consegnerebbe l'elenco di cosa cancellare».
 *
 * Da qui in poi l'elenco è uno solo: questo. `build-desktop.mjs` lo importa e
 * `test/unit.js` verifica che `build.files` di package.json lo rispecchi.
 * ------------------------------------------------------------------------- */

/**
 * Voci di esclusione in forma electron-builder (`!pattern`, glob relativi alla
 * radice). Sono la fonte: i regex del packager si derivano da queste.
 */
const ESCLUSIONI = [
  // Prodotti di build e materiale di sviluppo
  '!dist/**',
  '!android/**',
  '!docs/**',
  '!issue/**',
  '!test/**',
  '!tools/**',
  '!ui/**',
  '!test-reports/**',
  '!backups/**',
  '!.scratch/**',
  '!.agents/**',
  '!.codex/**',
  '!.claude/**',
  '!.impeccable/**',
  '!.git*',
  '!Dockerfile',
  '!docker-compose.yml',
  '!public/logo.png',
  '!node_modules/cpu-features/**',
  '!node_modules/nan/**',

  // File di sviluppo non-runtime dentro node_modules (source map, definizioni
  // TypeScript, test, esempi e documentazione). Le licenze restano incluse.
  '!node_modules/**/*.map',
  '!node_modules/**/*.d.ts',
  '!node_modules/**/*.d.mts',
  '!node_modules/**/*.d.cts',
  '!node_modules/**/@types/**',
  '!node_modules/**/test/**',
  '!node_modules/**/tests/**',
  '!node_modules/**/__tests__/**',
  '!node_modules/**/docs/**',
  '!node_modules/**/example/**',
  '!node_modules/**/examples/**',
  '!node_modules/**/README*.md',
  '!node_modules/**/readme*.md',
  '!node_modules/**/CHANGELOG*.md',
  '!node_modules/**/changelog*.md',
  '!node_modules/**/HISTORY*.md',

  // SEGRETI. Ognuna di queste voci, se manca, pubblica qualcosa che non deve
  // uscire dalla macchina di chi costruisce il pacchetto.
  '!.env',
  '!.env.*',
  '!.env.example',
  '!connections.ini',
  '!connections.ini.*',
  '!**/*.backup-signing-key*',
  '!**/vault.json*',
  '!**/connections.ini*',
  '!**/.env*',
  '!conns/**',
  '!data/**',        // data/conns/<ownerId>.ini — i vault per tenant
  '!vault.json',
  '!vault.json.*',
  '!vault.*',
  '!provenienza/**', // registro privato dei marcatori di provenienza

  // Log: contengono nomi di connessione, database e collezioni di ogni
  // operazione fatta sulla macchina di sviluppo.
  '!*.log',
  '!*.log.*',
  '!ui-audit.log',
  '!ui-audit.log.*',
  '!mcp-audit.log',
  '!mcp-audit.log.*',
];

// Le nuove cartelle e gli export locali non diventano automaticamente parte della release.
const CARTELLE_RUNTIME = ['auth', 'backup', 'db', 'mcp', 'server', 'public', 'bin'];
const FILE_RUNTIME = ['package.json', 'server.js', 'electron-main.js', 'electron-aggiornamenti.js', 'electron-server-auth.js', 'electron-chiusura.js', 'LICENSE.md', 'EULA.md', 'MANLEVA.md'];
const INCLUSIONI = [...FILE_RUNTIME, ...CARTELLE_RUNTIME.map(dir => `${dir}/**`)];

/**
 * Le stesse esclusioni come espressioni regolari per @electron/packager, che
 * riceve percorsi con la barra iniziale (`/docs/x.md`).
 *
 * LICENSE.md, MANLEVA.md ed EULA.md NON si escludono: l'app li legge a runtime
 * per la schermata "Informazioni & Licenza", e la AGPL pretende che la copia
 * della licenza accompagni il programma distribuito.
 */
const SOLO_PACKAGER = [
  /^\/(README|AGENT|CLAUDE|REVISIONE-CODEBASE)\.md$/,
  /^\/strategy_.*\.md$/,
  /^\/(CodeDB\.cmd|codedb\.sh)$/,
];

/** Da `!cartella/**` o `!file.ext` al regex equivalente sul percorso packager. */
function aRegex(voce) {
  const glob = voce.replace(/^!/, '');
  const converti = (s) => s
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/|\*\*|\*/g, (m) => (m === '**/' ? '(?:.*/)?' : m === '**' ? '.*' : '[^/]*'));
  if (glob.endsWith('/**')) {
    const dir = converti(glob.slice(0, -3));
    return new RegExp(`^/${dir}($|/)`);
  }
  const corpo = converti(glob);
  return new RegExp(`^/${corpo}$`);
}

function regexPackager() {
  const ammessi = [...CARTELLE_RUNTIME, 'node_modules'].map(dir => `${dir}(?:/|$)`)
    .concat(FILE_RUNTIME.map(file => file.replaceAll('.', '\\.') + '$')).join('|');
  return [new RegExp(`^/(?!${ammessi}).+`), ...ESCLUSIONI.map(aRegex), ...SOLO_PACKAGER];
}

module.exports = { INCLUSIONI, ESCLUSIONI, SOLO_PACKAGER, regexPackager, aRegex };

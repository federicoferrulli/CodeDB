'use strict';

// Prepara una build di distribuzione firmata. Il caricamento della bozza completa
// avviene soltanto nel job finale, tramite pubblica-bozza.cjs.

const { spawnSync } = require('child_process');
const path = require('path');

const RADICE = path.join(__dirname, '..');
const PIATTAFORME = { win: '--win', mac: '--mac', linux: '--linux' };

/** Tag predefinito per una release avviata senza un tag esplicito. */
function tagDiRilascio(versione) {
  return `v${String(versione || '').trim().replace(/^v/i, '')}`;
}

/**
 * `true` se la versione contiene una componente di pre-release. Duplicato
 * volutamente MINIMO di `versioneDiPreRelease` in electron-aggiornamenti.js:
 * quel modulo è pensato per il processo Electron e importarlo qui tirerebbe
 * dentro il file dell'app in uno script di build. `npm test` verifica che le
 * due funzioni diano la stessa risposta.
 */
function versioneDiPreRelease(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  return s.split('+')[0].split('-').slice(1).join('-').length > 0;
}

/** Decide il tipo di release: variabile d'ambiente se c'è, altrimenti versione. */
function preRelease(env, versione) {
  const v = String((env || {}).CODEDB_RELEASE_PRERELEASE ?? '').trim().toLowerCase();
  if (['1', 'on', 'true', 'si', 'sì', 'yes'].includes(v)) return true;
  if (['0', 'off', 'false', 'no'].includes(v)) return false;
  return versioneDiPreRelease(versione);
}

/**
 * Tag che nominano la STESSA versione in uscita senza essere quello a cui la
 * release verrà agganciata: duplicati che nel feed atom fanno le veci della
 * release vera. Il confronto normalizza la `v` iniziale e ignora maiuscole e
 * minuscole, così prende `0.1.3-beta.1` come `V0.1.3-beta.1` — cioè la classe,
 * non solo la forma già vista. Funzione PURA.
 *
 * @param {string[]} tag elenco di nomi di tag (locali e/o remoti)
 * @param {string} versione versione in uscita (`package.json` → `version`)
 * @returns {string[]} i tag da rimuovere, senza ripetizioni
 */
function tagDuplicati(tag, versione) {
  const atteso = tagDiRilascio(versione);
  const normalizza = (t) => String(t || '').trim().replace(/^v/i, '').toLowerCase();
  const bersaglio = normalizza(atteso);
  if (!bersaglio) return [];
  const visti = new Set();
  const fuori = [];
  for (const t of tag || []) {
    const nome = String(t || '').trim();
    if (!nome || nome === atteso || visti.has(nome)) continue;
    if (normalizza(nome) !== bersaglio) continue;
    visti.add(nome);
    fuori.push(nome);
  }
  return fuori;
}

/** Tag noti a git: quelli locali più quelli su `origin` (se raggiungibile). */
function elencoTag() {
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: RADICE, encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout || '');
  };

  const locali = git(['tag', '--list']);
  if (locali === null) return { tag: [], avviso: 'git non disponibile: controllo dei tag doppi saltato' };

  const elenco = locali.split('\n').map((s) => s.trim()).filter(Boolean);

  // Il remoto può non rispondere (rete, credenziali): non è un motivo per
  // fermare una pubblicazione, ma va detto — il controllo resta parziale.
  const remoti = git(['ls-remote', '--tags', 'origin']);
  if (remoti === null) {
    return { tag: elenco, avviso: 'impossibile leggere i tag di origin: controllati solo quelli locali' };
  }
  for (const riga of remoti.split('\n')) {
    const m = /refs\/tags\/(.+?)(\^\{\})?$/.exec(riga.trim());
    if (m) elenco.push(m[1]);
  }
  return { tag: elenco, avviso: null };
}

/** Ferma la pubblicazione se esistono tag doppi per la versione in uscita. */
function verificaTag(versione) {
  if (['1', 'on', 'true', 'si', 'sì', 'yes'].includes(String(process.env.CODEDB_RELEASE_IGNORA_TAG || '').trim().toLowerCase())) {
    console.warn('[pubblica] controllo dei tag doppi disattivato da CODEDB_RELEASE_IGNORA_TAG');
    return;
  }

  const { tag, avviso } = elencoTag();
  if (avviso) console.warn(`[pubblica] ${avviso}`);

  const scelto = process.env.GITHUB_REF?.startsWith('refs/tags/') ? process.env.GITHUB_REF.slice(10) : tagDiRilascio(versione);
  const doppi = tag.filter(t => t !== scelto && t.replace(/^v/i, '').toLowerCase() === versione.toLowerCase());
  if (doppi.length === 0) return;

  const atteso = scelto;
  console.error(`\n[pubblica] INTERROTTO: esiste già un tag doppio per la versione ${versione}.\n`);
  console.error(`  Trovati: ${doppi.join(', ')}`);
  console.error(`  Atteso:  ${atteso} (tag scelto per la bozza finale)\n`);
  console.error('  Il feed https://github.com/…/releases.atom elenca anche i tag SENZA release:');
  console.error('  il tag doppio vi comparirebbe per primo ed electron-updater cercherebbe');
  console.error(`  latest.yml sotto /releases/download/${doppi[0]}/, dove non c'è nulla → 404\n`);
  console.error('  Rimuovili prima di pubblicare:');
  for (const t of doppi) console.error(`    git tag -d "${t}" && git push origin --delete "${t}"`);
  console.error('\n  (CODEDB_RELEASE_IGNORA_TAG=1 salta questo controllo.)\n');
  process.exit(3);
}

function main() {
  const piattaforma = String(process.argv[2] || '').trim();
  const flag = PIATTAFORME[piattaforma];
  if (!flag) {
    console.error(`Uso: node tools/pubblica.js ${Object.keys(PIATTAFORME).join('|')}`);
    process.exit(2);
  }

  const { version } = require(path.join(RADICE, 'package.json'));
  require('./firma.cjs').valida(piattaforma, process.env, true);
  verificaTag(version); // prima di electron-builder/cli.js, invocato da build-release.cjs
  const pre = require('./firma.cjs').versione(version).prerelease;

  console.log(`[pubblica] CodeDB ${version} → ${pre ? 'PRE-RELEASE' : 'release stabile'} da raccogliere nella bozza`);
  if (pre) {
    console.log('[pubblica] la riceverà solo chi ha una versione di prova installata '
      + 'o ha impostato CODEDB_UPDATE_PRERELEASE=1');
  }

  // Nessun token GitHub viene passato al builder e nessun asset è caricato qui.
  require('./build-release.cjs').main([piattaforma, '--release']);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}

module.exports = { versioneDiPreRelease, preRelease, tagDiRilascio, tagDuplicati };

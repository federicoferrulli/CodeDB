'use strict';

/* ---------------------------------------------------------------------------
 * Pubblicazione di una release su GitHub (electron-builder --publish always),
 * con il TIPO di release deciso dalla VERSIONE invece che a mano.
 *
 * Perché esiste. `build.publish[0].releaseType` in package.json è un valore
 * fisso: con `release` ogni pacchetto caricato diventa la release corrente del
 * repository, cioè la `/releases/latest` — e `electron-updater`, per chi NON ha
 * chiesto le pre-release, guarda esattamente quella. Pubblicare `0.2.0-beta.1`
 * con quel valore significa quindi offrire una beta a tutti gli utenti della
 * versione stabile: nessun errore visibile in fase di build, nessun modo di
 * accorgersene se non dalle segnalazioni. L'alternativa — ricordarsi di
 * cambiare `releaseType` a ogni cambio di versione e di rimetterlo a posto
 * dopo — è la classica cosa che si dimentica proprio alla release importante.
 *
 * Qui la regola è una sola e deriva dalla sola fonte di verità che c'è già: se
 * `package.json` → `version` contiene una componente di pre-release
 * (`-beta.1`, `-b`, `-rc.2`), la release viene marcata come **prerelease** su
 * GitHub tramite `EP_PRE_RELEASE`, che ha la precedenza su `releaseType` nel
 * publisher di electron-builder. È la METÀ SERVER del canale beta: l'altra sta
 * in `electron-aggiornamenti.js` (`permettePreRelease`), che decide chi quelle
 * beta le riceve. Senza questa metà, la scelta lato client non protegge nessuno.
 *
 * Uso:  node tools/pubblica.js win|mac|linux
 * Env:  CODEDB_RELEASE_PRERELEASE=1|0 forza il tipo (per un rilascio fuori
 *       regola: una stabile pubblicata come prova, o una beta pubblicata come
 *       definitiva). `EP_DRAFT=1` continua a valere e vince su tutto, come da
 *       electron-builder.
 * ------------------------------------------------------------------------- */

const { spawnSync } = require('child_process');
const path = require('path');

const RADICE = path.join(__dirname, '..');
const PIATTAFORME = { win: '--win', mac: '--mac', linux: '--linux' };

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

function main() {
  const piattaforma = String(process.argv[2] || '').trim();
  const flag = PIATTAFORME[piattaforma];
  if (!flag) {
    console.error(`Uso: node tools/pubblica.js ${Object.keys(PIATTAFORME).join('|')}`);
    process.exit(2);
  }

  const { version } = require(path.join(RADICE, 'package.json'));
  const pre = preRelease(process.env, version);

  console.log(`[pubblica] CodeDB ${version} → ${pre ? 'PRE-RELEASE' : 'release stabile'} su GitHub`);
  if (pre) {
    console.log('[pubblica] la riceverà solo chi ha una versione di prova installata '
      + 'o ha impostato CODEDB_UPDATE_PRERELEASE=1');
  }

  const cli = require.resolve('electron-builder/cli.js');
  const r = spawnSync(process.execPath, [cli, flag, '--publish', 'always'], {
    stdio: 'inherit',
    cwd: RADICE,
    env: { ...process.env, ...(pre ? { EP_PRE_RELEASE: 'true' } : {}) }
  });
  if (r.error) {
    console.error(`[pubblica] impossibile eseguire electron-builder: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status === null ? 1 : r.status);
}

if (require.main === module) main();

module.exports = { versioneDiPreRelease, preRelease };

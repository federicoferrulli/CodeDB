'use strict';

/* ---------------------------------------------------------------------------
 * Costruisce i pacchetti Linux (AppImage + .deb) DA WINDOWS, dentro un
 * container Linux.
 *
 * Perché serve: `npm run build:linux` su Windows fallisce, e per due motivi
 * distinti che non si risolvono nello stesso modo.
 *
 *  1. AppImage — `EPERM: operation not permitted, symlink`. La struttura di un
 *     AppImage contiene collegamenti simbolici, e Windows non li concede a un
 *     processo non privilegiato: servirebbe la Modalità sviluppatore o un
 *     terminale da amministratore. È una modifica alla macchina di chi
 *     costruisce, non al progetto.
 *  2. .deb — richiede `fpm`, che su Windows non è disponibile affatto.
 *
 * Dentro un container Linux non esiste nessuno dei due problemi. Si monta il
 * repository e si esegue lì la stessa `npm run build:linux`, con le cache di
 * Electron e di electron-builder in un volume nominato: senza, ogni build
 * riscaricherebbe le decine di MB del runtime Electron.
 *
 * `node_modules` viene riusato dall'host: nessuna dipendenza di CodeDB è
 * nativa (è la stessa ragione per cui `npmRebuild: false` è obbligatorio, vedi
 * CLAUDE.md), quindi i moduli installati su Windows funzionano nel container.
 *
 * Uso: npm run build:linux:docker   (aggiungi -- --publish always per pubblicare)
 * ------------------------------------------------------------------------- */

const { spawnSync } = require('child_process');
const path = require('path');

const RADICE = path.join(__dirname, '..');
const IMMAGINE = process.env.CODEDB_BUILDER_IMAGE || 'electronuserland/builder:latest';
const VOLUME_CACHE = 'codedb-electron-builder-cache';

function docker(args, opts) {
  return spawnSync('docker', args, { stdio: 'inherit', shell: false, ...opts });
}

// Docker vuole percorsi in stile POSIX anche quando gli arriva un path Windows.
function montaggio(p) {
  return p.replace(/\\/g, '/');
}

const passati = process.argv.slice(2).join(' ');
const comando = `npm run build:linux${passati ? ` -- ${passati}` : ''}`;

const check = spawnSync('docker', ['info', '--format', '{{.OSType}}'], { encoding: 'utf8' });
if (check.status !== 0) {
  console.error('Docker non è raggiungibile. Avvia Docker Desktop (o installalo) e riprova.\n'
    + 'In alternativa costruisci i pacchetti Linux su una macchina Linux, oppure attiva la\n'
    + 'Modalità sviluppatore di Windows (Impostazioni → Sistema → Per sviluppatori) per\n'
    + 'concedere la creazione dei collegamenti simbolici che l\'AppImage richiede.');
  process.exit(1);
}
if (!/linux/i.test(check.stdout || '')) {
  console.error(`Docker sta usando container ${(check.stdout || '').trim() || 'non Linux'}: `
    + 'passa ai container Linux (menu di Docker Desktop → "Switch to Linux containers").');
  process.exit(1);
}

console.log(`Costruzione dei pacchetti Linux in ${IMMAGINE}…`);
console.log('(la prima esecuzione scarica l\'immagine del builder: circa 2 GB)\n');

const res = docker([
  'run', '--rm',
  '-v', `${montaggio(RADICE)}:/project`,
  '-v', `${VOLUME_CACHE}:/root/.cache`,
  '-w', '/project',
  IMMAGINE,
  '/bin/bash', '-lc', comando,
]);

if (res.error) {
  console.error(`Avvio di Docker non riuscito: ${res.error.message}`);
  process.exit(1);
}
if (res.status !== 0) {
  console.error('\nLa build Linux nel container è fallita (vedi il log qui sopra).');
  process.exit(res.status || 1);
}
console.log('\nFatto: i pacchetti Linux sono in dist/.');

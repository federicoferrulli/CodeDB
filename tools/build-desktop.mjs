// Pacchettizza l'app desktop CodeDB (Electron) con @electron/packager.
// Uso: node tools/build-desktop.mjs [win32|darwin|linux] (default: piattaforma corrente)
//
// Perché non electron-builder: electron-builder scarica sempre il pacchetto
// "winCodeSign" (contiene rcedit/signtool) anche per build Windows non firmate,
// e la sua estrazione crea due symlink (librerie macOS) che su Windows falliscono
// senza Developer Mode attiva o una shell da amministratore (SeCreateSymbolicLinkPrivilege).
// @electron/packager imposta icona/versione dell'exe con "resedit" (puro JS, incluso
// nelle sue dipendenze), senza scaricare né estrarre nulla: nessun problema di privilegi.
import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// L'elenco delle esclusioni è CommonJS perché lo legge anche npm test: qui si
// carica con createRequire invece di duplicarlo in forma ESM.
const { regexPackager } = createRequire(import.meta.url)('./esclusioni-distribuzione.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const platform = process.argv[2] || process.platform;
const ICON = {
  win32: path.join(ROOT, 'build', 'icon.ico'),
  darwin: path.join(ROOT, 'public', 'codedb.png'),
  linux: path.join(ROOT, 'public', 'codedb.png'),
}[platform];

// Le esclusioni vengono da un elenco UNICO condiviso con electron-builder
// (tools/esclusioni-distribuzione.js): erano due liste indipendenti, e nessuna
// delle due escludeva vault.json e il registro dei marcatori di provenienza.
const IGNORE = regexPackager();


async function main() {
  console.log(`Pacchettizzazione CodeDB per ${platform}...`);
  const appPaths = await packager({
    dir: ROOT,
    out: path.join(ROOT, 'dist'),
    name: 'CodeDB',
    platform,
    arch: 'x64',
    icon: ICON,
    appCopyright: 'Copyright (c) 2026 CodeDB',
    executableName: 'CodeDB',
    overwrite: true,
    prune: true,
    ignore: IGNORE,
    win32metadata: platform === 'win32' ? {
      CompanyName: "Federico 'Keus' Ferrulli",
      FileDescription: 'CodeDB — GUI web stile DBeaver per MongoDB e MySQL',
      ProductName: 'CodeDB',
      InternalName: 'CodeDB',
    } : undefined,
  });

  for (const appPath of appPaths) {
    console.log(`Creato: ${appPath}`);
    if (platform === 'win32' || platform === 'linux') {
      const zipPath = `${appPath}.zip`;
      try {
        execFileSync('powershell', [
          '-NoProfile', '-Command',
          `Compress-Archive -Path '${appPath}\\*' -DestinationPath '${zipPath}' -Force`,
        ], { stdio: 'inherit' });
        console.log(`Archivio: ${zipPath}`);
      } catch (err) {
        console.warn(`Impossibile creare lo zip automaticamente (${err.message}); cartella pronta comunque: ${appPath}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

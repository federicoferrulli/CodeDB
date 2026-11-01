'use strict';
// Il checkout è in sola lettura: dipendenze native e sorgenti di build vivono nel container.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const image = process.env.CODEDB_BUILDER_IMAGE || 'electronuserland/builder:latest';
if (process.argv.length > 2) throw new Error('La build Docker produce solo artefatti locali. Per la bozza usa il workflow di release.');
const check = spawnSync('docker', ['info', '--format', '{{.OSType}}'], { encoding: 'utf8' });
if (check.status !== 0 || check.stdout.trim() !== 'linux') throw new Error('Avvia Docker con container Linux prima di costruire.');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const run = spawnSync('docker', ['run', '--rm',
  '--mount', `type=bind,source=${root},target=/source,readonly`,
  '--mount', `type=bind,source=${path.join(root, 'dist')},target=/output`,
  '--mount', 'type=volume,source=codedb-electron-builder-cache,target=/root/.cache',
  image, '/bin/bash', '-lc', `set -euo pipefail
    mkdir -p /project
    cp -a /source/{package.json,package-lock.json,server.js,electron-main.js,electron-aggiornamenti.js,electron-server-auth.js,electron-chiusura.js,LICENSE.md,EULA.md,MANLEVA.md,auth,backup,bin,db,mcp,server,public,ui,tools,build} /project/
    cd /project
    npm ci
    npm run build:linux
    rpm -K dist/*.rpm
    rpm -qp --queryformat '%{NAME} %{VERSION} %{ARCH}\\n' dist/*.rpm
    dpkg-deb --info dist/*.deb
    node tools/release-assets.cjs stage dist staged/linux linux
    cp staged/linux/* /output/
  `], { stdio: 'inherit', windowsHide: true });
if (run.error || run.status !== 0) throw new Error('Build Linux nel container fallita; nessun pacchetto dichiarato pronto.');
console.log('AppImage, DEB, RPM e metadati verificati in dist/.');

'use strict';

// La copia vive nel volume Docker: nessun test storico può scrivere nel checkout.
const fs = require('node:fs');
const path = require('node:path');
const { verifica } = require('./percorsi.cjs');
if (process.env.CODEDB_LAB_CONTAINER !== '1' || !fs.existsSync('/.dockerenv')) {
  throw new Error('Preparazione consentita solo nel container del laboratorio.');
}
require('./lock.cjs').assicuratiLibero();
const source = '/sorgente', target = '/laboratorio/repo';
verifica('/laboratorio', target);
fs.mkdirSync(target, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(source, '.lab-files.json'), 'utf8'));
const previousFile = '/laboratorio/file-copiati.json';
const previous = fs.existsSync(previousFile) ? JSON.parse(fs.readFileSync(previousFile, 'utf8')).files : [];
function sicuro(relative) {
  const resolved = path.resolve(target, relative);
  if (/^node_modules(?:[\\/]|$)/.test(relative)) throw new Error('Percorso sorgente non valido: ' + relative);
  return verifica(target, resolved);
}
for (const relative of previous.filter(f => !manifest.files.includes(f))) {
  fs.rmSync(sicuro(relative), { force: true });
}
for (const relative of manifest.files) {
  const src = path.join(source, relative), dst = path.join(target, relative);
  sicuro(relative);
  verifica(source, src);
  if (!fs.lstatSync(src).isFile()) throw new Error('Sorgente non regolare: ' + relative);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
fs.writeFileSync(previousFile, JSON.stringify(manifest, null, 2));
console.log('Copia isolata aggiornata in ' + target);

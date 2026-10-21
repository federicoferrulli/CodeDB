'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Controlla anche gli antenati: un percorso lessicalmente interno può attraversare
// una junction Windows o un link simbolico e raggiungere un'altra directory.
function verifica(root, target, allowRoot = false) {
  root = path.resolve(root); target = path.resolve(target);
  const relative = path.relative(root, target);
  if ((!relative && !allowRoot) || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Percorso fuori dalla directory consentita: ' + target);
  }
  let cursor = path.parse(target).root;
  for (const part of target.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Link o junction non consentito: ' + cursor);
    } catch (err) { if (err.code === 'ENOENT') break; throw err; }
  }
  if (fs.existsSync(root)) {
    const actualRoot = fs.realpathSync(root);
    let existing = target;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    if (existing === root || existing.startsWith(root + path.sep)) {
      const resolved = path.relative(actualRoot, fs.realpathSync(existing));
      if (resolved === '..' || resolved.startsWith('..' + path.sep) || path.isAbsolute(resolved)) throw new Error('Destinazione reale fuori directory: ' + target);
    }
  }
  return target;
}
module.exports = { verifica };

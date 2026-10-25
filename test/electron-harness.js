'use strict';
// Il runner Docker usa root in un container di prova isolato. Il flag riguarda
// soltanto l'eseguibile della fixture, mai l'app distribuita o il desktop host.
function argomentiElectron(args) {
  const containerRoot = process.platform === 'linux' && process.env.CODEDB_LAB_CONTAINER === '1'
    && process.getuid?.() === 0 && require('node:fs').existsSync('/.dockerenv');
  return containerRoot ? [...args, '--no-sandbox'] : args;
}
module.exports = { argomentiElectron };

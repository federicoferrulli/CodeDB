'use strict';
// Il catalogo segue la stessa versione dei helper effettivamente eseguiti.
const fs = require('node:fs');
const path = require('node:path');
const { signatures } = require('@mongosh/shell-api');
const catalogo = Object.fromEntries(Object.entries(signatures).map(([name, spec]) => [name,
  Object.keys(spec.attributes || {}).filter(key => !key.startsWith('_')).sort()]));
fs.writeFileSync(path.join(__dirname, '../public/js/mongosh-catalogo.mjs'),
  '// Generato da tools/aggiorna-mongosh.cjs usando @mongosh/shell-api.\nexport default ' + JSON.stringify(catalogo, null, 2) + ';\n');

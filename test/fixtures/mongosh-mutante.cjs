'use strict';
// Mutazioni solo in memoria, nei processi di prova: i sorgenti restano intatti.
const fs = require('node:fs');
const Module = require('node:module');
const original = Module._extensions['.js'];
const mutations = {
  persistenza: ['server/query.js', 'if (!session.mongosh || session.mongosh.closed)', 'if ((await session.mongosh?.close(), true))'],
  stream: ['db/mongoshProcesso.cjs', 'while (!f.chiuso && !cursor.isClosed())', 'while (false)'],
  permessi: ['db/mongoshRuntime.js', 'if (!isInstallAdmin(session.principal, env))', 'if (false)'],
  bson: ['db/mongoshProcesso.cjs', 'Number.isFinite(Number(v.$numberInt ?? v.$numberDouble))', 'true'],
  crittografia: ['db/mongoshProcesso.cjs', 'getCryptLibraryOptions: () => ({', 'getCryptLibraryOptions: () => ({}), ignorato: () => ({'],
};
const mutation = mutations[process.env.CODEDB_TEST_MONGOSH_MUTANT];
if (process.env.CODEDB_TEST_MONGOSH_MUTANT === 'nativi') {
  const load=Module._load;
  Module._load=function(name,...args) {
    if (['kerberos','mongodb-client-encryption'].includes(name)) throw new Error('Modulo nativo mancante (mutazione di prova)');
    return load.call(this,name,...args);
  };
}
if (mutation) Module._extensions['.js'] = function(mod, filename) {
  if (!filename.replaceAll('\\','/').endsWith('/' + mutation[0])) return original(mod, filename);
  const source = fs.readFileSync(filename, 'utf8');
  if (!source.includes(mutation[1])) throw new Error('Mutazione mongosh non applicabile');
  mod._compile(source.replace(mutation[1], mutation[2]), filename);
};

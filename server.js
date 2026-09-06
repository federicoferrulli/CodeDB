/**
 * CodeDB
 * Copyright (c) 2026 Federico Ferrulli
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */
'use strict';

const { createServer } = require('./server/createServer');
const { creaProcesso } = require('./server/processo');
let predefinito;
function instance() { return predefinito ||= createServer(); }
const processo = creaProcesso(instance);

// Compatibilità con Electron e con i chiamanti storici. Il caricamento è inerte.
function startServer() {
  const srv = instance();
  // Il segreto è già nella configurazione privata: non ereditarlo nei processi figli.
  delete process.env.CODEDB_ELECTRON_INSTANCE_SECRET;
  return srv.start();
}
async function runCli() {
  processo.registerGlobalExceptionHandlers();
  try { await startServer(); }
  catch (err) {
    console.error('Impossibile avviare CodeDB:', err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  createServer, startServer, runCli,
  get app() { return instance().app; },
  get server() { return instance().server; },
  get io() { return instance().io; },
  stop: () => predefinito ? predefinito.stop() : Promise.resolve(),
  executeQueryCode: (...args) => instance().executeQueryCode(...args),
  registraEventi: (...args) => instance().registraEventi(...args),
  creaContestoSocket: (...args) => instance().creaContestoSocket(...args),
  makeConnectLocks: (...args) => require('./server/lock').createModule({}).makeConnectLocks(...args),
  ...processo,
};

if (require.main === module) runCli();

'use strict';

// Secondo processo client: rappresenta un'altra istanza Electron che ha
// ricevuto dall'orchestratore la stessa identità del server già in ascolto.
const { probeServer } = require('../electron-server-auth');

probeServer({
  port: Number(process.env.CODEDB_TEST_SERVER_PORT),
  secret: process.env.CODEDB_ELECTRON_INSTANCE_SECRET,
}).then((ok) => process.exit(ok ? 0 : 1), () => process.exit(1));

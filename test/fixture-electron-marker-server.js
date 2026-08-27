'use strict';

// Processo estraneo usato dal test di autenticazione Electron: imita soltanto
// il vecchio marker pubblico e non conosce il segreto dell'istanza.
const http = require('http');
const port = Number(process.env.CODEDB_TEST_MARKER_PORT);
const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, app: 'codedb' }));
});
server.listen(port, '127.0.0.1', () => process.stdout.write('READY\n'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

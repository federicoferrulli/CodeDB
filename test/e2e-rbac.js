'use strict';

// Test end-to-end dell'RBAC multi-utente via Socket.IO.
// Avvia da sé un'istanza di CodeDB con CODEDB_RBAC=on (vedi rbac-harness.js).
// Richiede un MongoDB locale su :27017 (control plane + database di prova).
// Uso: node test/e2e-rbac.js

const { io } = require('socket.io-client');
const {
  BASE, DATA_DB, CONN_NAME, OTHER_CONN, OWNER, VIEWER,
  assert, startRbacServer, stopRbacServer, seedData, cleanupMongo, login,
} = require('./rbac-harness');

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload || {}, resolve));
}

// Apre un socket autenticato col token indicato (o senza token).
function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: token ? { token } : {}, reconnection: false, forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

(async () => {
  let server = null;
  let ownerSock = null;
  let viewerSock = null;
  try {
    await cleanupMongo();
    await seedData();

    console.log('1. avvio del server con RBAC attivo (maxSubUsers=1)');
    server = await startRbacServer({ maxSubUsers: 1 });

    console.log('2. handshake senza token');
    let refused = false;
    try {
      await connect(null);
    } catch (err) {
      refused = err && err.message === 'auth_required';
    }
    assert(refused, 'socket senza token rifiutato con "auth_required"');

    console.log('3. login owner');
    const badLogin = await login(OWNER.email, 'password-sbagliata');
    assert(badLogin.status === 401 && !badLogin.ok, 'password errata → 401');
    const ownerLogin = await login(OWNER.email, OWNER.password);
    assert(ownerLogin.ok && !!ownerLogin.token, 'owner autenticato, token emesso');
    assert(ownerLogin.user && ownerLogin.user.owner === true, 'l\'owner è riconosciuto come amministratore');

    ownerSock = await connect(ownerLogin.token);
    assert(ownerSock.connected, 'socket dell\'owner connesso col token');

    console.log('4. creazione sottoutente e assegnazione permessi');
    const created = await emit(ownerSock, 'users:create', {
      email: VIEWER.email, password: VIEWER.password, displayName: 'Viewer E2E',
    });
    assert(created.ok, `sottoutente creato (${created.ok ? created.user.email : created.error})`);

    const grant = await emit(ownerSock, 'grants:set', {
      subjectId: created.user.id,
      connName: CONN_NAME,
      role: 'viewer',
      scope: { databases: [DATA_DB], collections: ['orders*'] },
    });
    assert(grant.ok, `grant viewer su "${CONN_NAME}" con scope orders* (${grant.ok ? 'ok' : grant.error})`);

    const badGrant = await emit(ownerSock, 'grants:set', {
      subjectId: created.user.id, connName: 'connessione-inesistente', role: 'viewer',
    });
    assert(!badGrant.ok, 'grant su una connessione inesistente rifiutato');

    console.log('5. limite del piano');
    const second = await emit(ownerSock, 'users:create', { email: 'altro@e2e.local', password: 'altra-password-1' });
    assert(!second.ok && /piano/i.test(second.error || ''), `secondo sottoutente rifiutato (${second.error})`);

    console.log('6. accesso del sottoutente');
    const viewerLogin = await login(VIEWER.email, VIEWER.password);
    assert(viewerLogin.ok && !!viewerLogin.token, 'sottoutente autenticato');
    viewerSock = await connect(viewerLogin.token);

    const list = await emit(viewerSock, 'connections:list');
    assert(list.ok && list.connections.length === 1 && list.connections[0].name === CONN_NAME,
      `connections:list mostra solo la connessione concessa (${list.ok ? list.connections.map((c) => c.name).join(', ') : list.error})`);

    const denied = await emit(viewerSock, 'mongo:connect', { saved: OTHER_CONN, tabId: 'x' });
    assert(!denied.ok, `connessione senza grant rifiutata (${denied.error})`);

    const conn = await emit(viewerSock, 'mongo:connect', { saved: CONN_NAME, tabId: 't1' });
    assert(conn.ok, `connessione concessa aperta (${conn.ok ? conn.dbType : conn.error})`);

    console.log('7. permessi su database e collezioni');
    const dbs = await emit(viewerSock, 'db:list', { tabId: 't1' });
    assert(dbs.ok && dbs.databases.every((d) => d.name === DATA_DB),
      `db:list filtrato dallo scope (${dbs.ok ? dbs.databases.map((d) => d.name).join(', ') : dbs.error})`);

    const colls = await emit(viewerSock, 'db:collections', { tabId: 't1', db: DATA_DB });
    const names = colls.ok ? colls.collections.map((c) => c.name) : [];
    assert(colls.ok && names.includes('orders') && !names.includes('customers'),
      `db:collections mostra orders ma non customers (${names.join(', ') || colls.error})`);

    const find = await emit(viewerSock, 'collection:find', { tabId: 't1', db: DATA_DB, coll: 'orders', filter: '' });
    assert(find.ok && find.docs.length === 2, `lettura di orders consentita (${find.ok ? find.docs.length + ' doc' : find.error})`);

    const findOut = await emit(viewerSock, 'collection:find', { tabId: 't1', db: DATA_DB, coll: 'customers', filter: '' });
    assert(!findOut.ok && /permesso negato/i.test(findOut.error || ''),
      `lettura fuori scope negata (${findOut.error})`);

    const insert = await emit(viewerSock, 'doc:insert', { tabId: 't1', db: DATA_DB, coll: 'orders', doc: '{ "code": "X" }' });
    assert(!insert.ok && /permesso negato/i.test(insert.error || ''), `scrittura negata al viewer (${insert.error})`);

    const drop = await emit(viewerSock, 'collection:drop', { tabId: 't1', db: DATA_DB, coll: 'orders' });
    assert(!drop.ok, `DDL negato al viewer (${drop.error})`);

    const query = await emit(viewerSock, 'query:execute', { tabId: 't1', db: DATA_DB, coll: 'customers', code: '{}' });
    assert(!query.ok && /permesso negato/i.test(query.error || ''),
      `Query Engine fuori scope negato (${query.error})`);

    console.log('8. operazioni riservate all\'amministratore');
    const save = await emit(viewerSock, 'connections:save', { name: 'nuova', cfg: { dbType: 'mongodb', host: 'localhost' } });
    assert(!save.ok, `salvataggio connessione negato al viewer (${save.error})`);

    const users = await emit(viewerSock, 'users:list');
    assert(!users.ok, `gestione utenti negata al viewer (${users.error})`);

    console.log('9. l\'owner non è soggetto agli scope');
    const ownerConn = await emit(ownerSock, 'mongo:connect', { saved: CONN_NAME, tabId: 'o1' });
    assert(ownerConn.ok, 'owner connesso');
    const ownerFind = await emit(ownerSock, 'collection:find', { tabId: 'o1', db: DATA_DB, coll: 'customers', filter: '' });
    assert(ownerFind.ok && ownerFind.docs.length === 1, `l'owner legge anche customers (${ownerFind.ok ? 'ok' : ownerFind.error})`);
    const ownerInsert = await emit(ownerSock, 'doc:insert', { tabId: 'o1', db: DATA_DB, coll: 'orders', doc: '{ "code": "B-1" }' });
    assert(ownerInsert.ok, `l'owner può scrivere (${ownerInsert.ok ? 'ok' : ownerInsert.error})`);

    console.log('10. revoca');
    const revoked = await emit(ownerSock, 'grants:revoke', { subjectId: created.user.id, connName: CONN_NAME });
    assert(revoked.ok && revoked.deleted === 1, 'grant revocato');
    const afterRevoke = await login(VIEWER.email, VIEWER.password);
    const sock3 = await connect(afterRevoke.token);
    const listAfter = await emit(sock3, 'connections:list');
    assert(listAfter.ok && listAfter.connections.length === 0, 'dopo la revoca il sottoutente non vede più connessioni');
    sock3.close();

    console.log('11. sospensione: il socket GIÀ aperto viene chiuso (CDB-A13)');
    // Il principal era risolto una sola volta nell'handshake: sospendere un
    // utente cancellava la riga della sessione ma non toccava la scheda già
    // aperta, che continuava a leggere e scrivere con i permessi di prima —
    // e Socket.IO si riconnette da sé, quindi poteva durare giorni.
    const riLogin = await login(VIEWER.email, VIEWER.password);
    const sockVivo = await connect(riLogin.token);
    assert(sockVivo.connected, 'il sottoutente ha di nuovo un socket aperto');
    const chiuso = new Promise((resolve) => sockVivo.once('disconnect', () => resolve(true)));
    const sospeso = await emit(ownerSock, 'users:update', { id: created.user.id, status: 'suspended' });
    assert(sospeso.ok, 'sottoutente sospeso');
    const esito = await Promise.race([
      chiuso,
      new Promise((resolve) => setTimeout(() => resolve(false), 4000)),
    ]);
    assert(esito === true, 'la sospensione chiude subito il socket già connesso');
    sockVivo.close();

    // E il token non serve più nemmeno per una connessione nuova.
    let respinto = false;
    try {
      const s = await connect(riLogin.token);
      s.close();
    } catch (err) {
      respinto = err && err.message === 'auth_required';
    }
    assert(respinto, 'dopo la sospensione il token non apre più alcun socket');

    console.log('12. revoca che NON passa da questa istanza: la ri-validazione la coglie');
    // La chiusura attiva copre le revoche fatte da qui. Una revoca arrivata da
    // un'altra istanza, dalla CLI o direttamente sul control plane no: la
    // seconda rete è la ri-validazione periodica del principal, che qui si
    // simula con /auth/logout (cancella la riga della sessione senza toccare i
    // socket). Con la finestra dell'harness a 200 ms non serve attendere.
    await emit(ownerSock, 'users:update', { id: created.user.id, status: 'active' });
    const login2 = await login(VIEWER.email, VIEWER.password);
    const sockOrfano = await connect(login2.token);
    const primaOk = await emit(sockOrfano, 'connections:list');
    assert(primaOk.ok, 'il socket funziona finché la sessione esiste');
    const risp = await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: login2.token }),
    });
    assert(risp.ok, 'sessione cancellata nel control plane, senza toccare i socket');
    await new Promise((r) => setTimeout(r, 300)); // oltre la finestra di ri-validazione
    const dopo = await emit(sockOrfano, 'connections:list');
    assert(dopo && dopo.ok === false && /non più valida/.test(dopo.error || ''),
      `l'evento successivo è rifiutato: ${JSON.stringify(dopo)}`);
    sockOrfano.close();

    console.log('\nTest RBAC completati.');
  } catch (err) {
    console.error('  FAIL errore inatteso:', err && err.message);
    process.exitCode = 1;
  } finally {
    if (ownerSock) ownerSock.close();
    if (viewerSock) viewerSock.close();
    await stopRbacServer(server);
    await cleanupMongo().catch(() => {});
  }
})();

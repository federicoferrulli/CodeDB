# Audit di sicurezza CodeDB — 2026-09-15

**Destinatario:** Keus
**Metodo:** analisi statica sul codice reale (nessun server avviato, nessun DB toccato, nessun vault reale manipolato). Ogni rilievo cita `file:riga` letto in sessione, con scenario di innesco concreto. Ciò che non è stato letto è dichiarato in fondo.
**Perimetro letto:** `server.js`, `server/*.js`, `auth/*.js`, `db/*.js` (strategie, filtro, identificatori, ScriptRunner, MongoScript/Shell, SqlToMql, VirtualJoinEngine, vault, sessioni, SshTunnel, backupRestoreAdapter, AuditLog, import*), `backup/lib/*.js` + `backup/cli.js`, `mcp/McpGateway.js`, `electron-main.js`, `electron-server-auth.js`, `public/js/*.js` (state, tabs, trasporto, grid, query-tab, details, utils, inlineEdit, fk-vista, geo-vista, graph3d, cellselect, connection, session-restore), `public/sw.js`, `Dockerfile`, `docker-compose.yml`, `package.json`, `.gitignore`, `SECURITY.md`.

---

## Rilievi ALTA severità

### A1. Bypass dello scope database omettendo `db` dal payload

📌 **Modulo:** `auth/capabilities.js` + `auth/guardStrategy.js`
**Riferimento:** `auth/capabilities.js:584-589`, `auth/guardStrategy.js:244-245`, `auth/permissions.js:33-34,52-53`

⚠️ **Problema:**
```js
// capabilities.js:586
if (value === undefined) return true;             // operazione senza bersaglio
if (value === null || value === '') return false; // bersaglio atteso ma mancante
```
```js
// guardStrategy.js:244-245
const db = spec.db != null ? args[spec.db] : undefined;
const coll = spec.coll != null ? args[spec.coll] : undefined;
```
`null` e `''` sono negati (fix precedente documentato nel commento `575-578`), ma `undefined` — cioè **chiave assente nel payload** — passa. Il Proxy inoltra `db: undefined` a `can()`, che salta il confronto con lo scope.

🧪 **Scenario:** grant `scope: { databases: ['app'] }`. Il client emette `collection:find` con `{ tabId, coll: 'utenti' }` senza `db`. `can()` passa. La strategia risolve poi un default fuori scope:
- PostgreSQL `schemaOf(undefined)` → `'public'` (`db/PostgreSqlStrategy.js:73-76`);
- MongoDB `client.db(undefined)` → DB dalla connection string / `test` (`db/MongoDbStrategy.js:36-54` + driver);
- MySQL `qtable(undefined, t)` → tabella non qualificata, cade sul DB della connessione (`db/identificatori.js:125-131`).
Stessa radice per `listCollections`, `collection:count`, `collection:aggregate` e per `db/VirtualJoinEngine.js:72,123` (inoltra `sourceA.db`/`sourceB.db` dal client). Prova su guard reale: `"altro"`→NEGATA, `null`→NEGATA, `""`→NEGATA, `undefined`→PASSATA.

🛠️ **Fix:** nel Proxy, se `spec.db != null` e `args[spec.db] == null`, rifiuta subito ("bersaglio atteso ma mancante") invece di passare `undefined` a `can()`. Nessun chiamante legittimo omette `db` (tutti i `delegate` inoltrano `p.db`).

### A2. `backup:restore` via socket ignora connessione e flag `readOnly`

📌 **Modulo:** `server/eventi-backup.js`
**Riferimento:** `server/eventi-backup.js:99-104`, confronto `mcp/McpGateway.js:1714-1721`

⚠️ **Problema:**
```js
lifecycle.safeOn('backup:restore', async (payload, cb) => {
  ...
  identita.assertManage(socketContext.principal);
```
Nessun `assertWholeConnection(..., sess.connName, 'manage', ...)`, nessun `refreshWritesAllowed` / controllo `readOnly`. Il restore usa poi il driver nativo (`runRestoreViaPlan` → `runRestore`), fuori dal Proxy. Il canale MCP invece fa entrambi i controlli.

🧪 **Scenario:** owner con connessione `readOnly` (default) ripristina comunque via UI e sovrascrive il DB; via MCP la stessa operazione sarebbe rifiutata. È scrittura distruttiva con gate dimezzato.

🛠️ **Fix:** allineare al canale MCP: `assertWholeConnection(principal, sess.connName, 'manage')` + `refreshWritesAllowed(session, sess, deps)` prima di `runRestoreViaPlan`.

---

## Rilievi MEDIA severità

### M1. `group`/`backupId` con regex che accetta `..` (probing fuori radice tenant)

📌 **Modulo:** `server/eventi-backup.js`
**Riferimento:** `server/eventi-backup.js:109-115`, identico `186-193` (`backup:verify`)

⚠️ **Problema:**
```js
if (!/^[\w.-]+$/.test(group) || !/^[\w.-]+$/.test(backupId)) throw ...
backupDir = path.join(operazioni.backupRootOf(socketContext.principal), group, backupId);
```
`[\w.-]` accetta `.` e `..`. Nessun `path.relative` di confinamento dopo il join. Il canale MCP invece confina (`mcp/McpGateway.js:149-163` con `safeName` + `path.relative`).

🧪 **Scenario:** `group=".."`, `backupId=".."` → `path.join(root,"..","..")` esce dalla radice tenant; oggi si ferma solo al check `manifest.json` (`117-119`), non al confinamento. Con due segmenti non si raggiunge direttamente un altro tenant, ma è probing fuori radice + incoerenza fra canali.

🛠️ **Fix:** riusare `operazioni.resolveBackupPath()` anche per il ramo `group/backupId`, o `safeName(x)===x` + verifica `path.relative(root, p)` non inizi con `..`.

### M2. `backupRestoreAdapter` legge file dal manifest con `path.join` non confinato

📌 **Modulo:** `db/backupRestoreAdapter.js`
**Riferimento:** `db/backupRestoreAdapter.js:74-86`

⚠️ **Problema:**
```js
const absolute = path.join(layer.dir, file.path);
if (file.kind === 'objects') objects = EJSON.parse(fs.readFileSync(absolute, 'utf8'));
```
`file.path` viene dal `manifest.json` (input non fidato: backup importato). Il punto sicuro `fileDelBackup()` (`backup/lib/util.js:384-405`, `canonicalBackupPath` + doppio check su symlink) è usato da `restore.js` e `verifyBackupDir`, ma non qui.

🧪 **Scenario:** manifest malevolo con `path: "../../x"` → lettura fuori backup dir. Oggi mitigato perché `validatePlan` chiama `preflightChain` (boccia `INVALID_PATH` prima di `apply`), ma ogni riuso diretto di questo seam resta insicuro.

🛠️ **Fix:** risolvere ogni `file.path` tramite `fileDelBackup()` / `canonicalBackupPath()` invece di `path.join` diretto.

### M3. Backup con sola capability `read` scrive illimitatamente su filesystem (riempimento disco)

📌 **Modulo:** `server/eventi-backup.js`, `mcp/McpGateway.js`
**Riferimento:** `server/eventi-backup.js:26`, `mcp/McpGateway.js:1599`

⚠️ **Problema:** il backup è autorizzato con sola `read` su intera connessione, ma poi scrive gruppo/catalogo/dati + `backup.log` su disco. Solo lo storage remoto pretende `manage` (corretto). Nessuna quota numero/dimensione sul backup, a differenza degli upload (`db/importUploads.js:7-13` con `maxBytes/maxActive/maxTotalBytes`).

🧪 **Scenario:** principal/API key con sola `read` lancia `backup_database` full ripetuti → riempimento disco sotto la propria root tenant. Scelta di design, ma è scrittura con capability di lettura.

🛠️ **Fix:** quota numero/dimensione per tenant sui backup locali (come per gli upload), oppure capability dedicata `backup` distinta da `read`.

### M4. Voci audit MCP senza `ownerId`/`userId` — invisibili al filtro tenant

📌 **Modulo:** `mcp/McpGateway.js`, `db/AuditLog.js`
**Riferimento:** `mcp/McpGateway.js:1364,1623,1731,1828` vs `1450-1453`; `db/AuditLog.js:135-136`, `server/eventi-monitoraggio.js:23-25`

⚠️ **Problema:**
```js
const auditBase = { sessionId: session.id, connection: sess.name, dbType: sess.dbType };
```
Solo `execute_ddl` aggiunge `ownerId/userId`. Con filtro `ownerId` le voci senza identità sono escluse (visibili solo a root).

🧪 **Scenario:** l'owner filtra lo Storico Azioni e non vede `execute_write`/`backup`/`restore`/`import` eseguiti dall'AI sulla propria connessione. Non è leak cross-tenant, è perdita di attribuzione (un bypass falsifica anche le tracce, qui per omissione).

🛠️ **Fix:** aggiungere `ownerId: principal.ownerId, userId: principal.id` a tutti gli `auditBase` MCP.

### M5. Race sulla modale "Crea indice" — indice creato sul tab sbagliato

📌 **Modulo:** `public/js/details.js`
**Riferimento:** `public/js/details.js:4`, `92-100`, `107-118`

⚠️ **Problema:** `let indexCreateContext = null` globale singolo. Apertura lo sovrascrive, salvataggio lo legge. È lo schema già corretto altrove (`queryDb`/`queryRunId` migrati per-tab in `tabs.js:39-110`), qui rimasto.

🧪 **Scenario:** apri "Crea indice" sul tab A → cambi tab, apri "Crea indice" sul tab B → Salva crea l'indice sul bersaglio dell'ultima apertura mentre l'utente conferma (mentalmente) la prima. Modale unica condivisa `#idxcreate-overlay`: una sola istanza visibile, contesto perso silenziosamente. DDL sul database sbagliato.

🛠️ **Fix:** catturare il contesto nel DOM della modale (dataset `tabId/db/coll` all'apertura) o coda per-tab invece di variabile di modulo; stesso pattern di `captureDetailsTarget` + `origin.isStillActive()` già usato per drop.

### M6. `POST /auth/logout` non chiude il socket — finestra ~30s

📌 **Modulo:** `server/identita.js`, `server/socket.js`
**Riferimento:** `server/identita.js:292-296`, `server/socket.js:97-105,197-201` (`REVALIDA_PRINCIPAL_MS = 30000`)

⚠️ **Problema:** il logout cancella la riga sessione ma non chiama `disconnettiSocketDi` (usato invece da `grants:set/revoke`, `users:update/delete`). Il socket resta valido fino alla successiva `rivalidaPrincipal`.

🧪 **Scenario:** logout su postazione condivisa con scheda lasciata aperta → per max ~30s il socket continua a leggere/scrivere con il principal in memoria. Finestra breve, serve socket già autenticato.

🛠️ **Fix:** chiamare `disconnettiSocketDi(token/userId)` nel logout, o `rivalidaPrincipal` immediata sul socket interessato.

---

## Rilievi BASSA severità / hardening

### B1. Virtual JOIN interpola le chiavi in SQL invece di parametrizzare
**Riferimento:** `db/VirtualJoinEngine.js:121-122`
```js
const escapedKeys = keysArray.map((k) => `'${String(k).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`).join(',');
const sql = `SELECT * FROM ${qid(typeB, tableName)} WHERE ${qid(typeB, on.rightKey)} IN (${escapedKeys}) LIMIT ${maxPayloadSize}`;
```
Chiavi dai dati (non direttamente dal client), escape `'`/`\` che regge, `tableName`/`rightKey` via `quotaSempre`, `LIMIT` cappato a 100.000 (`30-34,54`), SQL Raw negato agli scoped (`guardStrategy.js:394-406`). Non è injection sfruttabile oggi, ma è fragile: su PostgreSQL con `standard_conforming_strings=on` il raddoppio del backslash altera il valore (`a\b` non matcha) → JOIN incompleti silenziosi. **Fix:** `IN (...)` con segnaposto/params o riuso del filtro strutturato.

### B2. `displayValue` su `$binary` malformato rompe l'intero render griglia
**Riferimento:** `public/js/utils.js:47-59`, chiamanti `public/js/grid.js:694,906-912,943,982-988`
`atob(b64.slice(0,16))` senza `try/catch`. Documento ostile `{"$binary":{"base64":"!!!"}}` → eccezione in una cella → `renderGrid` interrotto, griglia vuota. Il ramo date ha già la guardia `isNaN` (`utils.js:33-36`): applicare lo stesso pattern. DoS locale a integrità zero ma disponibilità UI nulla sulla collection.

### B3. `/mcp` senza rate limit sui tentativi API key
**Riferimento:** `mcp/McpGateway.js:2135-2146` vs `server/identita.js:203-248`, `server/eventi-vault.js:32-39`
`authenticate` MCP senza `loginBlocked`/`noteLoginFailure`. Chiavi da 32 byte CSPRNG (`auth/sessions.js:44-47`, solo SHA-256 in DB) rendono il guessing impraticabile; resta enumerazione/lookup-DB illimitato a basso costo attaccante. **Fix:** stesso bucket IP del login.

### B4. `vault:reset` accetta passphrase vuota
**Riferimento:** `server/vault.js:354-357,381-391`, `server/eventi-vault.js:55-78,95-97`, `auth/permissions.js:124-131`
`vault:setPassphrase` rifiuta la vuota, `vault:reset` no (gate `assertInstallAdmin` + `confirm:true` presenti). Con RBAC off `isInstallAdmin` è sempre true, ma lì l'attaccante ha già ROOT: non è escalation, è irreversibilità operativa. **Fix:** stesso controllo lunghezza del set.

### B5. Dettagli minori (hardening)
- `esc()` copre `[&<>"]` ma non `'` (`public/js/utils.js:194-196`): tutti gli usi verificati sono in attributi a doppi apici, oggi non sfruttabile. Aggiungere `'` per robustezza futura.
- `chiediTesto` su overlay singolo `#askinput-overlay` (`public/js/utils.js:783-836`): due chiamate concorrenti si sovrascrivono; chiamanti attuali sequenziali → solo stilistico.
- `codedb` in `docker-compose.yml` senza `healthcheck` proprio (lo hanno solo i DB): disponibilità, non sicurezza.
- Commento stantio `db/DbStrategy.js:552` cita `server.js` per rimozione `maxRows`/`opHandle`, codice reale in `server/socket.js:225` + `server/query.js:68`: solo docs.

---

## Verificato SICURO (cercato, non trovato — per non gonfiare il report)

- **CSWSH / DNS-rebinding socket e MCP:** `server/trasporto.js:80-126,133-146` (`allowRequest`, `cors:{origin:false}`, rifiuto Host non locale, whitelist `CODEDB_ALLOWED_ORIGINS`), `mcp/McpGateway.js:2109-2117,2149,2209` (`guardHost`). Trust proxy `hops||1`, mai `true` (`server/trasporto.js:37-40`).
- **Login/vault-unlock rate limit + potatura:** `server/identita.js:203-248` (5 tentativi/60s, cap 10000 + `potaLoginAttempts`), riusato per unlock; budget socket `server/budget.js:13-23` + decremento su disconnect.
- **Token/scadenza/revoca:** opachi 32B solo SHA-256 TTL 12h (`auth/sessions.js`), indice TTL + `status!=='active'`→null (`auth/AppStore.js:84-86,416-425`), `disconnettiSocketDi` su grant/user revoke (`server/eventi-identita.js`), MCP ri-autentica a ogni request.
- **RBAC SQL/Mongo:** DML cercato ovunque, `multipleStatements`/`executableComment` rifiutati, CTE `WITH … DELETE` coperta (`auth/capabilities.js:91-134`, `auth/guardStrategy.js:257-278`); `$where`/`$function`/`$accumulator` rifiutati, filtro strutturato anti-`$` (`db/filtro.js:121-126,235-252`); `UPDATE/DELETE` shell con filtro obbligatorio; `qtable` sempre qualificato + `search_path` ridotto; `multipleStatements:false` MySQL; sort JSON quotato; backup/restore nativi dietro `canWholeConnection` senza scope.
- **XSS stored:** tutti i sink `innerHTML` verificati con `esc()`/`textContent` (`grid.js:683-709`, `query-tab.js:940,1080-1113`, `details.js:36-71`, `fk-vista.js`, `geo-vista.js:150-157`, `graph3d.js`, `cellselect.js`, `utils.js:buildJsonNode`, `connection.js:66-81` senza URI nel DOM).
- **Stato cross-tab:** per-tab (`tabs.js:freshState`), `emit` cattura tab alla chiamata, scritture con contesto congelato (`inlineEdit.js:144-164`), guard `runId`/`gridRunId`/`tokenRiga` corrette.
- **Filesystem/rete:** traversal `baseId` confinato (`backup/lib/util.js:347-405` + `restore.js:226-233`); SSRF cloud/webhook solo alias/env + `https://hooks.slack.com/` (`backup/lib/policy.js:126-153`); `__proto__` vietato (`server/vault.js:401-427`, `connstore.js:71-93`, `MongoShell.js`, `MongoScript.js`); audit in lettura con `visibility` per tenant, nessun tool MCP su `mcp-audit.log`; test su harness isolato `tmpdir`, segreti solo fittizi, `.env`/`vault.json`/`*.log` non committati.
- **Electron/container:** `nodeIntegration:false, contextIsolation:true, sandbox:true`, `openExternal` solo http/https, `will-navigate` pinned, `INSTANCE_SECRET` HMAC (`electron-main.js`, `electron-server-auth.js`); `USER node`, `HEALTHCHECK`, `cap_drop: ALL`, `no-new-privileges`, bind loopback, password obbligatorie via `${…:?…}`.

---

## Ambito NON analizzato (dichiarato)

- Esecuzione dinamica contro DB reali (iniezioni confermate a livello Proxy + codice driver, non con E2E live).
- `db/SqlToMql.js` traduttore completo e `db/MongoScript.js` interprete (campionati solo i gate, non ogni regola di traduzione/istruzione).
- `public/js` rimanenti (chart-option, geomap, split-layout, intellisense avanzato) oltre i sink XSS e lo stato: letti i punti di checklist, non riga per riga.
- Deployment multi-processo / reverse-proxy reale (timing revoca oltre singola istanza, divergenza `handshake.address` vs `req.ip`).
- `landing/`, `tools/`, `test/` oltre quanto citato (harness + segreti).

## Ordine di intervento consigliato (impatto/costo, non solo severità)

1. **A1 scope-`undefined`** — una guardia nel Proxy chiude letture/scritture fuori perimetro per tutti i metodi; abilita la fiducia nel resto del RBAC.
2. **A2 restore-readOnly** — due righe allineate al canale MCP; chiude sovrascrittura DB da connessioni read-only.
3. **M1 + M2 confinamento backup** — unificare su `resolveBackupPath`/`canonicalBackupPath`: un solo seam sicuro per entrambi i canali.
4. **M5 race indice + M6 logout-socket** — contesto nella modale + `disconnettiSocketDi` al logout: DDL sul bersaglio giusto, sessioni chiuse davvero.
5. **M4 audit MCP + B1 VJ params + B2 atob guard** — attribuzione completa, JOIN corretti, griglia resiliente a dati ostili.

*Keus, il file è pronto come deliverable: ogni rilievo sopra è tracciabile al codice citato e riproducibile con gli scenari indicati.*

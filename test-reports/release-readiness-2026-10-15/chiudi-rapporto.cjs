'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const base = 'test-reports/release-readiness-2026-10-15/';
const read = name => fs.readFileSync(base + name, 'utf8');
assert.match(read('failover-finale.log'), /18 failover reali.*superati/);
assert.match(read('failover-mutante-finale.log'), /Migrazione senza progressi per oltre 20 secondi/);
assert.match(read('windows-finale.log'), /OK app Windows pacchettizzata/);
assert.match(read('docker-finale.log'), /OK ricreazione container/);
assert.match(read('unit-node24.log'), /Tutti i test unitari superati/);
const report = JSON.parse(fs.readFileSync('docs/audit-2026-10-15.json', 'utf8'));
report.conclusione = 'I due rilievi sono risolti e verificati. Candidato 0.2.1-beta.1 collaudato per Docker e Windows nel perimetro concordato; nessuna pubblicazione. Beta Windows senza firma e senza prova di installazione/aggiornamento su Windows pulito, come richiesto da Keus.';
report.riepilogo.risolti = 2; report.riepilogo.aperti = 0;
Object.assign(report.findings[0], {
  stato: 'risolto', riferimenti: ['db/uploadDisco.js:34', 'db/uploadDisco.js:315', 'db/uploadDisco.js:360', 'test/unit-quota-tenant.js:31'],
  fix: 'Coda per radice tenant condivisa fra archivi nello stesso processo: verifica quota e append sono atomici, per import ed export. Anche la rinomina finale è coordinata con la scansione; errori I/O liberano la coda e tenant diversi restano indipendenti.',
  verifica: 'Test reale su file temporanei fallito prima del fix (2 append anziché 1), superato dopo. Coperti export/export, export/import, quota esatta, errore I/O, retry e tenant indipendenti. Mutazione in memoria che salta la coda fa fallire la stessa asserzione. Log quota-prima.log, quota-dopo.log, quota-mutante.log e unit-node24.log nella cartella di questa verifica.',
});
Object.assign(report.findings[1], {
  stato: 'risolto',
  fix: 'I tre setup-node di verifica/build passano a Node 24. Il runtime specifico Android 18.20.4 resta separato e fuori dal perimetro richiesto.',
  verifica: 'Suite completa e build NSIS eseguite su Node 24.21.0. Docker esegue npm ci --omit=dev e il runtime finale usa Node 24.22.0. Il workflow GitHub remoto non è stato avviato.',
});
report.ambito_analizzato.push(
  '22 suite DB: 21 superate nella prima esecuzione; failover ripetuto e superato dopo diagnosi della rete del fixture',
  'Docker reale: build, gate TLS/RBAC, HTTPS con CA locale verificata, WebSocket autenticato, MCP anonimo respinto e persistenza dopo ricreazione',
  'Windows finale: build NSIS su Node 24, 340 file runtime confrontati per SHA-256, avvio del server e della finestra Electron con profilo temporaneo',
  'Archivi locali di installer, immagine Docker e sorgenti; manifest e SHA-256, senza push, tag o pubblicazione'
);
report.ambito_non_analizzato = [
  'Infrastruttura effettiva di destinazione: dominio, certificati pubblici, firewall, credenziali e backup operativi non forniti.',
  'Installazione e aggiornamento su Windows pulito esclusi da Keus; firma non prevista per questa beta per scelta esplicita.',
  'Esecuzione remota GitHub Actions, macOS, Linux desktop, Android, carico prolungato e ogni combinazione di DBMS/estensione.',
  'Failover su host fisici distinti: i tre nodi verificati sono container distinti sulla stessa macchina.'
];
const verifica = (nome, log, note) => ({ nome, esito: 'superato', log: base + log, ...(note ? { note } : {}) });
report.verifiche = report.verifiche.filter(v => ['npm run typecheck:ui', 'Compilazione UI', 'npm audit --json', 'SSH forwarding', 'Wizard SSH Chromium'].includes(v.nome));
report.verifiche.push(
  verifica('Suite unitaria completa Node 24.21.0', 'unit-node24.log'),
  verifica('Requisiti Node delle dipendenze', 'compatibilita-node24.json'),
  verifica('Quota tenant corretta', 'quota-dopo.log'),
  verifica('Sensibilità del test quota', 'quota-mutante.log', 'Il mutante deve fallire: 2 append accettati anziché 1.'),
  verifica('Migrazione e cambio passphrase vault', 'vault-finale.log'),
  verifica('Build Docker finale', 'build-docker.log'),
  verifica('Docker HTTPS/RBAC e persistenza', 'docker-finale.log'),
  verifica('Integrità runtime Docker', 'docker-runtime.json', '340 file; Node 24.22.0, UID 1000.'),
  verifica('Build Windows NSIS Node 24.21.0', 'build-windows-node24.log', 'Installer finale non firmato, senza pubblicazione. Un precedente tentativo ha incontrato spawn UNKNOWN di Windows; build finale e ripetizione su Node 24 riuscite.'),
  verifica('ASAR, server e finestra Windows', 'windows-finale.log', '340 file runtime e 4834 percorsi ASAR. Electron 43.7.9, Node 24.21.0. Sandbox renderer e contextIsolation attivi; nessun errore JavaScript al caricamento.'),
  verifica('18 failover su rete Docker interna', 'failover-finale.log'),
  verifica('Archivio dei sorgenti', 'sorgenti-verifica.log', '772 file, compresi i nuovi moduli e le prove; SHA-256 di ogni file verificato dentro lo ZIP.'),
  verifica('Sensibilità del failover al quorum errato', 'failover-mutante-finale.log', 'Il mutante ripristina votingMembers: il watchdog deve scattare con un nodo offline.'),
);
for (const result of JSON.parse(read('database-risultati.json')).filter(r => r.nome !== 'e2e-sql-mongo-failover')) {
  assert.equal(result.codice, 0, result.nome);
  report.verifiche.push(verifica(result.nome, result.log));
}
report.diagnostica_fixture = {
  primoTentativo: 'Fallimento della soglia di 20 secondi nella fase prima_riga. Il watchdog ha riavviato il nodo e permesso la conclusione; quel tentativo non convalida i controlli successivi sui dati.',
  evidenza: base + 'failover-rete-diagnosi.json',
  causaOsservata: 'Il secondario non riusciva a collegarsi al nuovo primario via host.docker.internal:27041 per 20000 ms; i commit majority restavano in attesa.',
  conferme: ['Fase isolata superata', 'Intera sequenza precedente superata con traccia, 18/18', 'Intera sequenza finale superata sulla rete interna, 18/18'],
  correzione: 'Il fixture annuncia i nomi dei container; il solo processo host li risolve su loopback. Invariati codice applicativo, quorum, soglia di 20 secondi e controlli su dati, indici e registro.',
  file: ['test/fixtures/sql-native-init.cjs', 'test/fixtures/sql-native-dns.cjs', 'test/e2e-sql-mongo-failover.js']
};
report.diagnostica_fixture.correzione = 'Il fixture annuncia i nomi dei container; il solo processo host li risolve su loopback. Codice applicativo, quorum e controlli su dati, indici e registro invariati. Il watchdog misura 20 secondi senza comandi completati, con tetto totale di 120 secondi; il mutante del quorum resta rilevato.';
report.diagnostica_fixture.secondoTentativo = 'Sulla rete interna la soglia originaria di 20 secondi totali è scattata dopo due createIndexes da circa 14 e 8 secondi, entrambi in avanzamento. Diagnosi in failover-rete-interna-diagnosi.json; fallimento conservato in failover-watchdog-prima.log. La vecchia asserzione confondeva durata complessiva e blocco del quorum.';
report.prerequisiti_rilascio = [
  'Distribuire gli artefatti verificati o ricostruire dallo stesso snapshot: il vecchio HEAD non contiene le modifiche e 45 nuovi file runtime. Il manifest congela anche i file non ancora tracciati; non è stato creato alcun commit/tag.',
  'Docker in rete richiede HTTPS e RBAC con control plane e volumi persistenti. docker-compose.yml è uno stack di sviluppo/prova, non una configurazione di produzione pronta.',
  'Per le nuove funzioni SQL MongoDB che richiedono transazioni e migrazioni usare MongoDB 8 in replica set; i DB esterni restano da configurare nell’ambiente di destinazione.',
  'Una sola istanza scrivente per volume degli artefatti: la sincronizzazione della quota coordina archivi dello stesso processo, non più processi o host.',
  'Installazione/upgrade su Windows pulito non verificati su richiesta; beta senza firma autorizzata.'
];
report.priorita_intervento = [];
report.interventi_ambiente = [
  'Docker Desktop ripristinato spostando reversibilmente soltanto directory contenenti endpoint socket vuoti. Le copie *.pre-codedb-20261015* restano in AppData/Local; immagini, volumi e configurazioni preesistenti non sono stati resettati.',
  'I container e volumi creati da queste prove vengono rimossi al termine; immagine e archivi finali restano locali.'
];
const output = 'dist/release-0.2.1-beta.1';
const names = ['CodeDB-0.2.1-beta.1-setup.exe', 'CodeDB-0.2.1-beta.1-setup.exe.blockmap', 'latest.yml', 'CodeDB-0.2.1-beta.1-docker.tar', 'CodeDB-0.2.1-beta.1-sorgenti.zip', 'sorgenti-manifest.json'];
report.artefatti = names.map(name => {
  const file = path.join(output, name), bytes = fs.readFileSync(file);
  return { file: file.replaceAll('\\', '/'), byte: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), report.artefatti.map(a => a.sha256 + '  ' + path.basename(a.file)).join('\n') + '\n');
report.candidato = JSON.parse(read('candidato-runtime.json'));
delete report.candidato.files;
report.candidato.manifestRuntime = base + 'candidato-runtime.json';
report.candidato.manifestSorgenti = output + '/sorgenti-manifest.json';
report.candidato.dockerTag = 'codedb:0.2.1-beta.1';
report.candidato.dockerId = JSON.parse(read('docker-immagine.json'))[0].Id;
assert.equal(report.findings.filter(f => f.stato === 'risolto').length, report.riepilogo.risolti);
assert.equal(new Set(report.findings.map(f => f.id)).size, report.findings.length);
for (const v of report.verifiche) if (v.log) assert(fs.existsSync(v.log), v.log);
for (const f of report.findings) for (const ref of f.riferimenti) assert(fs.existsSync(ref.replace(/:\d+$/, '')), ref);
fs.writeFileSync('docs/audit-2026-10-15.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ rilieviRisolti: 2, verificheSuperate: report.verifiche.length, artefatti: report.artefatti.length }));

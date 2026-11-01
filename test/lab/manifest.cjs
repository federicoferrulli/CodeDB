'use strict';

// Ogni esclusione è un prerequisito esplicito, mai un test verde.
const esclusioni = {
  'e2e-harness.js': 'Infrastruttura condivisa, non una suite.',
  'e2e-contenitori.js': 'Richiede Electron desktop ed emulatore Android dedicato con APK installabile.',
  'e2e-mobile-android.js': 'Richiede adb Windows, APK e emulatore Android dedicato emulator-5580.',
  'e2e-splash-android.js': 'Richiede adb Windows e emulatore Android dedicato emulator-5580.',
  'e2e-release-desktop.cjs': 'Richiede un pacchetto Electron compilato per il sistema in prova.',
  'e2e-mongosh-electron.cjs': 'Richiede pacchetto Electron e ambiente grafico desktop.',
  'e2e-mongosh-runtime.js': 'Eseguito nel profilo native: usa il MongoDB dedicato sulla porta 27039.',
  'e2e-mongosh-ui.js': 'Eseguito nel profilo native: usa il MongoDB dedicato sulla porta 27039.',
  'e2e-conteggi-navigatore.js': 'Richiede controllo Docker dall’host; il runner di base non monta il socket Docker.',
  'e2e-mongosh-advanced.cjs': 'Richiede Atlas Search locale, replica multipla e sharding della fixture mongo-advanced.',
  'e2e-mongosh-kerberos.cjs': 'Richiede KDC Kerberos dedicato e fixture mongo-kerberos.',
  'e2e-sql-mongo-failover.js': 'Richiede replica MongoDB a tre nodi e controllo Docker per elezione forzata.',
  'e2e-sql-native-provisioning.js': 'Gestisce uno stack Docker persistente separato: da eseguire nel profilo dedicato.',
  'e2e-sql-native.js': 'Richiede lo stack sql-native con alias DNS e replica a tre nodi.',
  'e2e-sql-native-sessioni.js': 'Richiede lo stack sql-native con alias DNS e replica a tre nodi.',
  'e2e-sql-native-ui.js': 'Richiede lo stack sql-native con alias DNS e replica a tre nodi.',
  'e2e-query-nativo-completo.js': 'Richiede lo stack sql-native con alias DNS e replica a tre nodi.',
  'e2e-query-audit.js': 'Richiede lo stack sql-native con alias DNS e replica a tre nodi.',
  'e2e-query-dialetti-nativi.js': 'Confronta il catalogo dichiarato PostgreSQL 18; eseguito nel profilo native con PostgreSQL 18.',
  'e2e-sql-mongo-tipi.js': 'Oracolo delle condizioni SQLSTATE PostgreSQL 18: eseguito nel profilo native con PostgreSQL 18.',
};
const timeout = { 'e2e-mobile-drawer-click.js': 360000 };
module.exports = { esclusioni, timeout };

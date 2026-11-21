'use strict';

/**
 * Runner per l'esecuzione di tutti i test End-to-End (E2E) della suite.
 * Scansiona la cartella test/ ed esegue sequenzialmente tutti i file e2e-*.js e e2e.js.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_DIR = __dirname;

function runAllE2eTests() {
  console.log('=== Avvio esecuzione completa suite Test E2E ===\n');

  const files = fs.readdirSync(TEST_DIR)
    // e2e-harness.js è l'infrastruttura condivisa (avvia le istanze di test),
    // non un test: eseguirlo non farebbe nulla ma comparirebbe fra i risultati.
    .filter((file) => (file === 'e2e.js' || (file.startsWith('e2e-') && file.endsWith('.js')))
      && file !== 'all-e2e.js' && file !== 'e2e-harness.js')
    // Il riavvio dello stack persistente è una prova separata, richiesta esplicitamente.
    .filter(file => file !== 'e2e-sql-native-provisioning.js' || process.env.CODEDB_E2E_NATIVE_PROVISIONING === '1')
    // La prova del volume usa un’immagine dell’applicazione costruita per il laboratorio.
    .filter(file => file !== 'e2e-dati-docker.js' || process.env.CODEDB_E2E_DOCKER_IMAGE)
    .sort();

  let passed = 0;
  let failed = 0;
  const failedTests = [];

  for (const file of files) {
    const fullPath = path.join(TEST_DIR, file);
    console.log(`\n--------------------------------------------------`);
    console.log(`▶ Esecuzione: ${file}`);
    console.log(`--------------------------------------------------`);

    const env = {
      ...process.env,
      MYSQL_USER: process.env.MYSQL_USER || 'root',
      MYSQL_PASSWORD: process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '',
      MYSQL_HOST: process.env.MYSQL_HOST || '127.0.0.1',
      MYSQL_PORT: process.env.MYSQL_PORT || '3306',
      PG_HOST: process.env.PG_HOST || '127.0.0.1',
      PG_PORT: process.env.PG_PORT || '5432',
      PG_USER: process.env.PG_USER || 'postgres',
      PG_PASSWORD: process.env.PG_PASSWORD || '',
      PG_DATABASE: process.env.PG_DATABASE || 'postgres',
    };

    // I probe nativi e le suite socket condividono i motori di prova configurati.
    env.CODEDB_E2E_MONGO_URI ||= env.MONGO_URI || 'mongodb://' + (env.MONGO_HOST || '127.0.0.1') + ':' + (env.MONGO_PORT || '27017');
    env.MONGO_URI ||= env.CODEDB_E2E_MONGO_URI;
    for (const [chiave, valore] of Object.entries({
      PGHOST: env.PG_HOST, PGPORT: env.PG_PORT, PGUSER: env.PG_USER, PGPASSWORD: env.PG_PASSWORD, PGDATABASE: env.PG_DATABASE,
      E2E_PG_HOST: env.PG_HOST, E2E_PG_PORT: env.PG_PORT, E2E_PG_USER: env.PG_USER, E2E_PG_PASSWORD: env.PG_PASSWORD,
      E2E_MYSQL_HOST: env.MYSQL_HOST, E2E_MYSQL_PORT: env.MYSQL_PORT, E2E_MYSQL_USER: env.MYSQL_USER, E2E_MYSQL_PASSWORD: env.MYSQL_PASSWORD,
    })) env[chiave] ??= valore;
    const result = spawnSync(process.execPath, [fullPath], {
      stdio: 'inherit',
      env,
    });

    if (result.status === 0) {
      console.log(`✔ SUCCESS: ${file}`);
      passed++;
    } else {
      console.error(`❌ FAILED: ${file} (exit code: ${result.status})`);
      failed++;
      failedTests.push(file);
    }
  }

  console.log('\n==================================================');
  console.log('            RIEPILOGO TEST E2E                    ');
  console.log('==================================================');
  console.log(`Totale test eseguiti: ${files.length}`);
  console.log(`Superati:             ${passed}`);
  console.log(`Falliti:              ${failed}`);

  if (failed > 0) {
    console.error('\nTest falliti:');
    failedTests.forEach((t) => console.error(` - ${t}`));
    process.exit(1);
  } else {
    console.log('\nTUTTI I TEST E2E SONO STATI SUPERATI CON SUCCESSO!');
    process.exit(0);
  }
}

runAllE2eTests();

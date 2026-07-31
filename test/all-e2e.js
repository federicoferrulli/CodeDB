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

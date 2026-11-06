'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { createSettings, DEFAULTS, ENV_KEYS } = require('../mcp/Settings');

module.exports = (async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-mcp-settings-'));
  try {
    const filePath = path.join(directory, 'settings.json');
    const settings = createSettings({ filePath });
    assert.deepStrictEqual(settings.get(), DEFAULTS);
    assert.strictEqual(fs.existsSync(filePath), false, 'la lettura non crea file');
    let observed;
    const unsubscribe = settings.subscribe(value => { observed = value; });
    const saved = await settings.update({ enabled: false, maxSessions: 9 }, 0);
    assert.strictEqual(saved.revision, 1);
    assert.strictEqual(observed.enabled, false);
    assert.strictEqual(createSettings({ filePath }).get().maxSessions, 9, 'le impostazioni sopravvivono al riavvio');
    await assert.rejects(settings.update({ enabled: true }, 0), /modificate da un’altra sessione/, 'una scheda obsoleta non sovrascrive');
    const concurrent = await Promise.allSettled([settings.update({ maxSessions: 8 }, 1), settings.update({ maxSessions: 7 }, 1)]);
    assert.strictEqual(concurrent.filter(r => r.status === 'fulfilled').length, 1, 'una sola scrittura per revisione');
    assert.strictEqual(settings.get().maxSessions, 8);
    unsubscribe();

    for (const patch of [{ enabled: 'false' }, { maxSessions: 0 }, { maxSessions: Infinity }, { unknown: 1 }, { pendingGlobal: 1 }, { pendingBytesGlobalMiB: 1 }]) {
      await assert.rejects(async () => settings.update(patch, settings.snapshot().revision));
    }
    assert.strictEqual(settings.snapshot().revision, 2, 'valori non validi non incrementano la revisione');
    assert.throws(() => createSettings({ filePath, env: { CODEDB_MCP_ENABLED: 'invalid' } }), /CODEDB_MCP_ENABLED/);
    assert.throws(() => createSettings({ filePath, env: { CODEDB_MCP_MAX_SESSIONS: '8junk' } }), /intero/);

    const locked = createSettings({ filePath, env: { CODEDB_MCP_ENABLED: 'on', CODEDB_MCP_MAX_SESSIONS: '12' } });
    assert.strictEqual(locked.get().enabled, true);
    assert.strictEqual(locked.snapshot().overrides.maxSessions, 'CODEDB_MCP_MAX_SESSIONS');
    await assert.rejects(locked.update({ maxSessions: 13 }, 2), /imposto da/);
    await locked.update({ ...locked.get(), idleTimeoutMinutes: 15 }, 2);
    const restarted = createSettings({ filePath });
    assert.strictEqual(restarted.get().enabled, false, 'l’override non viene copiato nei valori salvati');
    assert.strictEqual(restarted.get().maxSessions, 8);
    assert.strictEqual(restarted.get().idleTimeoutMinutes, 15);
    assert.strictEqual(ENV_KEYS.auditMaxMiB, 'CODEDB_MCP_AUDIT_MAX_MIB');

    const failedPath = path.join(directory, 'directory.json');
    const failing = createSettings({ filePath: failedPath });
    fs.mkdirSync(failedPath);
    await assert.rejects(failing.update({ enabled: false }, 0));
    assert.strictEqual(failing.get().enabled, true, 'un errore disco non altera i valori in memoria');
    assert.strictEqual(failing.snapshot().revision, 0);
    assert(!fs.readdirSync(directory).some(file => file.endsWith('.tmp')), 'nessun file temporaneo abbandonato');

    fs.writeFileSync(path.join(directory, 'invalid.json'), '{invalid');
    assert.throws(() => createSettings({ filePath: path.join(directory, 'invalid.json') }), /Impossibile caricare/);
    assert.strictEqual(createSettings({ filePath: path.join(directory, 'other.json') }).get().maxSessions, 32, 'istanze isolate');
    const recovering = createSettings({ filePath: path.join(directory, 'recovering.json') });
    const removeFailure = recovering.subscribe(() => { throw new Error('Guasto simulato del runtime'); });
    let remainingListener = false;
    recovering.subscribe(() => { remainingListener = true; });
    const incomplete = await recovering.update({ maxSessions: 10 }, 0);
    assert.strictEqual(incomplete.applied, false);
    assert.match(incomplete.applyError, /salvate, applicazione incompleta/);
    assert.strictEqual(incomplete.revision, 1, 'un errore runtime non finge che la persistenza sia fallita');
    assert.strictEqual(remainingListener, true, 'gli altri componenti ricevono comunque la configurazione');
    assert.strictEqual(createSettings({ filePath: path.join(directory, 'recovering.json') }).get().maxSessions, 10);
    removeFailure();
    assert.strictEqual((await recovering.update({ maxSessions: 10 }, 1)).applied, true, 'il salvataggio permette di ritentare l’applicazione');
    console.log('  OK   MCP impostazioni: persistenza, override, revisioni concorrenti, validazione e guasti disco');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})();

if (require.main === module && process.argv.includes('--sensitivity')) {
  module.exports = module.exports.then(() => {
    const modulePath = require.resolve('../mcp/Settings');
    const original = fs.readFileSync(modulePath, 'utf8');
    const mutated = original.replace('if (expectedRevision !== revision)', 'if (false)');
    assert.notStrictEqual(original, mutated);
    const script = `const Module=require('module');const m=new Module(${JSON.stringify(modulePath)});m.filename=${JSON.stringify(modulePath)};m.paths=Module._nodeModulePaths(require('path').dirname(m.filename));require.cache[m.filename]=m;m._compile(${JSON.stringify(mutated)},m.filename);require(${JSON.stringify(__filename)});`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
    assert.notStrictEqual(child.status, 0, 'il test deve fallire se si elimina il controllo revisione');
    assert.match(child.stderr, /AssertionError/, child.stderr);
    console.log('  OK   Sensibilità MCP impostazioni: mutante senza controllo revisione rilevato');
  });
}

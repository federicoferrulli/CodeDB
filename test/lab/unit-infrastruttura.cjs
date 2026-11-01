'use strict';

// Prove dei veri helper in filesystem e processi usa-e-getta: nessun Docker attivo.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const quiet = { log() {}, error() {} };
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function mappedFs(base) {
  const translate = value => typeof value === 'string' && value.startsWith('/') ? path.join(base, value) : value;
  return new Proxy(fs, { get(target, name) {
    if (typeof target[name] !== 'function') return target[name];
    if (name === 'realpathSync') return value => '/' + path.relative(base, fs.realpathSync(translate(value))).split(path.sep).join('/');
    if (!/^(?:exists|readFile|writeFile|mkdir|lstat|stat|rm|unlink|readdir|copyFile|open|readlink).*Sync$/.test(String(name))) return target[name];
    return (...args) => { args[0] = translate(args[0]); if (name === 'copyFileSync') args[1] = translate(args[1]); return target[name](...args); };
  } });
}
function load(source, { base, virtualDir, append = '', proc = process, mutantPaths = false, mutantCore = false } = {}) {
  const mod = { exports: {} };
  const req = name => {
    if (name === 'node:fs' || name === 'fs') return base ? mappedFs(base) : fs;
    if (name === 'node:path' || name === 'path') return base ? path.posix : path;
    if (name.startsWith('.')) {
      if (mutantPaths && name.endsWith('/percorsi.cjs')) return { verifica: (root, target) => target };
      return load(require.resolve(path.resolve(path.dirname(source), name)), { base, proc, mutantPaths });
    }
    return require(name);
  };
  let code = fs.readFileSync(source, 'utf8');
  if (mutantCore && path.basename(source) === 'laboratorio.cjs') {
    const point = 'for (const relative of [...files].sort()) {';
    assert.equal(code.split(point).length - 1, 1, 'Il mutante core deve intercettare la selezione prima della copia');
    code = code.replace(point, "for (const file of ['db/nuovo.js', 'ui/nuovo.tsx', 'nuovo.cjs']) files.delete(file);\n  " + point);
  }
  vm.runInNewContext(code + append, {
    require: req, module: mod, exports: mod.exports, __dirname: virtualDir || path.dirname(source),
    __filename: source, process: proc, console: quiet, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
  }, { filename: source });
  return mod.exports;
}
const lockSource = path.join(root, 'test/lab/lock.cjs');
if (process.argv[2] === '--lock-owner') {
  const base = process.argv[3];
  const helper = require(lockSource).creaLock(path.join(base, 'laboratorio/campagna-attiva.json'));
  helper.acquisisci('sandbox-interruzione');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  if (process.argv[4] !== '--mutant-registra') helper.registra(child.pid, process.platform !== 'win32');
  child.unref();
  write(path.join(base, 'ready.json'), JSON.stringify({ owner: process.pid, child: child.pid }));
  setInterval(() => {}, 1000);
} else {
  main().catch(err => { console.error(err); process.exitCode = 1; });
}
async function main() {
  const scratch = path.join(root, '.scratch'); fs.mkdirSync(scratch, { recursive: true });
  const sandboxParent = require('node:os').tmpdir();
  const temp = fs.mkdtempSync(path.join(sandboxParent, 'codedb-infrastruttura-'));
  const results = [];
  const test = async (name, fn) => {
    try { await fn(); results.push({ name, ok: true }); console.log('PASS ' + name); }
    catch (err) { results.push({ name, ok: false, error: err.message }); console.log('FAIL ' + name + ': ' + err.message); }
  };
  const nuoviCore = { 'db/nuovo.js': 'module.exports = { prova: 17 };',
    'ui/nuovo.tsx': 'export const Nuovo = () => <span>Prova</span>;',
    'nuovo.cjs': 'module.exports = "entrypoint non tracciato";' };
  const localiEsclusi = ['db/segreto.txt', 'ignorato.cjs', 'config-locale-42.json', 'stato-personale.json'];
  function fixture(name, mutantPaths = false, mutantCore = process.argv.includes('--mutant-core')) {
    const dir = path.join(temp, name);
    write(path.join(dir, 'server.js'), 'module.exports = 42;');
    write(path.join(dir, 'test/lab/nuovo.cjs'), '// prova non ancora tracciata');
    write(path.join(dir, 'tools/laboratorio.cjs'), '// fixture');
    write(path.join(dir, '.github/workflows/laboratorio.yml'), 'name: fixture');
    write(path.join(dir, '.gitignore'), '/db/segreto.txt\n/ignorato.cjs\n');
    for (const [file, content] of Object.entries(nuoviCore)) write(path.join(dir, file), content);
    // Nomi JSON arbitrari: aggiungere tutti gli untracked non deve esportare
    // configurazioni locali solo perché il loro nome non contiene "vault".
    for (const file of localiEsclusi) write(path.join(dir, file), JSON.stringify({ token: 'segreto-solo-fixture' }));
    for (const file of ['.env', 'vault.json', 'connections.ini', 'conns/local.json', 'test-reports/local.json', 'privata.key']) write(path.join(dir, file), 'segreto-fixture');
    for (const args of [['init', '-q'], ['add', 'server.js', '.gitignore', '.env', 'vault.json', 'connections.ini', 'conns/local.json', 'test-reports/local.json', 'privata.key']]) {
      const child = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); assert.equal(child.status, 0, child.stderr);
    }
    const proc = Object.create(process); proc.argv = [process.execPath, 'fixture', 'help'];
    const stage = load(path.join(root, 'tools/laboratorio.cjs'), { virtualDir: path.join(dir, 'tools'), proc, mutantPaths, mutantCore, append: '\nmodule.exports = { stage };' }).stage;
    return { dir, stage };
  }
  function verificaCore({ dir, stage }) {
    const indexed = spawnSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' });
    assert.equal(indexed.status, 0, indexed.stderr);
    for (const file of Object.keys(nuoviCore)) assert.equal(indexed.stdout.split('\0').includes(file), false, '[INF-FIXTURE] il nuovo sorgente non è tracciato');
    stage();
    const target = path.join(dir, '.scratch/lab-source');
    const manifest = JSON.parse(fs.readFileSync(path.join(target, '.lab-files.json'), 'utf8'));
    assert.deepEqual(Object.keys(nuoviCore).filter(file => !manifest.files.includes(file)), [], '[INF-CORE] i nuovi sorgenti applicativi devono entrare nella copia');
    for (const [file, content] of Object.entries(nuoviCore)) {
      assert.equal(fs.readFileSync(path.join(target, file), 'utf8'), content, '[INF-CORE] contenuto attuale del checkout');
      assert.equal(manifest.hashes[file], require('node:crypto').createHash('sha256').update(content).digest('hex'), '[INF-CORE] hash del nuovo sorgente');
    }
  }
  function prepareFixture(name) {
    const dir = path.join(temp, name);
    write(path.join(dir, '.dockerenv'), '');
    write(path.join(dir, 'sorgente/.lab-files.json'), JSON.stringify({ files: ['fresh.js'] }));
    write(path.join(dir, 'sorgente/fresh.js'), 'nuovo');
    write(path.join(dir, 'laboratorio/file-copiati.json'), JSON.stringify({ files: ['obsolete.js'] }));
    write(path.join(dir, 'laboratorio/repo/obsolete.js'), 'obsoleto');
    write(path.join(dir, 'laboratorio/repo/node_modules/preservato'), 'dipendenza');
    const proc = Object.create(process); proc.env = { ...process.env, CODEDB_LAB_CONTAINER: '1' };
    return { dir, run: () => load(path.join(root, 'test/lab/prepara.cjs'), { base: dir, proc }) };
  }
  try {
    const bootstrap = () => {
      const source = fs.readFileSync(path.join(root, 'tools/laboratorio.cjs'), 'utf8');
      const match = /'mongosh', '--quiet', '--eval', ('(?:\\.|[^'\\])*')/.exec(source);
      assert(match, 'Bootstrap MongoDB presente nel comando reale');
      return vm.runInNewContext(match[1]);
    };
    await test('bootstrap MongoDB compila con attese asincrone nel ciclo', () => {
      assert.match(bootstrap(), /await sleep\(500\)/);
      new vm.Script(bootstrap());
    });
    await test('staging esclude segreti e include nuovi test con hash', () => {
      const { dir, stage } = fixture('stage-normale'); stage();
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.scratch/lab-source/.lab-files.json'), 'utf8'));
      assert.ok(manifest.files.includes('server.js')); assert.ok(manifest.files.includes('test/lab/nuovo.cjs'));
      assert.equal(manifest.files.filter(f => /(?:vault|connections|\.env|conns\/|test-reports|\.key$)/.test(f)).length, 0);
      assert.equal(manifest.hashes['server.js'], require('node:crypto').createHash('sha256').update('module.exports = 42;').digest('hex'));
    });
    await test('staging include sorgenti core non tracciati con contenuto e hash', () => verificaCore(fixture('stage-core-untracked')));
    await test('staging esclude ignorati e JSON locali non tracciati', () => {
      const { dir, stage } = fixture('stage-locali');
      const ignored = spawnSync('git', ['check-ignore', 'db/segreto.txt', 'ignorato.cjs'], { cwd: dir, encoding: 'utf8' });
      assert.equal(ignored.status, 0, ignored.stderr);
      assert.deepEqual(ignored.stdout.trim().split(/\r?\n/).sort(), ['db/segreto.txt', 'ignorato.cjs']);
      stage(); const target = path.join(dir, '.scratch/lab-source');
      const manifest = JSON.parse(fs.readFileSync(path.join(target, '.lab-files.json'), 'utf8'));
      for (const file of localiEsclusi) {
        assert.equal(manifest.files.includes(file), false, `[INF-FILTRO] ${file} non deve essere nel manifest`);
        assert.equal(fs.existsSync(path.join(target, file)), false, `[INF-FILTRO] ${file} non deve essere copiato`);
      }
      assert.ok(manifest.files.includes('.gitignore'), '[INF-FILTRO] le regole del repository sono sorgenti condivisibili');
    });
    await test('staging rifiuta cartella priva del proprio marcatore', () => {
      const { dir, stage } = fixture('stage-marcatore'); const sentinel = path.join(dir, '.scratch/lab-source/preservato'); write(sentinel, 'intatto');
      assert.throws(stage); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'intatto');
    });
    await test('staging non cancella attraverso junction antenata', () => {
      const { dir, stage } = fixture('stage-junction');
      const outside = path.join(temp, 'esterno-stage'); const sentinel = path.join(outside, 'lab-source/preservato');
      write(sentinel, 'intatto'); write(path.join(outside, 'lab-source/.codedb-lab-source'), 'codedb-affidabilita');
      fs.symlinkSync(outside, path.join(dir, '.scratch'), process.platform === 'win32' ? 'junction' : 'dir');
      let rejected = false; try { stage(); } catch { rejected = true; }
      assert.ok(fs.existsSync(sentinel), 'staging ha cancellato un file fuori dal root simulato attraverso .scratch');
      assert.ok(rejected, 'staging deve rifiutare la junction');
    });
    await test('copia elimina obsoleti preservando dipendenze', () => {
      const { dir, run } = prepareFixture('copy-normale'); run();
      assert.equal(fs.readFileSync(path.join(dir, 'laboratorio/repo/fresh.js'), 'utf8'), 'nuovo');
      assert.equal(fs.existsSync(path.join(dir, 'laboratorio/repo/obsolete.js')), false);
      assert.equal(fs.readFileSync(path.join(dir, 'laboratorio/repo/node_modules/preservato'), 'utf8'), 'dipendenza');
    });
    await test('copia non cancella attraverso junction nel target', () => {
      const { dir, run } = prepareFixture('copy-junction'); const outside = path.join(dir, 'esterno'); const sentinel = path.join(outside, 'preservato'); write(sentinel, 'intatto');
      fs.symlinkSync(outside, path.join(dir, 'laboratorio/repo/obsoleto'), process.platform === 'win32' ? 'junction' : 'dir');
      write(path.join(dir, 'laboratorio/file-copiati.json'), JSON.stringify({ files: ['obsoleto/preservato'] }));
      let rejected = false; try { run(); } catch { rejected = true; }
      assert.ok(fs.existsSync(sentinel), 'prepara ha cancellato un file fuori dal target simulato'); assert.ok(rejected);
    });
    async function interruzione(name, mutant = false) {
      const base = path.join(temp, name); fs.mkdirSync(path.join(base, 'laboratorio'), { recursive: true });
      const owner = spawn(process.execPath, [__filename, '--lock-owner', base, ...(mutant ? ['--mutant-registra'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
      let childPid; let output = ''; owner.stderr.on('data', b => { output += b; });
      try {
        const ready = path.join(base, 'ready.json'); const end = Date.now() + 10000;
        while (!fs.existsSync(ready) && Date.now() < end && owner.exitCode === null) await new Promise(r => setTimeout(r, 30));
        assert.ok(fs.existsSync(ready), 'owner non avviato: ' + output);
        childPid = JSON.parse(fs.readFileSync(ready, 'utf8')).child;
        const helper = require(lockSource).creaLock(path.join(base, 'laboratorio/campagna-attiva.json'));
        assert.throws(() => helper.assicuratiLibero(), /attiv|PID|campagna/i);
        const exited = new Promise(r => owner.once('exit', r)); owner.kill('SIGKILL'); await exited;
        assert.throws(() => process.kill(owner.pid, 0)); process.kill(childPid, 0);
        let rejected = false; try { helper.assicuratiLibero(); } catch { rejected = true; }
        assert.ok(rejected, 'owner morto ma suite detached viva: lock rimosso e nuova campagna ammessa');
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
        if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; } }
      }
    }
    await test('lock impedisce riuso dopo interruzione con discendente vivo', () => interruzione('lock'));
    if (process.argv.includes('--sensitivity')) {
      await test('sensibilità: await fuori dalla funzione MongoDB viene rilevato', () => {
        const original = bootstrap(), mutated = original.replace('(async()=>{', '').replace(/\}\)\(\);$/, '');
        assert.notEqual(mutated, original);
        assert.throws(() => new vm.Script(mutated), SyntaxError);
      });
      if (results.find(result => result.name === 'staging include sorgenti core non tracciati con contenuto e hash')?.ok) {
        await test('sensibilità: omettere i nuovi sorgenti core viene rilevato', () => {
          assert.throws(() => verificaCore(fixture('stage-core-mutante', false, true)), /\[INF-CORE\]/);
        });
      }
      await test('sensibilità: registra rimosso ammette riuso erroneo', async () => {
        await assert.rejects(() => interruzione('lock-mutante', true), /lock rimosso e nuova campagna ammessa/);
      });
      await test('sensibilità: verifica disattivata cancella oltre junction', () => {
        const { dir, stage } = fixture('stage-mutante', true); const outside = path.join(temp, 'esterno-mutante');
        const sentinel = path.join(outside, 'lab-source/preservato'); write(sentinel, 'intatto');
        write(path.join(outside, 'lab-source/.codedb-lab-source'), 'codedb-affidabilita');
        fs.symlinkSync(outside, path.join(dir, '.scratch'), process.platform === 'win32' ? 'junction' : 'dir');
        stage(); assert.equal(fs.existsSync(sentinel), false, 'La mutazione non ha riprodotto il delete oltre root');
      });
    }
  } finally {
    const safe = fs.realpathSync(temp); const allowed = fs.realpathSync(sandboxParent);
    assert.ok(safe.startsWith(allowed + path.sep) && path.basename(safe).startsWith('codedb-infrastruttura-'));
    fs.rmSync(safe, { recursive: true, force: true });
    const report = path.join(process.env.LAB_REPORT_DIR || path.join(scratch, 'lab-reports'), 'infrastruttura.json');
    write(report, JSON.stringify({ date: new Date().toISOString(), isolation: 'solo filesystem temporaneo e PID creati dalla prova; nessun Docker', results }, null, 2));
    process.exitCode = results.some(r => !r.ok) ? 1 : 0;
  }
}

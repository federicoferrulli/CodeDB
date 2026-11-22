'use strict';

const { execFileSync } = require('node:child_process');

// Questo codice viene eseguito nello snapshot immutabile del vecchio container.
async function copiaDati() {
  const fs = require('node:fs');
  const fsp = fs.promises;
  const path = require('node:path');
  const crypto = require('node:crypto');
  const destinazione = '/app/data';
  const nomi = (await fsp.readdir('/app')).filter(n =>
    /^(?:mcp-settings\.json|(?:ui|mcp)-audit\.log(?:\.\d+)?)$/.test(n));
  async function impronta(file) {
    if (!(await fsp.lstat(file)).isFile()) throw new Error('File non regolare: ' + file);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  }
  const mancanti = [];
  for (const nome of nomi) {
    const originale = await impronta(path.join('/app', nome));
    try {
      if (await impronta(path.join(destinazione, nome)) !== originale) {
        throw new Error('Esistono due versioni diverse di ' + nome + '. Conservale e riconciliale prima di ricreare il container.');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      mancanti.push({ nome, originale });
    }
  }
  for (const { nome, originale } of mancanti) {
    const temporaneo = path.join(destinazione, '.migrazione-' + crypto.randomUUID());
    try {
      await fsp.copyFile(path.join('/app', nome), temporaneo, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(temporaneo, 0o600);
      if (await impronta(temporaneo) !== originale) throw new Error('Copia incompleta di ' + nome);
      // Pubblicazione atomica senza sostituire un file apparso nel frattempo.
      await fsp.link(temporaneo, path.join(destinazione, nome));
    } finally { await fsp.rm(temporaneo, { force: true }); }
  }
  console.log(`File verificati nel volume: ${nomi.length}. Copiati: ${mancanti.length}.`);
}

function migra(container) {
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const id = container || docker('compose', 'ps', '--all', '--quiet', 'codedb');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw new Error('Indica un solo container CodeDB esistente.');
  const [info] = JSON.parse(docker('inspect', '--type', 'container', id));
  if (info.State.Running) throw new Error('Ferma prima il servizio: docker compose stop codedb');
  if (!info.Mounts.some(m => m.Destination === '/app/data' && m.RW)) {
    throw new Error('Il vecchio container deve avere il volume dati scrivibile montato su /app/data.');
  }
  // Lo snapshot contiene solo il filesystem del container. I volumi vengono
  // rimontati separatamente sul processo di copia e sopravvivono al suo arresto.
  const snapshot = docker('commit', info.Id);
  try {
    const codice = '(' + copiaDati.toString() + ')().catch(err => { console.error(err.message); process.exitCode = 1; });';
    console.log(docker('run', '--rm', '--network', 'none', '--volumes-from', info.Id, '--entrypoint', 'node', snapshot, '-e', codice));
  } finally { docker('image', 'rm', snapshot); }
}

if (require.main === module) {
  try { migra(process.argv[2]); }
  catch (err) { console.error(err.message); process.exitCode = 1; }
}

'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
function classifica(code, scaduto, content) {
  const lines = content.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const saltati = lines.filter(s => /^\s*[^\p{L}\p{N}]*(?:SALTAT[OAIE]|SKIPPED|SKIP)\b/iu.test(s));
  const errori = lines.filter(s => /^\s*[^\p{L}\p{N}]*(?:FAIL|FAILED|FALLITO)\b/iu.test(s));
  return { esito: scaduto ? 'timeout' : code !== 0 || errori.length ? 'fallito' : saltati.length ? 'incompleto' : 'superato', saltati, errori };
}
function runSuite({ file, log, cwd, env = process.env, timeoutMs = 180000, args = [] }) {
  return new Promise(resolve => {
    const started = Date.now(), fd = fs.openSync(log, 'w');
    const child = spawn(process.execPath, [file, ...args], { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
    const rimuoviFiglio = child.pid ? require('./lock.cjs').registra(child.pid, process.platform !== 'win32') : () => {};
    let scaduto = false, spawnError;
    const termina = () => {
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    const timer = setTimeout(() => { scaduto = true; termina(); }, timeoutMs);
    child.once('error', err => { spawnError = err.message; fs.writeSync(fd, err.stack); });
    child.once('close', code => {
      clearTimeout(timer); termina(); rimuoviFiglio(); fs.closeSync(fd);
      const content = fs.readFileSync(log, 'utf8');
      resolve({ file, ...classifica(code, scaduto, content), code, ms: Date.now() - started, log, ...(spawnError ? { spawnError } : {}) });
    });
  });
}
module.exports = { runSuite, classifica };

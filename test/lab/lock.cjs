'use strict';

const fs = require('node:fs');
function vivo(pid, gruppo = false) {
  try { process.kill(gruppo ? -pid : pid, 0); }
  catch (err) { if (err.code === 'ESRCH') return false; throw err; }
  if (!gruppo || process.platform !== 'linux') return true;
  return fs.readdirSync('/proc').filter(s => /^\d+$/.test(s)).some(id => {
    try {
      const stat = fs.readFileSync(`/proc/${id}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0]);
    } catch (err) { if (err.code === 'ENOENT' || err.code === 'ESRCH') return false; throw err; }
  });
}
function creaLock(file) {
  const leggi = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  function assicuratiLibero() {
    const precedente = leggi();
    if (!precedente) return;
    const figli = (precedente.figli || []).filter(c => vivo(c.pid, c.gruppo));
    if (vivo(precedente.pid) || figli.length) throw new Error(`Campagna ${precedente.nome} ancora attiva (PID ${precedente.pid}, figli ${figli.map(c => c.pid).join(',')}): copia/esecuzione concorrente rifiutata.`);
    fs.unlinkSync(file);
  }
  function registra(pid, gruppo) {
    const current = leggi();
    if (!current || current.pid !== process.pid) return () => {};
    current.figli.push({ pid, gruppo }); fs.writeFileSync(file, JSON.stringify(current));
    return () => {
      const latest = leggi();
      if (!latest || latest.pid !== process.pid) return;
      latest.figli = latest.figli.filter(c => c.pid !== pid);
      fs.writeFileSync(file, JSON.stringify(latest));
    };
  }
  function acquisisci(nome) {
    assicuratiLibero();
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, nome, started: new Date().toISOString(), figli: [] }), { flag: 'wx' });
    const release = () => {
      const current = leggi();
      if (current?.pid === process.pid && !current.figli.some(c => vivo(c.pid, c.gruppo))) fs.unlinkSync(file);
    };
    process.once('exit', release);
    return release;
  }
  return { assicuratiLibero, acquisisci, registra };
}
module.exports = { ...creaLock('/laboratorio/campagna-attiva.json'), creaLock };

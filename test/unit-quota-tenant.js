'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.argv.includes('--mutant')) require('node:module').registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/uploadDisco.js')) return result;
  const source = String(result.source);
  assert(source.includes('await precedente;'), 'Punto di mutazione della quota assente.');
  return { ...result, source: source.replace('await precedente;', 'await Promise.resolve();') };
} });
const { createArchivioUpload } = require('../db/uploadDisco');
let completato = false;
process.once('beforeExit', () => {
  if (!completato) { console.error('FAIL: verifica della quota tenant sospesa'); process.exitCode = 1; }
});

module.exports = (async () => {
  async function concorrenti({ quota = 100, importazione = false, guasto = false, altroTenant = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-quota-'));
    const append = fs.promises.appendFile;
    let entra, libera;
    const entrato = new Promise(resolve => { entra = resolve; });
    const rilascio = new Promise(resolve => { libera = resolve; });
    let scritture = 0, secondaFinita = false;
    const options = { radicePer: owner => path.join(root, owner), quotaTenantBytes: quota, maxBytes: 80 };
    // Anche due archivi dello stesso processo devono coordinare la stessa radice.
    const a = createArchivioUpload(options), b = createArchivioUpload(options);
    const ownerB = altroTenant ? 'altro' : 'account';
    const primo = a.avvia('account', null, { esportazione: true });
    const secondo = b.avvia(ownerB, null, { esportazione: !importazione });
    let esiti;
    try {
      fs.promises.appendFile = async (file, ...args) => {
        if (!path.resolve(file).startsWith(root + path.sep)) return append(file, ...args);
        const numero = ++scritture;
        if (numero === 1) {
          entra();
          await rilascio;
          if (guasto) throw Object.assign(new Error('I/O di prova fallito'), { code: 'EIO' });
        }
        return append(file, ...args);
      };
      const prima = a.aggiungi(primo.uploadId, 'account', { offset: 0, contenuto: Buffer.alloc(80) });
      // Il gestore è registrato prima che il guasto simulato possa rigettare.
      const primaConclusa = Promise.allSettled([prima]);
      await entrato;
      const seconda = b.aggiungi(secondo.uploadId, ownerB, { offset: 0, contenuto: Buffer.alloc(80) });
      const secondaConclusa = Promise.allSettled([seconda]).then(result => { secondaFinita = true; return result; });
      if (altroTenant) {
        await Promise.race([secondaConclusa, new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Un tenant blocca quello indipendente.')), 2000);
          secondaConclusa.finally(() => clearTimeout(timer));
        })]);
        assert(secondaFinita);
      } else await new Promise(resolve => setImmediate(resolve));
      libera();
      esiti = [...await primaConclusa, ...await secondaConclusa];
      const ok = esiti.filter(result => result.status === 'fulfilled');
      if (guasto) {
        assert.equal(esiti[0].reason?.code, 'EIO');
        assert.equal(esiti[1].status, 'fulfilled', 'Un errore non deve bloccare la coda del tenant.');
      } else if (quota < 160 && !altroTenant) {
        assert.equal(ok.length, 1, 'La quota deve respingere uno dei due blocchi concorrenti.');
        assert.match(esiti.find(result => result.status === 'rejected').reason.message, /Quota disco/);
      } else assert.equal(ok.length, 2, 'Con spazio sufficiente entrambi i blocchi devono riuscire.');
      assert(a.usoTenant('account').byte <= quota, 'La quota effettiva su disco è stata superata.');
      // Il retry idempotente non consuma nuovamente spazio.
      if (esiti[1].status === 'fulfilled') assert.equal((await b.aggiungi(secondo.uploadId, ownerB,
        { offset: 0, contenuto: Buffer.alloc(80) })).ripetuto, true);
    } finally {
      libera();
      fs.promises.appendFile = append;
      assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  await concorrenti();
  await concorrenti({ importazione: true });
  await concorrenti({ quota: 160 });
  await concorrenti({ guasto: true });
  await concorrenti({ altroTenant: true });
  console.log('  OK   Quota tenant: export/import concorrenti, spazio esatto, errore I/O, retry e tenant indipendenti');
  completato = true;
})();
module.exports.catch(error => { completato = true; console.error(error); process.exitCode = 1; });

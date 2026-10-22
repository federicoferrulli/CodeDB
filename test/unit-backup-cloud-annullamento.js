'use strict';
// Adattatori reali e SDK simulati: nessuna credenziale o risorsa cloud.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Writable } = require('node:stream');

module.exports = (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-cloud-annullamento-'));
  fs.writeFileSync(path.join(root, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(root, 'z-dati.ndjson'), 'dati da conservare\n');
  try {
    for (const type of ['s3', 'gs', 'azure']) for (const annulla of [false, true]) {
      const controller = new AbortController(), inviati = [], streams = [];
      let clientChiuso = false;
      const ricevi = async (nome, signal) => {
        inviati.push(nome);
        assert.equal(signal, controller.signal, 'Il segnale arriva allo SDK');
        if (annulla) controller.abort(new Error('Backup annullato.'));
        signal.throwIfAborted();
      };
      const sdks = {
        '@aws-sdk/client-s3': {
          S3Client: class {
            async send(command, options) { streams.push(command.Body); await ricevi(command.Key, options.abortSignal); for await (const _ of command.Body) {} }
            destroy() { clientChiuso = true; }
          },
          PutObjectCommand: class { constructor(options) { Object.assign(this, options); } },
        },
        '@google-cloud/storage': { Storage: class { bucket() { return { file: nome => ({ createWriteStream() {
          inviati.push(nome);
          const stream = new Writable({ write(_data, _encoding, cb) {
            if (annulla) controller.abort(new Error('Backup annullato.'));
            else cb();
          } });
          streams.push(stream); return stream;
        } }) }; } } },
        '@azure/storage-blob': { BlobServiceClient: { fromConnectionString: () => ({ getContainerClient: () => ({
          getBlockBlobClient: nome => ({ uploadFile: (_file, options) => ricevi(nome, options.abortSignal) }),
        }) }) } },
      };
      const module = { exports: {} };
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../backup/lib/storage.js'), 'utf8'), {
        module, require: name => sdks[name] || require(name), process: { env: { AZURE_STORAGE_CONNECTION_STRING: 'fixture' } },
      });
      const upload = module.exports.uploadBackupDir({ type, bucket: 'fixture', prefix: '' }, root, { info() {} }, { signal: controller.signal });
      if (annulla) {
        await assert.rejects(upload, /annullato|aborted/i);
        assert(!inviati.some(n => n.endsWith('/manifest.json')), 'Un trasferimento parziale non pubblica il manifest');
      } else {
        await upload;
        assert(inviati.at(-1).endsWith('/manifest.json'), 'Il manifest si pubblica solo dopo tutti i dati');
      }
      assert(streams.every(s => s.destroyed), 'Gli stream di upload vengono chiusi');
      if (type === 's3') assert(clientChiuso);
      assert.equal(fs.readFileSync(path.join(root, 'z-dati.ndjson'), 'utf8'), 'dati da conservare\n');
    }
    console.log('OK cloud: S3, GCS e Azure propagano annullamento, chiudono le risorse e conservano la copia locale');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})();

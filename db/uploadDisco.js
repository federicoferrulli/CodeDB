'use strict';

/**
 * Caricamenti di artefatti scritti su disco, a blocchi, con ripresa.
 *
 * `db/importUploads.js` tiene i blocchi in memoria e alla fine fa `join` più
 * `JSON.parse`: il trasferimento a blocchi non limita la memoria, la sposta —
 * è il limite registrato in §2 del piano. Questo modulo è l'altra via, quella
 * che il piano chiede al §7: ogni blocco va in coda a un file `.part`, lo stato
 * (`scritti`, impronte dei blocchi) sta in `stato.json` reso durevole a ogni
 * scrittura, e la finalizzazione verifica dimensione e SHA-256 dichiarati
 * prima di pubblicare il file e il manifest con una rinomina atomica.
 *
 * Qui non c'è rete e non c'è autenticazione: entrano byte e identificatori
 * generati dal server, escono byte su disco e un manifest. Chi chiama non
 * sceglie mai un percorso — solo id opachi — quindi non c'è traversal da
 * difendere qui, solo da non introdurre: ogni id viene comunque validato e
 * ogni percorso è confinato nella radice del tenant.
 *
 * La decisione su ogni blocco (scrivi / già-scritto / rifiuta) è quella di
 * `db/trasferimenti.js`, non una seconda regola: due definizioni di «blocco
 * valido» divergerebbero senza che nulla lo segnali.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decidiBlocco, sha256 } = require('./trasferimenti');

const BLOCCO_RILETTURA = 1024 * 1024;

function guasto(codice, messaggio) {
  const err = new Error(messaggio);
  err.codice = codice;
  return err;
}

/** Solo id opachi generati dal server: niente `/`, niente `..`, niente assoluti. */
function idSicuro(value, cosa) {
  const s = String(value == null ? '' : value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(s) || s === '.' || s === '..') {
    throw guasto('INVALIDO', `${cosa} non valido.`);
  }
  return s;
}

/**
 * Il proprietario si VALIDA, non si riscrive: sostituire i caratteri non
 * ammessi con `_` fa condividere una cartella — e quindi gli artefatti — a due
 * tenant diversi (`a/b` e `a_b`). Gli ownerId reali sono UUID o `local`.
 */
function proprietarioSicuro(ownerId) {
  const s = String(ownerId == null ? '' : ownerId).trim();
  if (!s) throw guasto('INVALIDO', 'Proprietario del caricamento mancante.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(s) || s === '.' || s === '..') {
    throw guasto('INVALIDO', 'Proprietario del caricamento non valido.');
  }
  return s;
}

/** Il percorso deve restare dentro la radice, anche con link simbolici di mezzo. */
function dentro(radice, ...pezzi) {
  const base = path.resolve(radice);
  const target = path.resolve(base, ...pezzi);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw guasto('INVALIDO', 'Percorso fuori dalla radice del tenant.');
  }
  return target;
}

function leggiStato(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || raw.v !== 1) throw new Error('versione');
    return raw;
  } catch {
    throw guasto('NON_TROVATO', 'Caricamento non trovato o illeggibile.');
  }
}

/** Scrittura durevole: file temporaneo e rinomina, mai mezza scrittura visibile. */
function scriviAtomico(file, contenuto) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contenuto);
  fs.renameSync(tmp, file);
}

async function improntaFile(file, check) {
  const hash = crypto.createHash('sha256');
  for await (const buf of fs.createReadStream(file, { highWaterMark: BLOCCO_RILETTURA })) {
    check();
    hash.update(buf);
  }
  return hash.digest('hex');
}

async function scriviAtomicoAsync(file, contenuto) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, contenuto);
  await fs.promises.rename(tmp, file);
}

function createArchivioUpload({
  radicePer,
  id = crypto.randomUUID,
  now = () => Date.now(),
  ttlMs = Number(process.env.CODEDB_ARTEFATTI_TTL_MS) || 24 * 60 * 60 * 1000,
  maxBytes = Number(process.env.CODEDB_ARTEFATTI_MAX_BYTES) || 10 * 1024 * 1024 * 1024,
  maxChunkBytes = Number(process.env.CODEDB_ARTEFATTI_MAX_BLOCCO) || 4 * 1024 * 1024,
  // Niente tetto globale: senza un elenco dei tenant non si può contare, e un
  // limite che non si applica è peggio di nessun limite. Vale quello per owner.
  maxPerOwner = Number(process.env.CODEDB_MAX_IMPORT_UPLOADS_PER_OWNER) || 2,
  // Quota disco del tenant (parti + finali): di default illimitata, la configura
  // l'operatore. Si controlla all'avvio — il singolo upload è già vincolato
  // da maxBytes e la finalizzazione non cresce il disco (rinomina).
  quotaTenantBytes = Number(process.env.CODEDB_ARTEFATTI_QUOTA_BYTES) || Infinity,
  // Conservazione dei finalizzati: di default mai (sono artefatti dell'utente,
  // come i backup), a scadenza configurata con pulisciFinalizzatiDi.
  conservaFinaliMs = Number(process.env.CODEDB_ARTEFATTI_RETENTION_MS) || Infinity,
} = {}) {
  if (typeof radicePer !== 'function') throw new Error('Archivio upload senza radice per tenant.');
  const occupati = new Set();

  const radiceDi = (ownerId) => path.resolve(radicePer(proprietarioSicuro(ownerId)));
  const dirSessione = (ownerId, uploadId) =>
    dentro(radiceDi(ownerId), 'caricamenti', idSicuro(uploadId, 'Caricamento'));
  const fileParte = (ownerId, uploadId) => path.join(dirSessione(ownerId, uploadId), 'dati.part');
  const fileStato = (ownerId, uploadId) => path.join(dirSessione(ownerId, uploadId), 'stato.json');
  const dirFinale = (ownerId, artefattoId) =>
    dentro(radiceDi(ownerId), 'finali', idSicuro(artefattoId, 'Artefatto'));

  function sessioniAttive(root, ownerId) {
    const base = path.join(root, 'caricamenti');
    let nomi = [];
    try {
      nomi = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { return []; }
    const attive = [];
    for (const nome of nomi) {
      try {
        const stato = leggiStato(path.join(base, nome, 'stato.json'));
        if (stato.ownerId === ownerId && (occupati.has(path.join(base, nome)) || stato.toccatoAl + ttlMs > now())) attive.push(nome);
      } catch { /* incompleto o illeggibile: lo spazza pulisciScaduti */ }
    }
    return attive;
  }

  function carica(ownerId, uploadId, { attore = null, soloLettura = false } = {}) {
    const nr = idSicuro(uploadId, 'Caricamento');
    const stato = leggiStato(fileStato(ownerId, nr));
    if (stato.ownerId !== proprietarioSicuro(ownerId)) {
      throw guasto('NON_TROVATO', 'Caricamento non trovato.');
    }
    if (attore != null && stato.attore !== attore) {
      throw guasto('NON_TROVATO', 'Caricamento non trovato.');
    }
    if (stato.toccatoAl + ttlMs <= now()) {
      if (!soloLettura) scarta(nr, ownerId, attore);
      throw guasto('SCADUTO', 'Caricamento scaduto: avviane uno nuovo e riprendi da capo.');
    }
    return stato;
  }

  async function persiste(ownerId, stato) {
    stato.toccatoAl = now();
    await scriviAtomicoAsync(fileStato(stato.ownerId, stato.uploadId), JSON.stringify(stato));
    return stato;
  }

  // L'I/O asincrono non deve permettere due append, oppure scarto e
  // finalizzazione, sullo stesso file. Upload diversi restano indipendenti.
  async function modifica(uploadId, ownerId, attore, fn) {
    const dir = dirSessione(ownerId, uploadId);
    const stato = carica(ownerId, uploadId, { attore });
    if (occupati.has(dir)) throw guasto('CONFLITTO', 'Caricamento occupato: attendi l’operazione in corso.');
    occupati.add(dir);
    try { return await fn(stato); }
    finally { occupati.delete(dir); }
  }

  function scarta(uploadId, ownerId, attore = null) {
    const nr = idSicuro(uploadId, 'Caricamento');
    const dir = dirSessione(ownerId, nr);
    if (occupati.has(dir)) throw guasto('CONFLITTO', 'Caricamento occupato: attendi l’operazione in corso.');
    let stato = null;
    try { stato = leggiStato(path.join(dir, 'stato.json')); } catch { /* già sparito */ }
    if (stato) {
      if (stato.ownerId !== proprietarioSicuro(ownerId)) throw guasto('NON_TROVATO', 'Caricamento non trovato.');
      if (attore != null && stato.attore !== attore) throw guasto('NON_TROVATO', 'Caricamento non trovato.');
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  }

  function pulisciScadutiDi(ownerId, adesso = now()) {
    const base = path.join(radiceDi(ownerId), 'caricamenti');
    let nomi = [];
    try {
      nomi = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { return { rimossi: 0 }; }
    let rimossi = 0;
    for (const nome of nomi) {
      if (occupati.has(path.join(base, nome))) continue;
      try {
        const stato = leggiStato(path.join(base, nome, 'stato.json'));
        if (stato.toccatoAl + ttlMs <= adesso) {
          fs.rmSync(path.join(base, nome), { recursive: true, force: true });
          rimossi += 1;
        }
      } catch {
        fs.rmSync(path.join(base, nome), { recursive: true, force: true });
        rimossi += 1;
      }
    }
    return { rimossi };
  }

  // Quanto disco occupa il tenant fra parti e finali. Serve alla quota e al
  // rapporto, non ai percorsi: gli id restano opachi anche qui dentro.
  function usoTenant(ownerId) {
    const root = radiceDi(ownerId);
    let byte = 0;
    let sessioni = 0;
    let finalizzati = 0;
    const somma = (dir) => {
      let nomi = [];
      try {
        nomi = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch { return; }
      for (const nome of nomi) {
        for (const candidato of [path.join(dir, nome, 'dati.part'), path.join(dir, nome, 'dati.bin')]) {
          try { byte += fs.statSync(candidato).size; } catch { /* l'altro nome */ }
        }
      }
    };
    somma(path.join(root, 'caricamenti'));
    somma(path.join(root, 'finali'));
    try { sessioni = fs.readdirSync(path.join(root, 'caricamenti')).length; } catch { /* nessuna */ }
    try { finalizzati = fs.readdirSync(path.join(root, 'finali')).length; } catch { /* nessuno */ }
    return { byte, sessioni, finalizzati };
  }

  return {
    avvia(ownerId, attore = null) {
      const proprietario = proprietarioSicuro(ownerId);
      const root = radiceDi(proprietario);
      pulisciScadutiDi(proprietario);
      const attive = sessioniAttive(root, proprietario);
      if (attive.length >= maxPerOwner) {
        throw guasto('LIMITE', 'Troppi caricamenti contemporanei per questo account.');
      }
      if (usoTenant(proprietario).byte + maxBytes > quotaTenantBytes) {
        throw guasto('LIMITE', `Quota disco del tenant superata: massimo ${quotaTenantBytes} byte.`);
      }
      const uploadId = idSicuro(String(id()), 'Caricamento');
      const dir = dentro(root, 'caricamenti', uploadId);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'dati.part'), Buffer.alloc(0), { flag: 'wx' });
      } catch (err) {
        if (err.code === 'EEXIST') return this.avvia(ownerId, attore);
        throw err;
      }
      const stato = {
        v: 1, uploadId, ownerId: proprietario, attore,
        scritti: 0, impronte: {}, creatoAl: now(), toccatoAl: now(), maxBytes,
      };
      scriviAtomico(path.join(dir, 'stato.json'), JSON.stringify(stato));
      return { uploadId, maxChunkBytes, maxBytes };
    },

    aggiungi(uploadId, ownerId, { offset, contenuto, attore = null } = {}) {
      return modifica(uploadId, ownerId, attore, async stato => {
        if (!Buffer.isBuffer(contenuto) || !contenuto.length) {
          throw guasto('INVALIDO', 'Blocco vuoto o non binario.');
        }
        if (contenuto.length > maxChunkBytes) {
          throw guasto('LIMITE', `Blocco troppo grande: massimo ${maxChunkBytes} byte.`);
        }
        const impronte = new Map(Object.entries(stato.impronte || {}).map(([k, v]) => [Number(k), v]));
        const decisione = decidiBlocco({
          offset, contenuto, scritti: stato.scritti, improntePerOffset: impronte, massimo: Math.min(maxBytes, stato.maxBytes || maxBytes),
        });
        if (decisione.azione === 'rifiuta') {
          const sequenza = /fuori sequenza/i.test(decisione.motivo || '');
          const conflitto = /conflitto/i.test(decisione.motivo || '');
          throw guasto(
            conflitto ? 'CONFLITTO' : (sequenza ? 'SEQUENZA' : (/troppo grande/i.test(decisione.motivo || '') ? 'LIMITE' : 'INVALIDO')),
            decisione.motivo,
          );
        }
        if (decisione.azione === 'gia-scritto') {
          await persiste(ownerId, stato);
          return { uploadId: stato.uploadId, scritti: stato.scritti, impronta: decisione.impronta, ripetuto: true };
        }
        await fs.promises.appendFile(fileParte(ownerId, stato.uploadId), contenuto);
        stato.scritti = decisione.scritti;
        stato.impronte[String(offset)] = { impronta: decisione.impronta, lunghezza: contenuto.length };
        await persiste(ownerId, stato);
        return { uploadId: stato.uploadId, scritti: stato.scritti, impronta: decisione.impronta, ripetuto: false };
      });
    },

    stato(uploadId, ownerId, attore = null) {
      const stato = carica(ownerId, uploadId, { attore, soloLettura: true });
      return { uploadId: stato.uploadId, scritti: stato.scritti, maxBytes: stato.maxBytes || maxBytes };
    },

    finalizza(uploadId, ownerId, { dimensioneAttesa, digestAtteso, nome = null, attore = null, check = () => {} } = {}) {
      return modifica(uploadId, ownerId, attore, async stato => {
        const dimensione = Number(dimensioneAttesa);
        if (!Number.isInteger(dimensione) || dimensione < 0) {
          throw guasto('INVALIDO', 'Dimensione attesa mancante o non valida.');
        }
        const digest = String(digestAtteso || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(digest)) {
          throw guasto('INVALIDO', 'Impronta attesa mancante o non valida (SHA-256 esadecimale).');
        }
        if (stato.scritti !== dimensione) {
          throw guasto('INCOMPLETO',
            `Caricamento incompleto: ricevuti ${stato.scritti} byte, attesi ${dimensione}.`);
        }
        const effettivo = await improntaFile(fileParte(ownerId, stato.uploadId), check);
        if (effettivo !== digest) {
          throw guasto('INCOMPLETO',
            'Impronta del file non coincide con quella dichiarata: il trasferimento è corrotto o mescola due file.');
        }
        const artefattoId = idSicuro(String(id()), 'Artefatto');
        const dir = dirFinale(ownerId, artefattoId);
        check();
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.rename(fileParte(ownerId, stato.uploadId), path.join(dir, 'dati.bin'));
        const manifest = {
          v: 1, id: artefattoId, algoritmo: 'sha256', digest: effettivo, dimensione,
          nome: String(nome || `${artefattoId}.bin`).replace(/["\\\r\n]/g, '').slice(0, 120) || `${artefattoId}.bin`,
          ownerId: stato.ownerId, attore: stato.attore, finalizzatoAl: now(),
        };
        await scriviAtomicoAsync(path.join(dir, 'manifesto.json'), JSON.stringify(manifest));
        await fs.promises.rm(dirSessione(ownerId, stato.uploadId), { recursive: true, force: true });
        return manifest;
      });
    },

    scarta,
    pulisciScadutiDi,
    usoTenant,

    /**
     * Retention dei finalizzati: rimuove quelli più vecchi di conservaMs. Di
     * default conserva tutto (sono artefatti dell'utente): la scadenza si
     * configura, non si presume.
     */
    pulisciFinalizzatiDi(ownerId, { conservaMs = conservaFinaliMs, adesso = now() } = {}) {
      if (!Number.isFinite(conservaMs)) return { rimossi: 0 };
      let rimossi = 0;
      for (const manifest of this.elenca(ownerId)) {
        if (Number(manifest.finalizzatoAl) + conservaMs <= adesso) {
          fs.rmSync(dirFinale(ownerId, manifest.id), { recursive: true, force: true });
          rimossi += 1;
        }
      }
      return { rimossi };
    },

    leggiManifesto(artefattoId, ownerId) {
      const dir = dirFinale(ownerId, artefattoId);
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifesto.json'), 'utf8'));
      } catch {
        throw guasto('NON_TROVATO', 'Artefatto non trovato.');
      }
      if (!manifest || manifest.v !== 1 || manifest.id !== idSicuro(artefattoId, 'Artefatto')) {
        throw guasto('NON_TROVATO', 'Artefatto non trovato.');
      }
      if (manifest.ownerId !== proprietarioSicuro(ownerId)) {
        throw guasto('NON_TROVATO', 'Artefatto non trovato.');
      }
      return manifest;
    },

    percorsoDati(artefattoId, ownerId) {
      const manifest = this.leggiManifesto(artefattoId, ownerId);
      const file = path.join(dirFinale(ownerId, artefattoId), 'dati.bin');
      let stat;
      try { stat = fs.statSync(file); } catch {
        throw guasto('NON_TROVATO', 'Artefatto non trovato.');
      }
      if (stat.size !== manifest.dimensione) {
        throw guasto('INCOMPLETO', 'Il file finalizzato non ha più la dimensione del manifest.');
      }
      return { file, manifest };
    },

    elenca(ownerId) {
      const proprietario = proprietarioSicuro(ownerId);
      const base = dentro(radiceDi(proprietario), 'finali');
      let nomi = [];
      try {
        nomi = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch { return []; }
      const manifesti = [];
      for (const nome of nomi) {
        try { manifesti.push(this.leggiManifesto(nome, proprietario)); } catch { /* corrotto: non elencato */ }
      }
      return manifesti.sort((a, b) => a.finalizzatoAl - b.finalizzatoAl);
    },

    chiudi() { return { ok: true }; },
  };
}

module.exports = { createArchivioUpload, sha256 };

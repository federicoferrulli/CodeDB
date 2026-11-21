'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { quotaSempre } = require('./identificatori');

function puliziaImport({ strategy, type, recoveryRoot, connName }) {
  function percorso(relativo) {
    const parti = relativo.split('/');
    if (parti.length !== 2 || parti.some(p => !p || p === '.' || p === '..' || /[\\/:]/.test(p))) {
      throw new Error('Percorso della copia di recupero non valido.');
    }
    const radice = fs.realpathSync(recoveryRoot);
    let dest = radice;
    for (const parte of parti) {
      dest = path.join(dest, parte);
      if (fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) throw new Error('Collegamento simbolico nella copia di recupero.');
    }
    return dest;
  }

  function firmaManifest(dest) {
    const file = path.join(dest, 'manifest.json');
    if (!fs.lstatSync(file).isFile()) throw new Error('Manifest di recupero non valido.');
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }

  const esisteDb = async nome => (await strategy.listDatabases()).some(db => db.name === nome);
  const q = name => quotaSempre(name, type);

  async function marcaDb(nome, ruolo) {
    if (!new RegExp('__codedb_' + ruolo + '_[0-9a-f]{10}$').test(nome)) throw new Error('Nome del database tecnico inatteso.');
    if (!await esisteDb(nome)) return null;
    if (type === 'postgresql') {
      const { rows } = await strategy.pool.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [nome]);
      return rows.length ? { tipo: 'database', nome, oid: rows[0].oid } : null;
    }
    const marcatore = '_codedb_cleanup_' + crypto.randomBytes(16).toString('hex');
    if (type === 'mongodb') await strategy.client.db(nome).createCollection(marcatore);
    else await strategy.pool.query('CREATE TABLE ' + q(nome) + '.' + q(marcatore) + ' (id INTEGER PRIMARY KEY)');
    return { tipo: 'database', nome, marcatore };
  }

  async function inventarioPulizia(result) {
    const risorse = [];
    const { staging, recovery } = result;
    for (const [copia, ruolo] of [[recovery, 'recupero'], [staging, 'staging']]) {
      if (!copia?.backupDir) continue;
      const relativo = path.relative(path.resolve(recoveryRoot), path.resolve(copia.backupDir)).split(path.sep).join('/');
      const dest = percorso(relativo);
      const firma = firmaManifest(dest);
      const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
      if (manifest.connection !== connName + '__' + ruolo || manifest.id !== path.basename(dest)
          || manifest.dbType !== type || (ruolo === 'recupero' && manifest.id !== copia.id)) {
        throw new Error('La copia di recupero non appartiene a questa operazione.');
      }
      risorse.push({ tipo: 'file', relativo, firma });
    }
    for (const [nome, ruolo] of [[staging?.retained && staging.db, 'staging'], [recovery?.physicalDb, 'recupero']]) {
      if (!nome) continue;
      const db = await marcaDb(nome, ruolo);
      if (db) risorse.push(db);
    }
    if (type === 'postgresql' && (result.status !== 'completato' || staging?.inPlacePromotion) && staging?.largeObjects?.length) {
      const { rows } = await strategy.pool.query('SELECT oid, xmin::text AS versione FROM pg_largeobject_metadata WHERE oid=ANY($1::oid[])', [staging.largeObjects]);
      for (const { oid, versione } of rows) risorse.push({ tipo: 'largeObject', oid, versione });
    }
    return risorse;
  }

  // I diari storici non registravano né i percorsi né il marcatore del DB.
  // Il nome tecnico individua un gruppo di backup, ma non autorizza un DROP.
  async function inventarioStorico(voce) {
    if (Object.hasOwn(voce, 'risorse') || voce.connection !== connName || !voce.targetDb
        || !['completato', 'ripristinato_dopo_errore'].includes(voce.status) || voce.esitoIncerto) {
      throw new Error('Il diario non consente di verificare le risorse di questa operazione.');
    }
    const { recovery, staging, targetDb } = voce;
    for (const [nome, ruolo] of [[staging?.db, 'staging'], [recovery?.physicalDb, 'recupero']]) {
      if (!nome) continue;
      const suffisso = '__codedb_' + ruolo + '_';
      const prefisso = targetDb.slice(0, (type === 'mysql' ? 64 : 63) - suffisso.length - 10);
      if (nome !== prefisso + suffisso + nome.slice(-10) || !/^[0-9a-f]{10}$/.test(nome.slice(-10)) || nome === targetDb) {
        throw new Error('Il nome del database tecnico diverge dalla destinazione registrata.');
      }
      if (await esisteDb(nome)) throw new Error('Il database tecnico "' + nome
        + '" esiste senza marcatore. Verifica proprietà e contenuto e ripeti la pulizia dopo la sua gestione manuale.');
    }
    if (staging?.largeObjects?.length) {
      if (type !== 'postgresql') throw new Error('I Large Object del diario richiedono la connessione PostgreSQL originale.');
      const { rows } = await strategy.pool.query('SELECT oid FROM pg_largeobject_metadata WHERE oid=ANY($1::oid[])', [staging.largeObjects]);
      if (rows.length) throw new Error('Large Object PostgreSQL ancora presenti senza marcatore: '
        + rows.map(r => r.oid).join(', ') + '. Verifica proprietà e riferimenti della destinazione prima di intervenire manualmente.');
    }
    const risorse = [];
    const idFull = /^\d{8}-\d{6}(?:\d{3})?Z_full$/;
    async function copia(ruolo, db, idRichiesto) {
      const connessione = connName + '__' + ruolo;
      const gruppo = require('../backup/lib/engine').backupGroupDir(recoveryRoot, connessione, db, type);
      if (!fs.existsSync(gruppo)) return;
      const ids = idRichiesto ? [idRichiesto] : fs.readdirSync(gruppo).filter(n => idFull.test(n));
      if (ids.length > 1) throw new Error('Più copie nello staging storico. Verifica manualmente quale appartiene all’operazione.');
      for (const id of ids) {
        const relativo = path.basename(gruppo) + '/' + id;
        const dest = percorso(relativo);
        if (!fs.existsSync(dest)) continue;
        const firma = firmaManifest(dest);
        const { valid, manifest } = await require('../backup/lib/util').verifyBackupDir(dest);
        if (!valid || manifest.tool !== 'codedb-backup' || manifest.type !== 'full' || manifest.baseId
            || manifest.id !== id || manifest.connection !== connessione || manifest.db !== db || manifest.dbType !== type
            || firmaManifest(dest) !== firma) throw new Error('Integrità o appartenenza della copia storica non verificabile.');
        risorse.push({ tipo: 'file', relativo, firma, verificaContenuto: true });
      }
    }
    if (recovery && recovery.id !== 'empty-' + String(voce.fingerprint).slice(0, 12)) {
      if (!recovery.verified || !idFull.test(recovery.id)) throw new Error('Identificativo della copia di recupero storica non verificabile.');
      await copia('recupero', targetDb, recovery.id);
    }
    if (staging?.db) await copia('staging', staging.db, null);
    return risorse;
  }

  async function eliminaRisorsa(r) {
    if (r.tipo === 'file') {
      if (!fs.existsSync(recoveryRoot)) return;
      const dest = percorso(r.relativo);
      if (!fs.existsSync(dest)) return;
      if (r.verificaContenuto && !(await require('../backup/lib/util').verifyBackupDir(dest)).valid) {
        throw new Error('Il contenuto della copia storica è cambiato dopo la verifica.');
      }
      if (firmaManifest(dest) !== r.firma) throw new Error('La copia di recupero è cambiata.');
      fs.rmSync(dest, { recursive: true });
      return;
    }
    if (r.tipo === 'largeObject' && type === 'postgresql') {
      const { rows } = await strategy.pool.query('SELECT CASE WHEN xmin::text=$2 THEN lo_unlink(oid) ELSE 0 END AS eliminato FROM pg_largeobject_metadata WHERE oid=$1', [r.oid, r.versione]);
      if (rows.length && !rows[0].eliminato) throw new Error('Il Large Object è cambiato.');
      return;
    }
    if (r.tipo !== 'database') throw new Error('Risorsa di pulizia sconosciuta.');
    if (!await esisteDb(r.nome)) return;
    let posseduto;
    if (type === 'postgresql') {
      posseduto = (await strategy.pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1 AND oid=$2', [r.nome, r.oid])).rowCount;
    } else if (type === 'mongodb') {
      posseduto = await strategy.client.db(r.nome).listCollections({ name: r.marcatore }, { nameOnly: true }).hasNext();
    } else {
      const [rows] = await strategy.pool.query('SELECT 1 FROM information_schema.tables WHERE table_schema=? AND table_name=?', [r.nome, r.marcatore]);
      posseduto = rows.length;
    }
    if (!posseduto) throw new Error('Il database tecnico è stato sostituito o appartiene a un’altra connessione.');
    await strategy.dropDatabase(r.nome);
  }

  // Prima il DB tecnico, poi gli oggetti orfani, per ultime le copie su disco.
  return { inventarioPulizia: async result => (await inventarioPulizia(result)).sort((a, b) => (a.tipo === 'file') - (b.tipo === 'file')), inventarioStorico, eliminaRisorsa };
}

module.exports = { puliziaImport };

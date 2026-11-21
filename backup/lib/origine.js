'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { can, scopeFor, canWholeConnection } = require('../../auth/permissions');

const proprietario = p => !!p && (p.root || (p.owner && p.connScope == null));

function chiave(fileConnessioni, crea) {
  const file = fileConnessioni + '.backup-signing-key';
  try { return fs.readFileSync(file); } catch (err) {
    if (err.code !== 'ENOENT' || !crea) throw err;
  }
  const tmp = file + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(tmp, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(tmp, file); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  } finally { fs.rmSync(tmp, { force: true }); }
  return fs.readFileSync(file);
}

function autorita(file, id) {
  if (!id) return null;
  const key = chiave(file, true);
  return { id, firma: manifest => firma(key, id, manifest) };
}

function origineSessione(vault, principal, name, id) {
  if (!id) return null;
  if (vault.loadConnections(principal.ownerId)[name]?.backupOriginId !== id) {
    throw new Error('La connessione salvata è cambiata. Riaprila prima del backup.');
  }
  return autorita(vault.connectionsFileFor(principal.ownerId), id);
}

function firma(key, id, manifest) {
  if (key.length !== 32) throw new Error('Chiave di provenienza dei backup non valida.');
  const { origine: _, ...contenuto } = manifest;
  return crypto.createHmac('sha256', key).update(JSON.stringify([id, contenuto])).digest('hex');
}

function oggettiPgSelezionabili(dir, manifest, leggi) {
  const { fileDelBackup } = require('./util');
  for (const file of manifest.files.filter(f => f.kind === 'objects')) {
    // Il manifest autentica il digest. Usa gli stessi byte per verificarlo e
    // per decidere quali oggetti il restore potrebbe trasferire.
    const dati = fs.readFileSync(fileDelBackup(dir, file.path, 'oggetti PostgreSQL'));
    if (crypto.createHash('sha256').update(dati).digest('hex') !== file.sha256) return false;
    const oggetti = JSON.parse(dati.toString('utf8'));
    // Nel selettivo le viste vengono omesse, indici e trigger seguono la tabella.
    // Le routine, i tipi, le collation e le estensioni interessano lo schema.
    // Le chiavi esterne hanno un secondo bersaglio, anche in uno schema diverso.
    const attribuiti = ['views', 'indexes', 'triggers', 'sequences', 'sequenceValues'];
    if (Object.entries(oggetti).some(([tipo, valori]) =>
      !Array.isArray(valori) || (valori.length && !attribuiti.includes(tipo)))) return false;
    // Il restore riconosce anche sequenze possedute nella destinazione. Il nome
    // coincidente da solo non attribuisce il valore alla stessa tabella sorgente.
    const titolari = new Map((oggetti.sequences || []).map(s => [s.name, s.ownerTable]));
    if ((oggetti.sequenceValues || []).some(s => {
      const tabella = titolari.get(s.name);
      return !tabella || !leggi(file.schema || manifest.db, tabella);
    })) return false;
  }
  return true;
}

function verificaOrigine(principal, dir, selezione, root, vault) {
  const negato = () => new Error('Permesso di lettura mancante sull’origine del backup.');
  require('./policy').resolveBackupPath(dir, root, 'origine');
  try {
    const owner = proprietario(principal);
    let key, idFirmato;
    const chain = require('./restore').resolveChain(dir);
    for (const { manifest } of chain) {
      if (owner && !Object.hasOwn(manifest, 'origine')) continue;
      const origine = manifest.origine;
      if (!origine?.id || (idFirmato && origine.id !== idFirmato)) throw negato();
      key ||= chiave(vault.connectionsFileFor(principal.ownerId), false);
      if (origine.firma !== firma(key, origine.id, manifest)) throw negato();
      idFirmato = origine.id;
    }
    // Anche dopo la rimozione della connessione il proprietario può recuperare
    // un archivio firmato con la chiave del tenant, oppure uno storico senza firma.
    if (owner) return;
    const conns = Object.entries(vault.loadConnections(principal.ownerId));
    if (['postgresql', 'postgres'].includes(chain[0].manifest.dbType)) {
      selezione = require('../../db/pg-partizioni').selezionePartizioni(require('./inventario-entita').livelliAttivi(chain), selezione);
    }
    for (const { manifest, dir: layerDir } of chain) {
      const origine = manifest.origine;
      const attuali = conns.filter(([, cfg]) => cfg.backupOriginId === origine.id);
      if (attuali.length !== 1) throw negato();
      const connName = attuali[0][0];
      const leggi = (db, coll) => can(principal, { connName, capability: 'read', db, coll });
      if (!leggi(manifest.db, undefined)) throw negato();
      const scope = scopeFor(principal, connName)?.collections;
      if (['postgresql', 'postgres'].includes(manifest.dbType)) {
        // I Large Object appartengono al database fisico, condiviso fra gli schemi.
        if (manifest.files.some(f => ['large-object', 'large-objects'].includes(f.kind))
            && !canWholeConnection(principal, connName, 'read')) throw negato();
        if (selezione && scope?.length && !scope.includes('*')
            && !oggettiPgSelezionabili(layerDir, manifest, leggi)) throw negato();
      }
      if (!selezione && scope?.length && !scope.includes('*') && manifest.files.some(f => !f.collection)) throw negato();
      if (selezione && !selezione.every(coll => leggi(manifest.db, coll))) throw negato();
      for (const f of manifest.files) {
        if (f.collection && (!selezione || selezione.includes(f.collection)) && !leggi(f.schema || manifest.db, f.collection)) throw negato();
      }
    }
    return chain;
  } catch { throw negato(); }
}

// Il preflight controlla l'intera catena anche in un ripristino selettivo.
// Soltanto chi può verificarla tutta può vedere la diagnostica dei singoli file.
function erroreVerificaOrigine(err, principal, dir, root, vault) {
  if (proprietario(principal)) return err;
  try { verificaOrigine(principal, dir, null, root, vault); return err; }
  catch { return new Error('Verifica del backup fallita. Il proprietario della sorgente può consultare i dettagli.'); }
}

function filtraCatalogo(backups, gruppo, principal, root, vault) {
  return backups.flatMap(voce => {
    if (typeof voce.id !== 'string' || !/^[\w.-]+$/.test(voce.id) || ['.', '..'].includes(voce.id)) return [];
    try {
      const chain = verificaOrigine(principal, path.join(gruppo, voce.id), null, root, vault);
      if (!chain) return [voce];
      const { id, type, baseId, db, dbType, startedAt, endedAt } = chain.at(-1).manifest;
      return [{ id, type, baseId, db, dbType, startedAt, endedAt, status: 'ok' }];
    } catch { return []; }
  });
}

module.exports = { autorita, origineSessione, verificaOrigine, erroreVerificaOrigine, filtraCatalogo, proprietario };

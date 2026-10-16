'use strict';
const fs = require('node:fs');

// Identità esclusiva dei collaudi: non va caricata in Partner Center.
const PROVA = { identityName: 'CodeDB.ProvaStore', publisher: 'CN=CodeDB Prova Store',
  publisherDisplayName: 'CodeDB - collaudo locale', version: '1.0.0.0' };

function identita(env = process.env) {
  if (env.CODEDB_STORE_TEST && !['true', 'false'].includes(env.CODEDB_STORE_TEST)) throw new Error('CODEDB_STORE_TEST accetta true o false.');
  const prova = env.CODEDB_STORE_TEST === 'true';
  const valori = prova ? { ...PROVA } : {
    identityName: env.MICROSOFT_STORE_IDENTITY_NAME,
    publisher: env.MICROSOFT_STORE_PUBLISHER,
    publisherDisplayName: env.MICROSOFT_STORE_PUBLISHER_DISPLAY_NAME,
    version: env.MICROSOFT_STORE_VERSION,
  };
  if (Object.values(valori).some(v => typeof v !== 'string' || !v.trim())) {
    throw new Error('Configura MICROSOFT_STORE_IDENTITY_NAME, MICROSOFT_STORE_PUBLISHER, MICROSOFT_STORE_PUBLISHER_DISPLAY_NAME e MICROSOFT_STORE_VERSION con i dati di Partner Center. Per il collaudo usa build:store:test.');
  }
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(valori.identityName) || (!prova && valori.identityName === PROVA.identityName)) throw new Error('Identità Store non valida o riservata ai collaudi.');
  if (!/^CN=\S[^\r\n]*$/.test(valori.publisher) || /[\x00-\x1f]/.test(valori.publisherDisplayName)) throw new Error('Editore Store non valido. Copia i valori esatti da Partner Center.');
  const numeri = valori.version.split('.');
  if (numeri.length !== 4 || numeri.some(n => !/^(0|[1-9]\d*)$/.test(n) || Number(n) > 65535) || Number(numeri[0]) < 1 || numeri[3] !== '0') {
    throw new Error('MICROSOFT_STORE_VERSION richiede quattro interi: primo 1..65535, intermedi 0..65535, ultimo 0 (esempio 1.0.0.0). Incrementala a ogni invio.');
  }
  // Nessun certificato personale deve poter firmare per errore il pacchetto Store.
  for (const k of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'AZURE_CODE_SIGNING_ACCOUNT']) {
    if (env[k]) throw new Error(`La build Store non usa ${k}: rimuovila dall'ambiente di questo comando.`);
  }
  return { ...valori, prova };
}

function configura(base, env) {
  const id = identita(env);
  base.directories.output = 'dist/store';
  base.publish = null;
  base.extraMetadata.codedbStoreTest = id.prova;
  base.forceCodeSigning = false;
  base.win.target = ['appx'];
  base.win.signExecutable = false;
  base.win.artifactName = `CodeDB-${id.version}-store${id.prova ? '-prova' : ''}-\${arch}.\${ext}`;
  base.appx = {
    identityName: id.identityName, publisher: id.publisher, publisherDisplayName: id.publisherDisplayName,
    applicationId: 'CodeDB', displayName: id.prova ? 'CodeDB - prova Store' : 'CodeDB',
    languages: ['it-IT'], minVersion: '10.0.19041.0', maxVersionTested: '10.0.26100.0',
    capabilities: ['runFullTrust'], electronUpdaterAware: false, setBuildNumber: false,
  };
  // La versione Store è indipendente da SemVer: niente collisioni fra beta.1 e beta.2.
  base.appxManifestCreated = async file => {
    const xml = await fs.promises.readFile(file, 'utf8');
    const versioneIdentita = /(<Identity\b[^>]*\bVersion=")[^"]*(")/;
    if (!versioneIdentita.test(xml)) throw new Error('Versione Identity assente dal manifest Store.');
    const nuovo = xml.replace(versioneIdentita, (_, prima, dopo) => `${prima}${id.version}${dopo}`);
    await fs.promises.writeFile(file, nuovo);
  };
  return base;
}

module.exports = { identita, configura, PROVA };

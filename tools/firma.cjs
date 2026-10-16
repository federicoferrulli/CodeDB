'use strict';
const fs = require('node:fs');
const semver = require('semver');

function gruppo(env, nomi, obbligatorio) {
  const presenti = nomi.filter(k => typeof env[k] === 'string' && env[k].trim());
  if (!obbligatorio && presenti.length === 0) return false;
  const mancanti = nomi.filter(k => !presenti.includes(k));
  if (mancanti.length) throw new Error(`Firma incompleta: configura ${mancanti.join(', ')}.`);
  return true;
}

function valida(piattaforma, env = process.env, release = false, controllaFile = true) {
  if (piattaforma === 'win') {
    const nomi = ['AZURE_CODE_SIGNING_ENDPOINT', 'AZURE_CODE_SIGNING_ACCOUNT', 'AZURE_CERT_PROFILE',
      'AZURE_PUBLISHER_NAME', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_SUBSCRIPTION_ID'];
    const modalita = env.CODEDB_WINDOWS_SIGNING || (nomi.some(k => env[k]) ? 'azure' : 'unsigned');
    if (!['unsigned', 'azure'].includes(modalita)) throw new Error('CODEDB_WINDOWS_SIGNING accetta unsigned o azure.');
    if (modalita === 'unsigned' && nomi.some(k => env[k])) throw new Error('Firma Windows unsigned incompatibile con credenziali Azure presenti.');
    const attiva = gruppo(env, nomi, modalita === 'azure');
    if (attiva && !/^https:\/\/[a-z0-9-]+\.codesigning\.azure\.net\/?$/i.test(env.AZURE_CODE_SIGNING_ENDPOINT)) {
      throw new Error('AZURE_CODE_SIGNING_ENDPOINT deve essere un endpoint HTTPS regionale di Azure Artifact Signing.');
    }
    for (const k of ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_LINK', 'CSC_KEY_PASSWORD']) {
      if (env[k]) throw new Error(`Usa la configurazione Azure per Windows; ${k} non è supportata da questo percorso.`);
    }
    return attiva;
  }
  if (piattaforma === 'mac') {
    for (const k of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN_PROFILE']) {
      if (env[k]) throw new Error(`Questo percorso usa APPLE_ID per notarizzare; rimuovi ${k} o implementa esplicitamente un altro metodo.`);
    }
    const attiva = gruppo(env, ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'], release);
    if (attiva && !/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('APPLE_TEAM_ID deve contenere 10 caratteri alfanumerici maiuscoli.');
    return attiva;
  }
  if (piattaforma === 'android') {
    const attiva = gruppo(env, ['ANDROID_KEYSTORE_PATH', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'], release);
    if (attiva && controllaFile && !fs.statSync(env.ANDROID_KEYSTORE_PATH, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('ANDROID_KEYSTORE_PATH non indica un keystore esistente.');
    }
    if (release && !/^[1-9]\d*$/.test(env.ANDROID_VERSION_CODE || '')) throw new Error('La release richiede ANDROID_VERSION_CODE intero positivo e crescente.');
    if (env.ANDROID_VERSION_CODE && (!/^[1-9]\d*$/.test(env.ANDROID_VERSION_CODE) || Number(env.ANDROID_VERSION_CODE) > 2100000000)) {
      throw new Error('ANDROID_VERSION_CODE deve essere compreso fra 1 e 2100000000.');
    }
    return attiva;
  }
  if (piattaforma === 'gpg') {
    if (env.CODEDB_REQUIRE_GPG && !['true', 'false'].includes(env.CODEDB_REQUIRE_GPG)) throw new Error('CODEDB_REQUIRE_GPG accetta true o false.');
    const attiva = gruppo(env, ['GPG_PRIVATE_KEY', 'GPG_KEY_FINGERPRINT'], release && env.CODEDB_REQUIRE_GPG === 'true');
    if (env.GPG_PASSPHRASE && !attiva) throw new Error('GPG_PASSPHRASE configurata senza chiave GPG.');
    if (attiva && !/^[A-Fa-f0-9]{40,64}$/.test(env.GPG_KEY_FINGERPRINT)) throw new Error('GPG_KEY_FINGERPRINT deve essere il fingerprint completo, senza spazi.');
    return attiva;
  }
  if (piattaforma !== 'linux') throw new Error('Piattaforma di firma sconosciuta.');
  return false;
}

function versione(version, tag) {
  if (semver.valid(version) !== version) throw new Error('package.json deve contenere una versione SemVer canonica.');
  if (tag && tag.replace(/^v/, '') !== version) throw new Error('Il tag deve coincidere con la versione di package.json (prefisso v opzionale).');
  return { version, prerelease: semver.prerelease(version) !== null };
}

module.exports = { gruppo, valida, versione };
if (require.main === module) {
  try {
    const attiva = valida(process.argv[2], process.env, process.argv.includes('--release'), !process.argv.includes('--senza-file'));
    console.log(attiva ? 'Prerequisiti di firma completi; autenticità e validità saranno controllate durante la firma.' : 'Firma non attiva per questo pacchetto.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

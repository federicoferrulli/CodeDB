'use strict';
const { valida } = require('./firma.cjs');

function configurazione(piattaforma, env = process.env) {
  const release = env.CODEDB_RELEASE === 'true';
  if (env.CODEDB_RELEASE && !['true', 'false'].includes(env.CODEDB_RELEASE)) throw new Error('CODEDB_RELEASE accetta true o false.');
  const firmata = valida(piattaforma, env, release);
  const base = structuredClone(require('../package.json').build);
  base.forceCodeSigning = firmata;
  if (piattaforma === 'win') {
    base.win.signExecutable = firmata;
    if (firmata) base.win.azureSignOptions = {
      endpoint: env.AZURE_CODE_SIGNING_ENDPOINT,
      codeSigningAccountName: env.AZURE_CODE_SIGNING_ACCOUNT,
      certificateProfileName: env.AZURE_CERT_PROFILE,
      publisherName: env.AZURE_PUBLISHER_NAME,
      fileDigest: 'SHA256', timestampDigest: 'SHA256', timestampRfc3161: 'http://timestamp.acs.microsoft.com',
    };
  }
  if (piattaforma === 'mac') {
    base.mac.notarize = firmata;
    base.mac.hardenedRuntime = firmata;
    base.dmg.sign = firmata;
    base.mac.type = 'distribution';
    if (firmata) base.mac.identity = env.APPLE_TEAM_ID;
    // Su Apple silicon anche la prova locale ha bisogno di una firma ad hoc.
    if (!firmata) base.mac.identity = '-';
  }
  return base;
}

module.exports = () => configurazione(process.env.CODEDB_BUILD_PLATFORM);
module.exports.configurazione = configurazione;

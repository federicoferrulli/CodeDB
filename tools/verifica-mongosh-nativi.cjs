'use strict';
const {createRequire}=require('node:module');
const {satisfies}=require('semver');
function verifica(context) {
  if (context && (context.electronPlatformName !== process.platform || require('builder-util').Arch[context.arch] !== process.arch)) {
    throw new Error('I moduli nativi richiedono un runner della stessa piattaforma e architettura del pacchetto. Usa i job dedicati della pipeline.');
  }
  for(const base of [require.resolve('../package.json'),require.resolve('@mongosh/service-provider-node-driver')]) {
    const carica=createRequire(base);
    for(const nome of ['kerberos','mongodb-client-encryption']) {
      try {
        const richiesta=carica('mongodb/package.json').peerDependencies[nome];
        const versione=carica(`${nome}/package.json`).version;
        if(!satisfies(versione,richiesta)) throw new Error(`${nome} ${versione}: il driver richiede ${richiesta}`);
        carica(nome);
      }
      catch(cause) {
        throw new Error(`Modulo nativo ${nome} non caricabile: esegui npm rebuild kerberos mongodb-client-encryption con gli script di installazione abilitati prima di creare il pacchetto.`,{cause});
      }
    }
  }
  console.log('OK moduli nativi Kerberos e CSFLE per il driver CodeDB e mongosh');
}
module.exports=verifica;
if(require.main===module) verifica();

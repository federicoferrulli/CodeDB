'use strict';
// Identità NSIS separata: il collaudo non sostituisce l'installazione dell'utente.
const base=require('../../package.json').build;
module.exports={
  ...base,
  appId:'com.codedb.mongosh-test',
  productName:'CodeDBMongoshTest',
  directories:{output:'.scratch/mongosh-electron-package',buildResources:'build'},
  nsis:{...base.nsis,createDesktopShortcut:false,createStartMenuShortcut:false,runAfterFinish:false},
};

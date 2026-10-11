const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const root='test-reports/revisione-2026-10-09/mutazioni-extra';fs.mkdirSync(root,{recursive:true});
const jobs=[
 ['larghezza_mobile','test/e2e-griglia-fluidita.js','--mutant=larghezza_mobile','Le connessioni occupano tutta'],
 ['menu_mobile','test/e2e-griglia-fluidita.js','--mutant=menu_mobile','Le azioni del database'],
 ['uscita','test/e2e-uscita-editing.js','--mutant','Escape deve uscire'],
 ['bordo','test/e2e-uscita-editing.js','--mutant-bordo','Annulla è raggiungibile'],
 ['uml','test/e2e-uml.js','--mutant-colonne','colonne del campione UML'],
 ['rbac','test/e2e-rbac-ui.js','--mutant',"getByText('Sospeso'"],
 ['restore','test/e2e-workbench-reale.js','--mutant-progresso','Il backend distingue'],
];
const requested=process.argv.slice(2);
const results=requested.length&&fs.existsSync(`${root}/report.json`)?JSON.parse(fs.readFileSync(`${root}/report.json`)):[];
for(const [name,file,flag,expected] of jobs.filter(job=>!requested.length||requested.includes(job[0]))){
 const env={...process.env,CODEDB_REPORT_ROOT:`${root}/${name}`,E2E_UML_PORT:'3189',MONGO_URI:'mongodb://127.0.0.1:13717',MONGO_PORT:'13717',RBAC_PORT:'3183',WORKBENCH_MONGO_PORT:'13717',WORKBENCH_MYSQL_PORT:'13318',WORKBENCH_PG_PORT:'15438'};
 const result=spawnSync(process.execPath,[file,flag],{env,encoding:'utf8',timeout:180000});
 const log=(result.stdout||'')+(result.stderr||'');fs.writeFileSync(`${root}/${name}.log`,log);
 assert.equal(result.status,1,`${name}: la mutazione deve fallire`);assert(log.includes(expected),`${name}: errore sul comportamento protetto\n${log}`);
 results.push({name,detected:true,expected});console.log(`OK mutazione ${name}`);
 fs.writeFileSync(`${root}/report.json`,JSON.stringify(results,null,2));
}

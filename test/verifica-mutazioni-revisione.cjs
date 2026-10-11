'use strict';
// Le mutazioni viaggiano soltanto nelle risposte HTTP della fixture: il prodotto su disco resta intatto.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
process.chdir(path.resolve(__dirname,'..'));
const dir='test-reports/revisione-2026-10-09/mutazioni-attuali';
fs.mkdirSync(dir,{recursive:true});
const env={...process.env,CODEDB_REPORT_ROOT:dir};
const results=[];
for(const [mutation,expected] of Object.entries({valori:'NULL, mancante',separatore:'Il separatore modifica',menu:'Freccia sposta',densita:'Geometria touch virtuale',drawer:'Drawer chiuso',focus_drawer:'La scelta nel drawer',focus_schede:'Il riordino mantiene',schema:'Il drawer schema',schede:'Lo switcher attiva',risultati:'Editor occupa'})){
  const result=spawnSync(process.execPath,['test/e2e-revisione.js',`--mutant=${mutation}`],{encoding:'utf8',timeout:180000,env});
  fs.writeFileSync(`${dir}/mutazione-${mutation}.log`,result.stdout+result.stderr);
  const report=JSON.parse(fs.readFileSync(`${dir}/copertura-${mutation}/report.json`));
  assert.equal(result.status,1,`Mutazione ${mutation} deve fallire`);
  assert(report.failure?.includes(expected),`Mutazione ${mutation}: fallimento sul comportamento protetto, ricevuto ${report.failure}`);
  results.push({mutation,detected:true,expected});console.log(`OK mutazione ${mutation}`);
}
for(const [mutation,expected] of Object.entries({progresso:'Il progresso resta associato',concorrenza:'I ripristini concorrenti',sessione:'Il monitor rende leggibile'})){
  const result=spawnSync(process.execPath,['test/e2e-superfici.js',`--mutant=${mutation}`],{encoding:'utf8',timeout:180000,env});
  fs.writeFileSync(`${dir}/mutazione-${mutation}.log`,result.stdout+result.stderr);
  const report=JSON.parse(fs.readFileSync(`${dir}/superfici-${mutation}/report.json`));
  assert.equal(result.status,1);assert(report.failure?.includes(expected),report.failure);
  results.push({mutation,detected:true,expected});console.log(`OK mutazione ${mutation}`);
}
for(const [mutation,expected] of Object.entries({dom:'Scorrere 60 righe',colonne:'freccia modifica',connessioni:'riprende la sessione',anteprima:'Mantieni conserva',bozza:'Una bozza impedisce',navigatore:'La sezione connessioni',sheet:'La ricerca sopravvive'})){
  const result=spawnSync(process.execPath,['test/e2e-griglia-fluidita.js',mutation==='dom'?'--mutant':`--mutant=${mutation}`],{encoding:'utf8',timeout:180000,env});
  const output=result.stdout+result.stderr;fs.writeFileSync(`${dir}/mutazione-${mutation}.log`,output);
  assert.equal(result.status,1);assert(output.includes(expected),output);
  results.push({mutation,detected:true,expected});console.log(`OK mutazione ${mutation}`);
}
fs.writeFileSync(`${dir}/mutazioni.json`,JSON.stringify(results,null,2));
console.log(`OK: ${results.length} mutazioni rilevate sui comportamenti protetti`);

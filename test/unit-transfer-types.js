'use strict';
const assert=require('node:assert/strict');
const {validateLargeObjects}=require('../db/pg-references');
const ordinal=require('../db/mysql-ordinal');
module.exports=(async()=>{
  for(const oid of ['0','01','4294967296',1,'-1'])assert.throws(()=>validateLargeObjects([{oid,size:0,chunks:[]}]),/non validi/);
  assert.throws(()=>validateLargeObjects([{oid:'1',size:2,chunks:['AA==']}]),/incoerente/);
  assert.throws(()=>validateLargeObjects([{oid:'1',size:0,chunks:[]},{oid:'1',size:0,chunks:[]}]),/non validi/);
  assert.throws(()=>require('../db/pg-alias').binding({$pgReference:{kind:'text); DROP TABLE x',value:'x'}}),/non valido/);
  let warnings=[],count=0;
  const conn={query:async sql=>{
    if(sql.startsWith('SELECT @@'))return [[{mode:'STRICT_ALL_TABLES',maxErrors:64}]];
    if(sql==='SHOW WARNINGS')return [warnings];
    if(sql.startsWith('INSERT'))return [{warningStatus:count}];
    return [{}];
  }};
  warnings=[{Code:1265,Message:"Data truncated for column 'e' at row 1"}];count=1;
  await ordinal.write(conn,'INSERT',[],[{column:'e',row:1}]);
  warnings.push({Code:1265,Message:"Data truncated for column 'e' at row 2"});count=2;
  await assert.rejects(ordinal.write(conn,'INSERT',[],[{column:'e',row:1}]),/troncamenti/);
  warnings.length=1;
  await assert.rejects(ordinal.write(conn,'INSERT',[],[{column:'e',row:1}]),/troncamenti/);
  console.log('OK codec tipi: metadati LO, cast ammessi, warning ENUM per riga e warning troncati.');
})();

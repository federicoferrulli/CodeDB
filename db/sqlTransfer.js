'use strict';

const { Binary } = require('bson');
const { quotaSempre } = require('./identificatori');
const { stringifyRiga } = require('./codecFedele');

function projection(info, mysql) {
  return info.columns.filter(c=>!c.generated).map(c=>{
    const id=quotaSempre(c.name,mysql?'mysql':'postgresql');
    const type=String(c.type||c.ctype||'').toLowerCase();
    if(mysql && info.geo?.has(c.name))return `CAST(${id} AS BINARY) AS ${id}`;
    if(mysql && /^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bit)\b/.test(type))return id;
    if(mysql && /^float\b/.test(type))return `CAST(CAST(${id} AS DOUBLE) AS CHAR) AS ${id}`;
    if(mysql && /^(enum|set)\b/.test(type))return `CAST(CAST(${id} AS UNSIGNED) AS CHAR) AS ${id}`;
    const alias = !mysql && require('./pg-alias').projection(id,c);
    if(alias)return `${alias} AS ${id}`;
    return mysql?`CAST(${id} AS CHAR CHARACTER SET utf8mb4) AS ${id}`:`${id}::text AS ${id}`;
  }).join(', ') || '1 AS __codedb_vuota';
}

function encodeRow(row, columns = [], mysql = true) {
  const encoded=mysql?require('./mysql-ordinal').encode(row, columns):require('./pg-alias').encode(row,columns);
  delete encoded.__codedb_vuota;
  for(const [key,value]of Object.entries(encoded))if(Buffer.isBuffer(value))encoded[key]=new Binary(value);
  return stringifyRiga(encoded);
}

module.exports={projection,encodeRow};

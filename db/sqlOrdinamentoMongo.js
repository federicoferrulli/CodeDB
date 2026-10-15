'use strict';
// Il contenitore impedisce a $sort di scegliere il minimo/massimo elemento
// dell'array. La stessa chiave serve a confronti, finestre e MIN/MAX.
function valore(value) {
  const ranges = require('./sqlMultirangeMongo'), arrays = require('./sqlArrayValore');
  return { $let: { vars: { valoreSql: { $ifNull: [value, null] } }, in: {
    $cond: [ranges.isRange('$$valoreSql'), ranges.chiave('$$valoreSql'),
      { $cond: [arrays.isArray('$$valoreSql'), require('./sqlArrayMongo').chiave('$$valoreSql'), '$$valoreSql'] }],
  } } };
}
const chiave = value => ({ valore: valore(value) });
const candidato = value => ({ $let: { vars: { candidatoSql: { $ifNull: [value, null] } }, in: {
  $cond: [{ $eq: ['$$candidatoSql', null] }, null, { chiave: chiave('$$candidatoSql'), valore: '$$candidatoSql' }],
} } });
function estremo(name, values) {
  return { $let: { vars: { estremoSql: { [name === 'MIN' ? '$min' : '$max']: {
    $map: { input: values, as: 'elementoSql', in: candidato('$$elementoSql') },
  } } }, in: { $ifNull: ['$$estremoSql.valore', null] } } };
}
module.exports = { valore, chiave, candidato, estremo };

'use strict';
function espressione(value, names) {
  if (!value || typeof value !== 'object' || value._bsontype) return false;
  if (value.domain && names.has(value.domain)) return true;
  return Object.values(value).some(v => espressione(v, names));
}
function tokens(source) {
  const result = new Set(), stack = [];
  for (let i = 0; i < source.length; i++) {
    const word = String(source[i].value).toUpperCase();
    if (word === '(') stack.push(String(source[i - 1]?.value).toUpperCase());
    if (word === ')') stack.pop();
    if (word === '::' || word === 'AS' && stack.at(-1) === 'CAST') {
      const p = new (require('./SqlToMql').Parser)(source.slice(i + 1));
      const type = require('./sqlSchemaMongo').tipo(p, true);
      if (type.domain) result.add(type.domain);
    }
  }
  return result;
}
function routine(plan, names) {
  return plan.params.some(p => names.has(p.domain)) || plan.bound && [...tokens(plan.sourceTokens)].some(t => names.has(t));
}
module.exports = { espressione, tokens, routine };

'use strict';

const assert = require('assert');
const { catalogoEventi, politiche } = require('./server-fixture');
const eventi = catalogoEventi();
const policy = politiche();
const actual = eventi.map(({ evento, famiglia }) => ({ evento, famiglia })).sort((a, b) => a.evento.localeCompare(b.evento));
assert.deepStrictEqual(actual, require('./server-eventi-attesi.json'), 'Ogni evento preesistente conserva nome e famiglia');
assert.strictEqual(new Set(eventi.map(e => e.evento)).size, eventi.length, 'Nessun evento duplicato');
const famiglie = {
  safeOn: policy.ECCEZIONI_VIA_GENERICA,
  amministrativo: policy.EVENTI_AMMINISTRATIVI,
  operazioneLunga: policy.OPERAZIONI_LUNGHE,
};
for (const [famiglia, tabella] of Object.entries(famiglie)) {
  assert.deepStrictEqual(eventi.filter(e => e.famiglia === famiglia).map(e => e.evento).sort(), Object.keys(tabella).sort(),
    famiglia + ': ogni dichiarazione corrisponde a un handler reale');
}
for (const e of eventi.filter(e => e.famiglia === 'amministrativo')) {
  assert(!/\.strategy\b|\bsessions\.get\(/.test(e.handler.toString()), e.evento + ': amministrativo senza accesso alla strategia');
}
const dichiarati = Object.values(famiglie).flatMap(Object.keys);
assert.strictEqual(new Set(dichiarati).size, dichiarati.length, 'Le famiglie non si sovrappongono');
console.log('  OK   94 eventi: registrazione reale, compatibilità completa e famiglie disgiunte');

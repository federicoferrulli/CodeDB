'use strict';

const { chiaveIdentita } = require('./identity');

const SEMANTICA_CANCELLAZIONI = Object.freeze({
  version: 1,
  representation: 'identity-tombstones',
  order: 'delete-before-upsert',
});

function dichiarazioneCancellazioni() {
  return { ...SEMANTICA_CANCELLAZIONI };
}

function semanticaCancellazioni(manifest) {
  const versione = Number(manifest && manifest.version || 1);
  const dichiarata = manifest && manifest.deletions;
  const completa = versione >= 3
    && dichiarata
    && dichiarata.version === SEMANTICA_CANCELLAZIONI.version
    && dichiarata.representation === SEMANTICA_CANCELLAZIONI.representation
    && dichiarata.order === SEMANTICA_CANCELLAZIONI.order;
  return {
    completa: !!completa,
    motivo: completa ? null : 'La catena storica non dichiara tombstone di cancellazione: il restore resta leggibile ma non prova equivalenza completa.',
  };
}

function equivalenzaCatena(chain) {
  const layers = Array.isArray(chain) ? chain : [];
  if (layers.length === 1 && layers[0].manifest && layers[0].manifest.type === 'full') {
    return { completa: true, motivo: null };
  }
  const incompleto = layers.find((layer) => !semanticaCancellazioni(layer.manifest).completa);
  return incompleto ? semanticaCancellazioni(incompleto.manifest) : { completa: true, motivo: null };
}

function identitaDellaRiga(riga, identity) {
  return Object.fromEntries(identity.columns.map((colonna) => [colonna, riga[colonna]]));
}

function applicaRighe(stato, righe, identity) {
  for (const riga of righe || []) stato.set(chiaveIdentita(riga, identity), identitaDellaRiga(riga, identity));
  return stato;
}

function applicaTombstone(stato, tombstone, identity) {
  for (const riga of tombstone || []) stato.delete(chiaveIdentita(riga, identity));
  return stato;
}

function calcolaTombstone(precedenti, correnti) {
  const rimossi = [];
  for (const [chiave, identita] of precedenti || []) {
    if (!correnti.has(chiave)) rimossi.push(identita);
  }
  return rimossi;
}

module.exports = {
  SEMANTICA_CANCELLAZIONI,
  dichiarazioneCancellazioni,
  semanticaCancellazioni,
  equivalenzaCatena,
  identitaDellaRiga,
  applicaRighe,
  applicaTombstone,
  calcolaTombstone,
};

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
  const latest = new Map();
  for (const layer of layers) for (const file of layer.manifest.files || []) {
    if (file.kind === 'data') latest.set(file.collection, { file, manifest: layer.manifest });
  }
  for (const { file, manifest } of latest.values()) {
    if (file.mode === 'full') continue;
    if (!semanticaCancellazioni(manifest).completa) return semanticaCancellazioni(manifest);
    if (file.content?.version === 1 && file.content.mode === 'content-delta' && file.content.complete === true) continue;
    return { completa: false, motivo: file.content?.mode === 'explicit-filter'
      ? 'Il filtro temporale esplicito conserva la selezione richiesta, ma non prova equivalenza con l’intera sorgente.'
      : 'Il delta storico non dichiara un confronto completo del contenuto: le date e i tombstone non provano tutte le modifiche.' };
  }
  return { completa: true, motivo: null };
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

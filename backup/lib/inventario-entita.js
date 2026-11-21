'use strict';

// I file dati elencano anche le entità vuote. Una selezione può attestare
// l'assenza dei soli nomi richiesti, una fotografia integrale dell'intero DB.
function inventarioEntita(precedenti, presenti, selezione) {
  const attuali = new Set(presenti);
  const richiesti = selezione ? [...new Set(selezione)].sort() : null;
  const coperti = richiesti && new Set(richiesti);
  return {
    scope: richiesti ? 'selection' : 'all', selection: richiesti,
    removed: [...precedenti].filter(n => !attuali.has(n) && (!coperti || coperti.has(n))).sort(),
  };
}

function validaCopertura(manifest, precedenti) {
  const inv = manifest.entityInventory;
  const presenti = manifest.files.filter(f => f.kind === 'data').map(f => f.collection);
  if (!inv && Number(manifest.version || 1) < 6) return;
  const nomi = a => Array.isArray(a) && a.every(n => typeof n === 'string' && n.length) && new Set(a).size === a.length;
  if (!inv || !nomi(inv.removed) || (inv.scope === 'all' ? inv.selection !== null :
      inv.scope !== 'selection' || !nomi(inv.selection) || presenti.some(n => !inv.selection.includes(n)))) {
    throw new Error('Inventario delle entità del backup non valido.');
  }
  if (precedenti) {
    const atteso = inventarioEntita(precedenti, presenti, inv.selection);
    if (JSON.stringify(atteso.removed) !== JSON.stringify([...inv.removed].sort())) {
      throw new Error('Rimozioni di entità incoerenti con la catena del backup.');
    }
  }
}

function ultimaRimozione(chain) {
  const ultima = new Map();
  chain.forEach(({ manifest }, i) => {
    for (const nome of manifest.entityInventory?.removed || []) ultima.set(nome, i);
  });
  return ultima;
}

function livelliAttivi(chain) {
  const ultime = ultimaRimozione(chain);
  if (!ultime.size) return chain;
  return chain.map((layer, i) => ({ ...layer, manifest: { ...layer.manifest,
    files: layer.manifest.files.filter(f => !ultime.has(f.collection) || i > ultime.get(f.collection)),
  } }));
}

module.exports = { inventarioEntita, validaCopertura, ultimaRimozione, livelliAttivi };

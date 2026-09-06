// I metadati di scrittura non sono colonne: la WeakMap non contamina copia,
// JSON, grafici o nomi reali, neppure quando una colonna si chiama `_id`.
const metadatiRighe = new WeakMap();

export function preparaRighe(res) {
  if (!Array.isArray(res.docs)) return res;
  for (const [i, doc] of res.docs.entries()) {
    if (!doc || typeof doc !== 'object') continue;
    metadatiRighe.set(doc, {
      id: res.rowIds ? res.rowIds[i] : doc._id,
      idReale: Array.isArray(res.rowIds),
      colonne: res.columnMeta || {},
    });
  }
  return res;
}

export function identitaRiga(doc) {
  return metadatiRighe.has(doc) ? metadatiRighe.get(doc).id : doc._id;
}

export function idOf(doc) {
  return JSON.stringify(identitaRiga(doc));
}

export function campoScrivibile(doc, campo, meta = {}) {
  if (!doc || !('_id' in doc) || campo === undefined) return false;
  const info = metadatiRighe.get(doc);
  return !meta.generated && !info?.colonne[campo]?.generated
    && (campo !== '_id' || info?.idReale === true);
}

export function documentoModificabile(doc) {
  return Object.fromEntries(Object.entries(doc).filter(([campo]) => campoScrivibile(doc, campo)));
}

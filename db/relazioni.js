'use strict';

function raggruppaVincoli(righe) {
  const gruppi = new Map();
  for (const r of righe || []) {
    if (!r || !r.nome || !r.campo || !r.tabella || !r.colonna) continue;
    const chiave = `${r.nome}\0${r.db || ''}\0${r.tabella}`;
    let gruppo = gruppi.get(chiave);
    if (!gruppo) {
      gruppo = {
        nome: String(r.nome), db: r.db || '', tabella: String(r.tabella),
        origine: 'vincolo', molti: false, coppie: [],
      };
      gruppi.set(chiave, gruppo);
    }
    gruppo.coppie.push({
      campo: String(r.campo), colonna: String(r.colonna), ordine: Number(r.ordine) || gruppo.coppie.length + 1,
    });
  }
  return [...gruppi.values()].map((g) => {
    g.coppie.sort((a, b) => a.ordine - b.ordine);
    g.campo = g.coppie[0].campo;
    g.colonna = g.coppie[0].colonna;
    return g;
  });
}

module.exports = { raggruppaVincoli };

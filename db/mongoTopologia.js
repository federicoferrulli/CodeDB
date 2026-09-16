'use strict';

/**
 * La topologia MongoDB decide che cosa il dump può promettere — e va scritta
 * nel manifest, non presunta.
 *
 * Un cursore ordinario non è una snapshot globale su nessuna topologia; una
 * snapshot con `readConcern: snapshot` esiste solo su replica set e sharding
 * (e sullo sharding con le sue regole su `atClusterTime`). Pretendere una
 * consistenza che la topologia non offre è la promessa che il piano vieta
 * (§5): qui si CLASSIFICA la topologia dalla risposta a `hello` e la si
 * DICHIARA, così il manifest dice sempre in che modo è stato letto.
 *
 * `hello` non deve mai rompere un dump: se non risponde, la topologia è
 * `sconosciuta` e la coerenza resta dichiaratamente assente.
 */

function classificaTopologia(risposta) {
  const h = risposta && typeof risposta === 'object' ? risposta : {};
  if (h.msg === 'isdbgrid') return 'sharded';
  // Il discriminante è il nome del set: anche uno standalone si dichiara
  // scrivibile (`isWritablePrimary`), ma non appartiene a nessun set.
  if (typeof h.setName === 'string' && h.setName) return 'replica';
  if (h.secondary === true || h.arbiterOnly === true) return 'replica';
  if (Object.keys(h).length) return 'standalone';
  return 'sconosciuta';
}

async function leggiTopologia(client) {
  let risposta = null;
  try {
    risposta = await client.db('admin').command({ hello: 1 });
  } catch {
    risposta = null;
  }
  const topologia = classificaTopologia(risposta);
  return {
    motore: 'mongodb',
    topologia,
    // Il motore incorporato legge con un cursore ordinario: nessuna snapshot
    // globale su nessuna topologia. Se un giorno si certifica un percorso
    // snapshot, sarà QUESTO campo a dirlo, non un commento.
    snapshot: false,
    avviso: topologia === 'sconosciuta'
      ? 'Topologia MongoDB non rilevata: nessuna garanzia di consistenza globale.'
      : `MongoDB ${topologia}: lettura con cursore ordinario, senza snapshot globale.`,
  };
}

module.exports = { classificaTopologia, leggiTopologia };

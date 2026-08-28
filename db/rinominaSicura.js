'use strict';

const crypto = require('crypto');

function pianoRinomina(dbType, nativa) {
  if (nativa) return Object.freeze({
    dbType, garanzia: 'rinomina-atomica-dbms', eliminaOrigine: true,
    descrizione: 'Il DBMS rinomina lo stesso oggetto in un solo comando atomico.',
  });
  return Object.freeze({
    dbType, garanzia: 'copia-verificata-origine-conservata', eliminaOrigine: false,
    descrizione: 'Il DBMS non offre una rinomina atomica né un lock di scrittura limitato al database: CodeDB verifica la copia corrente e conserva l’origine.',
  });
}

async function improntaDatabase(strategy, db) {
  const hash = crypto.createHash('sha256');
  const collezioni = (await strategy.listCollections(db))
    .filter((c) => c.type !== 'view' && !String(c.name).startsWith('system.'))
    .map((c) => String(c.name)).sort();
  let righe = 0;
  for (const coll of collezioni) {
    hash.update(`\0collection\0${coll}\0`);
    let skip = 0;
    let after = null;
    // collectionExport calcola il totale solo sul primo blocco: va conservato
    // da lì, non riletto da ogni pagina (vedi backup/lib/engine.js).
    let total = null;
    const limit = 1000;
    for (;;) {
      const pagina = await strategy.collectionExport(db, coll, { format: 'json', skip, after, limit });
      for (const line of pagina.lines || []) { hash.update(String(line)); hash.update('\n'); righe += 1; }
      skip += Number(pagina.count) || 0;
      if (pagina.nextAfter != null) after = pagina.nextAfter;
      if (pagina.total != null) total = Number(pagina.total);
      if (!pagina.count || pagina.count < limit || (total != null && skip >= total)) break;
    }
  }
  return { sha256: hash.digest('hex'), collezioni, righe };
}

function confrontaStatoCorrente(origine, destinazione) {
  const uguale = origine.sha256 === destinazione.sha256
    && origine.righe === destinazione.righe
    && JSON.stringify(origine.collezioni) === JSON.stringify(destinazione.collezioni);
  return {
    ok: uguale,
    origine,
    destinazione,
    differenze: uguale ? [] : ['Lo stato corrente dell’origine non coincide con la destinazione verificata.'],
  };
}

module.exports = { pianoRinomina, improntaDatabase, confrontaStatoCorrente };

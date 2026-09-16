/**
 * Il mapping dei nomi per l'import: logica pura, senza DOM.
 *
 * Il wizard (§3 del piano, passo «destinazione e mapping») assegna a ogni
 * oggetto dell'artefatto un nome nella destinazione. Tre cose possono andare
 * storte, tutte silenziose se nessuno le elenca:
 *
 *  · due oggetti diversi finiscono sullo STESSO nome (rinomina incrociata);
 *  · su PostgreSQL `Prova` e `prova` sono la STESSA tabella quando non
 *    quotata — il motore abbassa i nomi, e il mapping deve dirlo prima di
 *    scrivere, non dopo aver sovrascritto;
 *  · il nome esiste già nella destinazione (collisione con l'esistente), che
 *    la politica per oggetto (crea/append/merge/sostituisci) dovrà risolvere
 *    — ma prima va VISTA.
 *
 * Qui non si decide la politica e non si tocca alcun database: entrano nomi,
 * esce il mapping con gli avvisi. Il wizard la importa così com'è.
 */

function piega(nome, motore) {
  const n = String(nome == null ? '' : nome).trim();
  // PostgreSQL abbassa gli identificatori non quotati: due nomi che differiscono
  // solo per maiuscole collidono davvero. MySQL e MongoDB conservano la forma.
  if (String(motore || '').toLowerCase() === 'postgresql') return n.toLowerCase();
  return n;
}

/**
 * @param {object} opts
 * @param {string[]} opts.sorgenti nomi nell'artefatto
 * @param {string[]} [opts.esistenti] nomi già nella destinazione
 * @param {string} [opts.motore] per la piegatura delle maiuscole
 * @param {Record<string,string>} [opts.rinomina] da nome-sorgente a nome-destinazione
 */
export function mappaNomi({ sorgenti = [], esistenti = [], motore = '', rinomina = {} } = {}) {
  const visti = new Map();
  const mapping = [];
  const avvisi = [];
  const piegatiEsistenti = new Map();
  for (const e of esistenti) {
    const p = piega(e, motore);
    if (!piegatiEsistenti.has(p)) piegatiEsistenti.set(p, e);
  }

  for (const grezzo of sorgenti) {
    const da = String(grezzo == null ? '' : grezzo);
    if (!da.trim()) throw new Error('Nome sorgente vuoto nel mapping.');
    const chiesto = rinomina[da] != null ? String(rinomina[da]) : da;
    if (!chiesto.trim()) throw new Error(`Destinazione vuota per "${da}".`);
    const piegato = piega(chiesto, motore);
    const primo = visti.get(piegato);
    if (primo && primo !== da) {
      avvisi.push({ tipo: 'collisione-sorgenti', da, altro: primo, a: chiesto });
    } else if (primo !== da) {
      visti.set(piegato, da);
    }
    const occupato = piegatiEsistenti.get(piegato);
    // Stessa forma piegata ma nome diverso: su PostgreSQL è la stessa tabella
    // (il motore abbassa i nomi non quotati). Altrove non accade mai, perché
    // la piegatura è l'identità e la chiave coincide col nome.
    if (occupato != null && occupato !== chiesto) {
      avvisi.push({ tipo: 'fold-maiuscole', da, a: chiesto, esistente: occupato });
    } else if (occupato != null) {
      avvisi.push({ tipo: 'esiste-gia', da, a: chiesto });
    }
    mapping.push({ da, a: chiesto });
  }
  return { mapping, avvisi };
}

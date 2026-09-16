/**
 * Il riepilogo di un piano per l'anteprima: logica pura, senza DOM.
 *
 * Il wizard deve mostrare, prima della conferma, ESATTAMENTE ciò che
 * l'esecuzione eseguirà — ed entrambi guardano lo stesso oggetto, identificato
 * dall'impronta. Questo modulo non decide nulla: legge il piano e lo riduce a
 * titolo, voci e avvisi. Se una voce manca qui, il wizard non la mostra, e una
 * conferma data senza vederla non è informata.
 *
 * Accetta i tre piani (`export-database`, `import-database`,
 * `restore-backup`); senza impronta non è un contratto e viene rifiutato.
 */

function elenco(valori, limite = 5) {
  const lista = valori.slice(0, limite).join(', ');
  return valori.length > limite ? `${lista}, +${valori.length - limite}` : lista;
}

function exige(piano, campo) {
  const v = piano[campo];
  if (v == null || v === '') throw new Error(`Piano senza ${campo === 'fingerprint' ? 'impronta' : campo}: non è un'anteprima valida.`);
  return v;
}

export function riepilogoPiano(piano) {
  if (!piano || typeof piano !== 'object') throw new Error('Piano mancante.');
  const fingerprint = exige(piano, 'fingerprint');
  const voci = [];
  const avvisi = [];
  const voce = (etichetta, valore) => voci.push({ etichetta, valore: String(valore) });

  if (piano.kind === 'export-database') {
    const oggetti = Array.isArray(piano.oggetti) ? piano.oggetti : [];
    const conDati = oggetti.filter((o) => o.dati);
    const soloStruttura = oggetti.filter((o) => o.struttura && !o.dati);
    voce('Origine', `${piano.connection} · ${piano.sourceDb} (${piano.dbType})`);
    voce('Modalità', piano.modalita);
    voce('Oggetti', oggetti.length);
    voce('Con dati', conDati.length);
    voce('Solo struttura', soloStruttura.length);
    voce('Esclusi', (piano.esclusi || []).length);
    if ((piano.esclusi || []).length) voce('Esclusi (primi)', elenco(piano.esclusi.map((e) => e.id)));
    voce('Dipendenze aggiunte', (piano.dipendenzeAggiunte || []).length);
    voce('Prerequisiti esterni', (piano.prerequisitiEsterni || []).length);
    voce('Dipendenze non deducibili', (piano.dipendenzeNonDeducibili || []).length);
    voce('Vincoli omessi', (piano.vincoliOmessi || []).length);
    voce('Verifica', piano.verifica && piano.verifica.dati ? `dati: ${piano.verifica.dati}` : 'solo artefatto');
    for (const d of piano.dipendenzeDati || []) {
      avvisi.push(`${d.da} senza dati di ${d.a}: righe orfane nella destinazione (${d.stato}).`);
    }
    for (const v of piano.vincoliOmessi || []) {
      avvisi.push(`Vincolo da ${v.da} verso ${v.a}: bersaglio fuori perimetro, non ricreabile.`);
    }
    for (const d of piano.dipendenzeNonDeducibili || []) {
      avvisi.push(`${d.da}: ${d.nota}.`);
    }
    return { kind: piano.kind, titolo: `Export ${piano.sourceDb}`, fingerprint, voci, avvisi };
  }

  if (piano.kind === 'import-database' || piano.kind === 'restore-backup') {
    const collezioni = Array.isArray(piano.collections) ? piano.collections : [];
    const righe = collezioni.reduce((s, c) => s + (Number(c.rows) || 0), 0);
    const origine = piano.kind === 'restore-backup' ? 'catena di backup' : piano.sourceDb;
    voce('Origine', `${origine} (${piano.dbType})`);
    voce('Destinazione', `${piano.connection} · ${piano.targetDb}`);
    voce('Oggetti', collezioni.length);
    voce('Righe/documenti', righe);
    voce('Sostituisce la destinazione', piano.drop ? 'sì' : 'no');
    voce('Promozione', piano.promotion && piano.promotion.kind
      ? `${piano.promotion.kind}${piano.promotion.atomic ? ' (atomica)' : ''}`
      : 'non dichiarata');
    if (piano.kind === 'restore-backup' && piano.source && Array.isArray(piano.source.layers)) {
      voce('Livelli della catena', piano.source.layers.length);
    }
    if (piano.drop) avvisi.push('La destinazione verrà sostituita: esiste una copia di recupero.');
    return { kind: piano.kind, titolo: `Import verso ${piano.targetDb}`, fingerprint, voci, avvisi };
  }

  throw new Error(`Tipo di piano sconosciuto: "${piano.kind}".`);
}

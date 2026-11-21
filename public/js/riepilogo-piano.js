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

export const nomeCopiaMongo = 'Copia in un altro database MongoDB';
export const nomeScriptMongo = 'Scarica lo script di copia per mongosh (.js)';

export function conteggiCopiaMongo(risultato) {
  const etichette = {
    inseriti: 'Documenti inseriti', aggiornati: 'Documenti aggiornati', sostituiti: 'Documenti sostituiti', mantenuti: 'Documenti mantenuti',
    collectionCreate: 'Collection create', collectionRicreate: 'Collection ricreate', visteCreate: 'Viste create', visteRicreate: 'Viste ricreate',
  };
  return Object.entries(etichette).filter(([campo]) => Number.isSafeInteger(risultato?.[campo]))
    .map(([campo, etichetta]) => ({ campo, etichetta, valore: risultato[campo] }));
}

export function scelteScriptExport(dbType) {
  if (dbType === 'mongodb') return {
    struttura: { etichetta: 'Collection e viste nello script', valori: {
      crea: 'Crea (errore se esiste)',
      'se-assente': 'Crea solo se assente',
      ricrea: 'Elimina e ricrea',
    } },
    dati: { etichetta: 'Documenti nello script', valori: {
      inserisci: 'Inserisci (errore su _id duplicato)',
      mantieni: 'Mantieni il documento esistente',
      aggiorna: 'Aggiorna i campi del documento',
      sostituisci: 'Sostituisci l’intero documento',
    } },
  };
  const mysql = dbType === 'mysql';
  return {
    struttura: { etichetta: 'Tabelle nello script', valori: {
      crea: 'Crea (CREATE TABLE)',
      'se-assente': 'Crea solo se assente (IF NOT EXISTS)',
      ricrea: 'Elimina e ricrea (DROP TABLE IF EXISTS)',
    } },
    dati: { etichetta: 'Righe nello script', valori: {
      insert: 'Inserisci (INSERT)',
      aggiorna: mysql ? 'Aggiorna i duplicati (ON DUPLICATE KEY UPDATE)' : 'Aggiorna i duplicati (ON CONFLICT DO UPDATE)',
      ignora: 'Mantieni la riga esistente',
      ...(mysql ? { replace: 'Sostituisci i duplicati (REPLACE INTO)' } : {}),
    } },
  };
}

export function noteScriptExport(dbType, struttura, dati, tipiDaRicreare = []) {
  const note = [];
  if (dbType === 'mongodb') {
    if (struttura === 'ricrea') {
      if (tipiDaRicreare.includes('collection')) note.push('Le collection da ricreare perdono tutti i documenti e gli indici presenti nella destinazione.');
      if (tipiDaRicreare.includes('vista')) note.push('Le viste da ricreare vengono eliminate e ridefinite.');
    }
    if (struttura === 'se-assente') note.push('Le collection e le viste già presenti mantengono la propria definizione.');
    if (dati === 'mantieni') note.push('Vengono inseriti solo i documenti con un _id nuovo.');
    if (dati === 'aggiorna') note.push('Per lo stesso _id, i campi di primo livello presenti nell’origine sovrascrivono quelli della destinazione, compresi interi sottodocumenti e array. Gli altri campi vengono conservati e gli _id nuovi vengono inseriti.');
    if (dati === 'sostituisci') note.push('Per lo stesso _id, il documento di origine sostituisce quello esistente, eliminando anche i campi assenti nell’origine. I documenti con _id nuovi vengono inseriti.');
    return note;
  }
  if (struttura === 'ricrea') note.push('Quando esegui lo script, ogni tabella da ricreare perde tutti i dati presenti.');
  if (struttura === 'se-assente') note.push('Le tabelle già presenti mantengono la propria struttura.');
  if (dati === 'replace') note.push('REPLACE elimina le righe in conflitto e inserisce la riga esportata. Le chiavi esterne con ON DELETE CASCADE possono eliminare anche righe figlie.');
  if (dati === 'ignora' && dbType === 'mysql') note.push('Su MySQL la riga esistente conserva i valori e possono scattare i trigger di aggiornamento.');
  if (dati === 'aggiorna' && dbType !== 'mysql') note.push('Il conflitto viene risolto sulla chiave primaria o su un indice univoco compatibile. Un conflitto su un’altra chiave può fermare lo script.');
  return note;
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
    const destinazione = piano.destinazioneMongo;
    voce('Origine', `${piano.connection} · ${piano.sourceDb} (${piano.dbType})`);
    if (destinazione) voce('Destinazione', `${destinazione.connection} · ${destinazione.db}`);
    voce('Modalità', piano.modalita);
    let titolo = `Export ${piano.sourceDb}`;
    if (piano.formato === 'mongosh') {
      titolo = destinazione ? 'Conferma la copia su MongoDB' : 'Conferma il download dello script';
      voce('Operazione', destinazione ? nomeCopiaMongo : nomeScriptMongo);
    } else voce('Formato', piano.formato);
    if (piano.formato === 'sql' || piano.formato === 'mongosh') {
      const mongo = piano.formato === 'mongosh';
      const scelte = scelteScriptExport(piano.dbType);
      const struttura = (mongo ? piano.opzioniMongo?.collection : piano.opzioniSql?.tabelle) || 'crea';
      const dati = mongo ? piano.opzioniMongo?.documenti || 'inserisci' : piano.opzioniSql?.righe || 'insert';
      const strutture = oggetti.filter(o => o.struttura && (mongo ? ['collection', 'vista'].includes(o.tipo) : o.tipo === 'tabella'));
      const daRicreare = strutture.filter(o => !o.aggiuntoPerDipendenza);
      const politica = struttura === 'ricrea' && !daRicreare.length ? 'se-assente' : struttura;
      if (strutture.length) voce(destinazione ? 'Collection e viste' : scelte.struttura.etichetta, scelte.struttura.valori[politica]);
      if (conDati.length) voce(destinazione ? 'Documenti' : scelte.dati.etichetta, scelte.dati.valori[dati]);
      if (daRicreare.length && politica === 'ricrea') {
        voce(mongo ? 'Oggetti da ricreare' : 'Tabelle da ricreare', daRicreare.map(o => mongo ? `${o.nome} (${o.tipo})` : o.nome).join(', '));
      }
      avvisi.push(...noteScriptExport(piano.dbType, strutture.length ? politica : null, conDati.length ? dati : null,
        mongo ? daRicreare.map(o => o.tipo) : []));
    }
    voce('Consistenza', piano.consistenza);
    if (!destinazione) voce('Dimensione file', 'Senza limite');
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
    return { kind: piano.kind, titolo, fingerprint, voci, avvisi };
  }

  if (piano.kind === 'import-database' || piano.kind === 'restore-backup') {
    const collezioni = Array.isArray(piano.collections) ? piano.collections : [];
    const righe = collezioni.reduce((s, c) => s + (Number(c.rows) || 0), 0);
    const origine = piano.kind === 'restore-backup' ? 'catena di backup' : piano.sourceDb;
    voce('Origine', `${origine} (${piano.dbType})`);
    voce('Destinazione', `${piano.connection} · ${piano.targetDb}`);
    const viste = piano.views || [];
    voce('Oggetti', collezioni.length + viste.length);
    if (viste.length) voce('Viste', elenco(viste));
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

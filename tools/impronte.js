#!/usr/bin/env node
'use strict';

/* ---------------------------------------------------------------------------
 * IMPRONTE DI PROVENIENZA — verifica passiva della derivazione del codice.
 *
 * A cosa serve. CodeDB è AGPL-3.0: copiarlo, modificarlo e ridistribuirlo è
 * permesso, a condizione di pubblicare le modifiche e conservare l'attribuzione.
 * Chi non rispetta quelle condizioni, però, di solito **rinomina**: cambia il
 * nome del prodotto, traduce i commenti, riscrive il README. Dopo quel
 * passaggio, dire "questo è il mio codice" torna difficile.
 *
 * Questo strumento non impedisce niente e non danneggia nessuno: si limita a
 * riconoscere un insieme di scelte arbitrarie che questo progetto ha fatto e
 * che nessuno riprodurrebbe per caso in modo indipendente — costanti calibrate
 * a mano, ordini di valori, nomi di formati scritti nei file degli utenti. È lo
 * stesso principio delle "trap street" dei cartografi: una via che non esiste,
 * messa lì perché chi ricopia la mappa la ricopia insieme al resto.
 *
 * NON è un sabotaggio. Nessun marcatore altera il comportamento del programma,
 * nessuno peggiora l'esperienza di chi usa una copia: sono valori che il codice
 * userebbe comunque, scelti una volta e annotati.
 *
 * Tre famiglie di marcatori, con peso diverso:
 *
 *   · PORTANTI (peso 3) — stringhe scritte nei DATI degli utenti: il prefisso
 *     dei segreti nel vault, il nome del formato di export, il campo `tool` dei
 *     manifest di backup, il prefisso delle API key, le chiavi di localStorage.
 *     Chi le cambia rompe i file, le sessioni e i backup già esistenti dei
 *     propri utenti: è il marcatore che un fork "commerciale" ha più interesse
 *     a conservare, ed è quindi il più difficile da perdere per caso.
 *   · STRUTTURALI (peso 2) — sequenze e forme: l'ordine esatto della tavolozza
 *     validata per il daltonismo, la palette divergente, il raggio terrestre
 *     scelto, i parametri di scrypt. Sopravvivono alla traduzione dei commenti
 *     e alla rinomina degli identificatori.
 *   · ARBITRARIE (peso 1) — numeri calibrati a mano su comportamenti reali
 *     (soglie di disegno, timeout, tetti). Presi uno a uno non dicono nulla;
 *     presi tutti insieme, la probabilità che coincidano per caso è remota.
 *
 * Uso:
 *   node tools/impronte.js                  verifica che i marcatori siano ancora
 *                                           nel repository (esce 1 se ne mancano:
 *                                           serve a non perderli in un refactor)
 *   node tools/impronte.js <cartella>       cerca i marcatori in un albero SOSPETTO
 *   node tools/impronte.js --impegno        stampa l'impronta SHA-256 del registro,
 *                                           da committare in docs/provenienza.md
 *   node tools/impronte.js --json [dir]     stessa analisi in JSON
 *
 * Il registro dei marcatori (`provenienza/impronte.json`) è **fuori da git**:
 * committarlo in chiaro significherebbe consegnare a chi copia l'elenco preciso
 * di cosa cancellare. In `docs/provenienza.md` sta invece la sua impronta
 * SHA-256, che la cronologia di git data: basta a dimostrare che il registro
 * esisteva — con quel contenuto — prima della copia. Tenere una copia del
 * registro FUORI dal repository (gestore di password, archivio privato).
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RADICE = path.resolve(__dirname, '..');
const REGISTRO = process.env.CODEDB_IMPRONTE || path.join(RADICE, 'provenienza', 'impronte.json');

// Cartelle che non contengono codice di questo progetto: cercarci dentro
// produrrebbe solo falsi positivi (una dipendenza copiata non dimostra nulla).
const SALTA = new Set(['node_modules', '.git', 'dist', 'build', 'backups', 'coverage', 'vendor', '.next', '__pycache__']);
const ESTENSIONI = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.html', '.htm', '.css',
  '.md', '.txt', '.ini', '.yml', '.yaml', '.vue', '.svelte', '.py', '.go', '.java', '.cs', '.php', '.rb',
  // Script e configurazioni: un marcatore collocato in `codedb.sh`, in
  // `CodeDB.cmd` o in `tools/*.ps1` non veniva trovato NE' nell'auto-verifica
  // ne' su un albero sospetto, cioe' era un marcatore che non esisteva.
  '.sh', '.cmd', '.bat', '.ps1', '.psm1', '.sql', '.env', '.conf', '.toml', '.xml', '.svg',
]);

// File SENZA estensione con nome noto: stessa ragione di sopra.
const NOMI_SENZA_ESTENSIONE = new Set([
  'Dockerfile', 'Makefile', 'Procfile', 'LICENSE', 'NOTICE', '.gitattributes', '.dockerignore',
]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const PESI = { portante: 3, strutturale: 2, arbitraria: 1 };

function leggiRegistro() {
  if (!fs.existsSync(REGISTRO)) {
    console.error(`Registro dei marcatori non trovato: ${REGISTRO}`);
    console.error('È volutamente fuori da git (vedi docs/provenienza.md): recuperalo dalla tua copia privata,');
    console.error('oppure indicane il percorso con la variabile d\'ambiente CODEDB_IMPRONTE.');
    process.exit(2);
  }
  const reg = JSON.parse(fs.readFileSync(REGISTRO, 'utf8'));
  if (!Array.isArray(reg.marcatori) || !reg.marcatori.length) {
    console.error('Registro malformato: manca l\'array "marcatori".');
    process.exit(2);
  }
  return reg;
}

/**
 * Impronta del registro. Si normalizza (chiavi ordinate, campi descrittivi
 * esclusi) perché l'impegno deve valere sui MARCATORI, non sulla formattazione
 * del file né sulle note, che possono essere riscritte senza cambiare nulla.
 */
function canonicoDi(m) {
  return [m.id, m.categoria, m.regola].join('\u0000');
}

/** Impronta di UN marcatore: e' la sua prova temporale individuale. */
function impegnoMarcatore(m) {
  return crypto.createHash('sha256').update(canonicoDi(m), 'utf8').digest('hex');
}

function impegno(reg) {
  const canonico = reg.marcatori.map(canonicoDi).sort().join('\u0001');
  return crypto.createHash('sha256').update(canonico, 'utf8').digest('hex');
}

/**
 * Impegni PER MARCATORE, in forma pubblicabile.
 *
 * L'impegno complessivo ha valore solo se e' DATABILE, e un solo hash
 * sull'intero registro smette di esserlo al primo cambiamento: aggiungere un
 * marcatore per una funzionalita' nuova, o correggere il regex di uno gia'
 * presente, cambia l'hash, e la data gia' pubblicata non corrisponde piu' al
 * registro corrente. Da quel momento, per provare che un marcatore esisteva
 * gia' a una certa data servirebbe conservare a parte la vecchia copia del
 * registro: cosa che lo strumento non chiedeva e la documentazione non
 * spiegava. Ed e' la parte del meccanismo che ha valore solo se e' databile.
 *
 * Con un hash per marcatore ognuno porta la PROPRIA prova: pubblicando questo
 * elenco, aggiungerne uno nuovo non tocca la datazione dei precedenti — le
 * righe gia' pubblicate restano identiche, e la loro data resta valida. Il
 * campo `dal` (facoltativo, scritto quando il marcatore entra nel registro)
 * dichiara da quando esiste.
 */
function impegniPerMarcatore(reg) {
  return reg.marcatori
    .map((m) => ({ id: m.id, dal: m.dal || null, sha256: impegnoMarcatore(m) }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function* fileDi(dir) {
  let voci;
  try {
    voci = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // permessi, link rotti: si prosegue
  }
  for (const v of voci) {
    if (v.name.startsWith('.') && v.name !== '.github') continue;
    const p = path.join(dir, v.name);
    if (v.isDirectory()) {
      if (SALTA.has(v.name)) continue;
      yield* fileDi(p);
    } else if (v.isFile() && (ESTENSIONI.has(path.extname(v.name).toLowerCase()) || NOMI_SENZA_ESTENSIONE.has(v.name))) {
      yield p;
    }
  }
}

// Un marcatore trovato SOLO nella documentazione non vale come marcatore: i
// file .md sono la prima cosa che chi copia riscrive, e in questo repository
// CLAUDE.md/AGENT.md citano per esteso costanti e formati — senza questa
// distinzione l'auto-verifica direbbe "tutto a posto" anche dopo che un
// refactor ha cancellato l'impronta dal codice, lasciandola solo nel testo che
// la descrive.
const ESTENSIONI_DOC = new Set(['.md', '.txt']);
const isDoc = (f) => ESTENSIONI_DOC.has(path.extname(f).toLowerCase());

/**
 * Cerca ogni marcatore in TUTTI i file: in una copia i percorsi cambiano, e
 * cercare nel file "giusto" significherebbe non trovare nulla appena qualcuno
 * riorganizza le cartelle. Si raccolgono tutte le occorrenze (non solo la
 * prima) perché sapere DOVE sopravvive un marcatore dice se la copia è
 * dell'intero progetto o di un singolo modulo.
 */
function analizza(dir, marcatori) {
  const regole = marcatori.map((m) => ({ m, re: new RegExp(m.regola, 'm'), occorrenze: [], docOnly: false }));
  // Il registro stesso contiene i marcatori in chiaro: se sta dentro l'albero
  // esaminato (o se qualcuno lo copia per sbaglio) troverebbe sé stesso e ogni
  // analisi darebbe 100%.
  const registro = path.resolve(REGISTRO);
  let esaminati = 0;
  for (const f of fileDi(dir)) {
    if (path.resolve(f) === registro || path.basename(f) === 'impronte.json') continue;
    let testo;
    try {
      const st = fs.statSync(f);
      if (st.size > MAX_FILE_BYTES) continue;
      testo = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    esaminati++;
    for (const r of regole) {
      if (r.occorrenze.length >= 5) continue;
      if (r.re.test(testo)) r.occorrenze.push({ file: path.relative(dir, f).replace(/\\/g, '/'), doc: isDoc(f) });
    }
  }
  for (const r of regole) {
    r.docOnly = r.occorrenze.length > 0 && r.occorrenze.every((o) => o.doc);
    // `trovato` = presenza nel CODICE. Una citazione nella documentazione è
    // segnalata a parte, non conteggiata.
    const nelCodice = r.occorrenze.filter((o) => !o.doc);
    r.trovato = nelCodice.length ? nelCodice[0].file : null;
  }
  return { esaminati, regole };
}

function punteggio(regole) {
  let tot = 0;
  let ottenuto = 0;
  const perCategoria = {};
  for (const r of regole) {
    const peso = PESI[r.m.categoria] ?? 1;
    tot += peso;
    perCategoria[r.m.categoria] = perCategoria[r.m.categoria] || { trovati: 0, totali: 0 };
    perCategoria[r.m.categoria].totali++;
    if (r.trovato) {
      ottenuto += peso;
      perCategoria[r.m.categoria].trovati++;
    }
  }
  return { tot, ottenuto, percento: tot ? Math.round((ottenuto / tot) * 100) : 0, perCategoria };
}

/**
 * Lettura del risultato. Volutamente prudente: nessun singolo marcatore
 * dimostra alcunché, e uno strumento che gridasse "copia!" sarebbe inutile
 * proprio nel momento in cui serve, cioè davanti a un legale.
 */
function verdetto(p, regole) {
  const portantiTrovati = regole.filter((r) => r.m.categoria === 'portante' && r.trovato).length;
  if (p.percento >= 60 || portantiTrovati >= 3) {
    return ['DERIVAZIONE MOLTO PROBABILE',
      'Coincidono scelte arbitrarie che non hanno alcuna ragione tecnica di essere identiche in due progetti indipendenti,'
      + ' incluse stringhe che finiscono nei dati degli utenti. Conserva questo rapporto insieme al commit datato'
      + ' dell\'impronta del registro.'];
  }
  if (p.percento >= 25) {
    return ['INDIZI SIGNIFICATIVI',
      'Diversi marcatori coincidono. Può essere una copia parziale (uno o due moduli) oppure un fork ripulito a metà:'
      + ' guarda QUALI marcatori sono sopravvissuti, non solo quanti.'];
  }
  if (p.ottenuto > 0) {
    return ['INDIZI DEBOLI',
      'Poche coincidenze: da sole non dicono granché, potrebbero venire da convenzioni comuni. Valuta i singoli marcatori.'];
  }
  return ['NESSUNA CORRISPONDENZA',
    'Nessun marcatore trovato: non c\'è alcun elemento a sostegno di una derivazione da questo codice.'];
}

function stampaRapporto(dir, reg, ris, p, autoVerifica) {
  const larghezza = Math.max(...ris.regole.map((r) => r.m.id.length), 12);
  console.log(`\nImpronte di provenienza — ${autoVerifica ? 'auto-verifica del repository' : 'analisi di un albero esterno'}`);
  console.log(`Cartella:  ${dir}`);
  console.log(`Registro:  ${REGISTRO} (impronta ${impegno(reg).slice(0, 16)}…)`);
  console.log(`File esaminati: ${ris.esaminati}\n`);

  for (const cat of ['portante', 'strutturale', 'arbitraria']) {
    const gruppo = ris.regole.filter((r) => r.m.categoria === cat);
    if (!gruppo.length) continue;
    console.log(`  ${cat.toUpperCase()} (peso ${PESI[cat]})`);
    for (const r of gruppo) {
      const segno = r.trovato ? '✓' : (r.docOnly ? '~' : '·');
      const altri = r.occorrenze.filter((o) => !o.doc).length - 1;
      const dove = r.trovato
        ? r.trovato + (altri > 0 ? ` (+${altri})` : '')
        : (r.docOnly ? `SOLO NELLA DOCUMENTAZIONE (${r.occorrenze[0].file})` : (autoVerifica ? 'MANCANTE' : '—'));
      console.log(`   ${segno} ${r.m.id.padEnd(larghezza)}  ${dove}`);
    }
    console.log('');
  }

  console.log(`Punteggio: ${p.ottenuto}/${p.tot} (${p.percento}%)`);
  if (!autoVerifica) {
    const [titolo, spiegazione] = verdetto(p, ris.regole);
    console.log(`Lettura:   ${titolo}`);
    console.log(`           ${spiegazione}`);
    console.log('\nNota: questo rapporto è un indizio tecnico, non una perizia. Ciò che lo rende utile è la DATA:');
    console.log('l\'impronta del registro è committata in docs/provenienza.md, quindi la scelta dei marcatori');
    console.log('è dimostrabilmente anteriore alla copia.');
  }
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const soloImpegno = argv.includes('--impegno');
  const dirArg = argv.find((a) => !a.startsWith('--'));

  const reg = leggiRegistro();

  if (soloImpegno) {
    const h = impegno(reg);
    const perMarcatore = impegniPerMarcatore(reg);
    if (json) {
      console.log(JSON.stringify({
        impegno: h, marcatori: reg.marcatori.length, creato: reg.creato, per_marcatore: perMarcatore,
      }, null, 2));
    } else {
      console.log(`Impronta SHA-256 del registro: ${h}`);
      console.log(`Marcatori: ${reg.marcatori.length} · registro creato il ${reg.creato}`);
      console.log('\nImpronte PER MARCATORE (una riga ciascuna, da pubblicare in docs/provenienza.md):');
      for (const m of perMarcatore) {
        console.log(`  ${m.sha256}  ${m.id}${m.dal ? `  (dal ${m.dal})` : ''}`);
      }
      console.log(
        '\nPubblica QUESTE righe, non solo l\'impronta complessiva.\n'
        + 'L\'impegno vale se è databile, e un hash unico su tutto il registro smette di esserlo\n'
        + 'al primo cambiamento: aggiungere un marcatore o correggerne il regex cambia l\'hash, e la\n'
        + 'data già pubblicata non corrisponde più. Le righe per marcatore, invece, restano identiche:\n'
        + 'aggiungerne uno nuovo non tocca la datazione dei precedenti. La data del commit è la prova.'
      );
    }
    return;
  }

  const autoVerifica = !dirArg;
  const dir = path.resolve(dirArg || RADICE);
  if (!fs.existsSync(dir)) {
    console.error(`Cartella inesistente: ${dir}`);
    process.exit(2);
  }

  const ris = analizza(dir, reg.marcatori);
  const p = punteggio(ris.regole);

  if (json) {
    console.log(JSON.stringify({
      cartella: dir,
      impegno: impegno(reg),
      impegni_per_marcatore: impegniPerMarcatore(reg),
      esaminati: ris.esaminati,
      punteggio: p,
      marcatori: ris.regole.map((r) => ({
        id: r.m.id, categoria: r.m.categoria, trovato: r.trovato, soloDocumentazione: r.docOnly,
        occorrenze: r.occorrenze.map((o) => o.file),
      })),
      verdetto: autoVerifica ? null : verdetto(p, ris.regole)[0],
    }, null, 2));
  } else {
    stampaRapporto(dir, reg, ris, p, autoVerifica);
  }

  // In auto-verifica un marcatore mancante è un problema DA CORREGGERE: vuol
  // dire che un refactor ha cancellato un'impronta senza che nessuno se ne
  // accorgesse, e da quel momento il registro promette qualcosa che il codice
  // non ha più.
  if (autoVerifica && p.ottenuto < p.tot) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { impegno, impegnoMarcatore, impegniPerMarcatore, analizza, punteggio, leggiRegistro, PESI };

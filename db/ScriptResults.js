'use strict';

/* ---------------------------------------------------------------------------
 * Deposito dei result set di uno SCRIPT
 *
 * PERCHÉ ESISTE. Uno script produce un risultato per istruzione, e l'utente
 * vuole poterli rivedere tutti — non solo l'ultimo. Tenerli in memoria non è
 * una scelta: un file .sql con cinquecento SELECT terrebbe in RAM cinquecento
 * result set per ogni run e per ogni tab, e spedirli tutti al browser alla fine
 * dello script significherebbe mandare in un solo pacchetto quello che la
 * griglia mostrerà comunque una scheda alla volta.
 *
 * Quindi ogni result set finisce SU FILE appena prodotto, e in memoria resta
 * solo un indice leggero (riga, istruzione, righe, colonne, nome del file). Il
 * browser chiede il contenuto di una scheda quando l'utente la apre.
 *
 * IDENTIFICATIVO: primi 10 caratteri del base64 del testo della query, poi il
 * timestamp. Lega il deposito alla query che l'ha prodotto ed è ordinabile nel
 * tempo. La collisione (stesso testo, stesso millisecondo, due tab) non viene
 * ignorata: la cartella si crea in modo ESCLUSIVO e, se esiste già, si aggiunge
 * un discriminante — un deposito che scrivesse dentro quello di un altro run
 * gli sovrascriverebbe i risultati.
 *
 * VITA BREVE. Sono file di lavoro, non dati dell'utente: stanno nella cartella
 * temporanea, nascono con permessi 0600 (contengono righe di database) e
 * vengono cancellati alla fine del run, alla chiusura del socket e — per ciò
 * che un arresto anomalo può aver lasciato indietro — da una passata all'avvio.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

function intFromEnv(nome, predefinito) {
  const v = parseInt(process.env[nome], 10);
  return Number.isFinite(v) && v > 0 ? v : predefinito;
}

// Radice dei depositi. Sovrascrivibile per i test e per chi voglia spostarli
// (un disco cifrato, per esempio).
const RADICE = process.env.CODEDB_SCRIPT_RESULTS_DIR
  || path.join(os.tmpdir(), 'codedb-risultati-script');

// Quanti result set conservare per run. Si tengono i PRIMI: le schede non
// devono sparire da sotto gli occhi di chi le sta guardando mentre lo script
// continua a produrne. Quelli oltre il tetto vengono contati, non taciuti.
const MAX_RISULTATI = intFromEnv('CODEDB_SCRIPT_RESULTS_MAX', 50);

// Budget di byte per run: il tetto sul NUMERO non basta, cinquanta SELECT da
// trenta megabyte riempirebbero il disco della macchina.
const MAX_BYTES = intFromEnv('CODEDB_SCRIPT_RESULTS_MAX_BYTES', 256 * 1024 * 1024);

// Età oltre la quale un deposito rimasto in giro (arresto anomalo) è spazzatura.
const ETA_MAX_MS = intFromEnv('CODEDB_SCRIPT_RESULTS_TTL_MS', 24 * 60 * 60 * 1000);

/**
 * Identificativo del deposito. Base64**url**, non base64 puro: "+" e "/" in un
 * nome di cartella sono un invito a sbagliare (il secondo è un separatore di
 * percorso, e da solo basta a scrivere fuori dalla radice).
 */
function idDeposito(code, adesso = Date.now()) {
  // base64**url** e non base64: il suo alfabeto è già [A-Za-z0-9_-], quindi il
  // nome è utilizzabile come cartella senza ripulirlo. Con il base64 normale
  // arriverebbero "+", "=" e soprattutto "/", che è un separatore di percorso —
  // cioè un modo per scrivere fuori dalla radice.
  const b64 = Buffer.from(String(code == null ? '' : code), 'utf8').toString('base64url');
  const testa = b64.slice(0, 10) || 'script';
  return testa + '-' + adesso;
}

// Il nome è nostro, ma finisce in un percorso: si controlla comunque.
const RE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Apre un deposito per un run. */
function creaDeposito(code, opzioni) {
  const o = opzioni || {};
  const radice = o.radice || RADICE;
  const maxRisultati = o.maxRisultati || MAX_RISULTATI;
  const maxBytes = o.maxBytes || MAX_BYTES;

  fs.mkdirSync(radice, { recursive: true });

  let id = idDeposito(code);
  let dir = path.join(radice, id);
  for (let tentativo = 1; ; tentativo += 1) {
    try {
      fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' || tentativo > 50) throw err;
      id = idDeposito(code) + '-' + tentativo;
      dir = path.join(radice, id);
    }
  }

  const voci = [];
  let bytes = 0;
  let scartati = 0;
  let chiuso = false;

  return {
    id,
    dir,

    /**
     * Registra il result set di un'istruzione. Ritorna la voce dell'indice, o
     * `null` se non è stato conservato (tetto raggiunto): il chiamante deve
     * poterlo dire all'utente, non far sparire una scheda in silenzio.
     */
    async aggiungi(voceIn) {
      if (chiuso) return null;
      const { index, line, sql, res } = voceIn || {};
      const docs = (res && Array.isArray(res.docs)) ? res.docs : [];
      const columns = (res && res.columns) || null;
      if (voci.length >= maxRisultati) { scartati += 1; return null; }

      const testo = JSON.stringify({ index, line, sql, columns, docs });
      const dimensione = Buffer.byteLength(testo, 'utf8');
      if (bytes + dimensione > maxBytes) { scartati += 1; return null; }

      const file = voci.length + '.json';
      await fsp.writeFile(path.join(dir, file), testo, { encoding: 'utf8', mode: 0o600 });
      bytes += dimensione;

      const voce = {
        pos: voci.length,     // posizione fra le SCHEDE (non fra le istruzioni)
        index,                // istruzione dello script a cui appartiene
        line,
        sql,
        rows: docs.length,
        columns,
        bytes: dimensione,
      };
      voci.push(Object.assign({ file }, voce));
      return voce;
    },

    /** Indice leggero per il client: nessun documento, solo di cosa si tratta. */
    elenco() {
      return {
        id,
        schede: voci.map((v) => ({
          pos: v.pos, index: v.index, line: v.line, sql: v.sql, rows: v.rows, columns: v.columns,
        })),
        scartati,
      };
    },

    /** Contenuto di una scheda, letto dal file solo quando serve davvero. */
    async leggi(pos) {
      // `pos` arriva dal client. `Number()` da solo non basta a filtrarlo:
      // `Number(null)`, `Number('')` e `Number(false)` valgono 0, cioè una
      // richiesta malformata leggerebbe in silenzio la PRIMA scheda invece di
      // essere respinta — e chi la riceve la crederebbe quella che ha chiesto.
      const n = typeof pos === 'number' ? pos
        : (/^\d+$/.test(String(pos == null ? '' : pos).trim()) ? Number(pos) : NaN);
      if (!Number.isInteger(n) || n < 0 || n >= voci.length) {
        throw new Error('Scheda di risultato inesistente: lo script potrebbe essere stato chiuso.');
      }
      const testo = await fsp.readFile(path.join(dir, voci[n].file), 'utf8');
      return JSON.parse(testo);
    },

    /** Quante schede sono state conservate. */
    get schede() { return voci.length; },

    /** Cancella tutto: fine del run, chiusura del socket, chiusura del tab. */
    async elimina() {
      chiuso = true;
      voci.length = 0;
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Passata di pulizia dei depositi rimasti indietro. Un arresto anomalo non
 * esegue nessun elimina(), e questi file contengono righe di database:
 * lasciarli accumulare nella cartella temporanea finché qualcuno non se ne
 * accorge non è un dettaglio di igiene.
 */
async function puliziaVecchi(opzioni) {
  const o = opzioni || {};
  const radice = o.radice || RADICE;
  const etaMassimaMs = o.etaMassimaMs || ETA_MAX_MS;
  let nomi;
  try {
    nomi = await fsp.readdir(radice);
  } catch (_) {
    return 0; // radice inesistente: niente da pulire
  }
  const limite = Date.now() - etaMassimaMs;
  let rimossi = 0;
  for (const nome of nomi) {
    if (!RE_ID.test(nome)) continue;
    const completo = path.join(radice, nome);
    try {
      const st = await fsp.stat(completo);
      if (st.mtimeMs > limite) continue;
      await fsp.rm(completo, { recursive: true, force: true });
      rimossi += 1;
    } catch (_) { /* concorrenza con un altro processo: non è un errore */ }
  }
  return rimossi;
}

module.exports = { idDeposito, creaDeposito, puliziaVecchi, RADICE, MAX_RISULTATI, MAX_BYTES };

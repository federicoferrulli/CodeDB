'use strict';

/**
 * Le decisioni del trasferimento di un artefatto, senza rete e senza disco.
 *
 * Un download riprendibile e un upload a blocchi sono fatti quasi solo di
 * decisioni: quale intervallo di byte serve davvero, se il file è ancora
 * quello che il client aveva cominciato a scaricare, se un blocco appena
 * arrivato è la ripetizione di uno già scritto o è un conflitto. Sbagliarne una
 * non produce un errore: produce un file **diverso** da quello che si voleva,
 * e nessun messaggio.
 *
 * Qui non si apre niente e non si risponde a nessuno: entrano header e stato,
 * esce la decisione. È la ragione per cui si provano con `assert` invece che
 * con un server vero, e per cui i casi limite — l'ultimo byte, l'intervallo
 * vuoto, il suffisso più lungo del file — sono verificabili uno per uno.
 */

const crypto = require('crypto');

/* --- Download: intervalli ------------------------------------------------- */

/**
 * Interpreta `Range` secondo RFC 9110 §14.1.
 *
 * @param {string|null} header valore grezzo dell'header
 * @param {number} dimensione byte totali della risorsa
 * @returns {{tipo:'intero'}|{tipo:'parziale',inizio:number,fine:number}|{tipo:'non-soddisfacibile'}}
 *
 * Tre esiti, e il terzo non è un errore generico: un `Range` che comincia oltre
 * la fine del file è **416**, e la risposta deve dire quanto è lungo il file —
 * altrimenti il client non ha modo di correggere la richiesta.
 *
 * Un header malformato non è un rifiuto: la specifica dice di IGNORARLO e
 * servire l'intera risorsa. Rispondere 416 a un header che non si è capito
 * romperebbe client corretti per colpa di un proxy che ha riscritto l'header.
 */
function interpretaRange(header, dimensione) {
  const grezzo = String(header || '').trim();
  if (!grezzo) return { tipo: 'intero' };
  const match = /^bytes=(.*)$/i.exec(grezzo);
  if (!match) return { tipo: 'intero' };
  const parti = match[1].split(',').map((s) => s.trim()).filter(Boolean);
  // Più intervalli richiederebbero una risposta `multipart/byteranges`. Nessun
  // client di download la usa per riprendere un file, e implementarla per
  // completezza vorrebbe dire un generatore MIME da mantenere: si serve
  // l'intera risorsa, che è una risposta sempre valida.
  if (parti.length !== 1) return { tipo: 'intero' };

  const intervallo = /^(\d*)-(\d*)$/.exec(parti[0]);
  if (!intervallo) return { tipo: 'intero' };
  const [, daRaw, aRaw] = intervallo;
  if (daRaw === '' && aRaw === '') return { tipo: 'intero' };

  if (daRaw === '') {
    // Suffisso: `bytes=-500` sono gli ULTIMI 500 byte. Un suffisso di zero byte
    // non è soddisfacibile; uno più lungo del file vale tutto il file.
    const quanti = Number(aRaw);
    if (!Number.isFinite(quanti) || quanti <= 0) return { tipo: 'non-soddisfacibile' };
    if (dimensione === 0) return { tipo: 'non-soddisfacibile' };
    return { tipo: 'parziale', inizio: Math.max(0, dimensione - quanti), fine: dimensione - 1 };
  }

  const inizio = Number(daRaw);
  if (!Number.isFinite(inizio)) return { tipo: 'intero' };
  // Un file vuoto non ha alcun byte da servire: qualunque intervallo è fuori.
  if (dimensione === 0 || inizio >= dimensione) return { tipo: 'non-soddisfacibile' };
  const fine = aRaw === '' ? dimensione - 1 : Math.min(Number(aRaw), dimensione - 1);
  if (!Number.isFinite(fine) || fine < inizio) return { tipo: 'non-soddisfacibile' };
  return { tipo: 'parziale', inizio, fine };
}

/**
 * L'ETag di un artefatto finalizzato.
 *
 * Quando c'è l'impronta SHA-256 del contenuto — e per un artefatto finalizzato
 * c'è sempre, la calcola il motore mentre scrive — l'ETag È quella: due file
 * con lo stesso contenuto hanno lo stesso validatore, e uno modificato ne ha
 * uno diverso anche se dimensione e data coincidono. Il ripiego su
 * dimensione+mtime esiste per i file che un'impronta non ce l'hanno, ed è più
 * debole: due scritture nello stesso millisecondo non si distinguono.
 */
function etagDi({ digest = null, dimensione = 0, mtimeMs = 0 } = {}) {
  if (digest) return `"sha256:${digest}"`;
  return `"${dimensione.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

/**
 * Decide la risposta a una richiesta di download.
 *
 * `If-Range` è il punto delicato: un client che riprende un download a metà
 * manda l'ETag che aveva all'inizio. Se il file nel frattempo è cambiato,
 * servire l'intervallo richiesto **cucirebbe insieme due file diversi** — un
 * artefatto corrotto che supera ogni controllo di dimensione. La risposta
 * corretta è ignorare il Range e mandare tutto: il client se ne accorge perché
 * riceve 200 invece di 206.
 */
function decidiDownload({ headers = {}, dimensione = 0, etag }) {
  const ifRange = String(headers['if-range'] || '').trim();
  const range = headers.range;
  if (ifRange && ifRange !== etag) {
    return { stato: 200, inizio: 0, fine: Math.max(0, dimensione - 1), lunghezza: dimensione, motivo: 'if-range-non-corrisponde' };
  }
  const voluto = interpretaRange(range, dimensione);
  if (voluto.tipo === 'non-soddisfacibile') {
    return { stato: 416, contentRange: `bytes */${dimensione}`, lunghezza: 0 };
  }
  if (voluto.tipo === 'intero') {
    return { stato: 200, inizio: 0, fine: Math.max(0, dimensione - 1), lunghezza: dimensione };
  }
  return {
    stato: 206,
    inizio: voluto.inizio,
    fine: voluto.fine,
    lunghezza: voluto.fine - voluto.inizio + 1,
    contentRange: `bytes ${voluto.inizio}-${voluto.fine}/${dimensione}`,
  };
}

/* --- Upload: blocchi ------------------------------------------------------ */

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Che fare di un blocco appena arrivato.
 *
 * Una ripresa dopo un'interruzione rimanda blocchi che POTREBBERO essere già
 * stati scritti: il client non sa dove si è fermata la scrittura, sa solo dove
 * si è fermata la sua richiesta. Rifiutare tutto ciò che non è esattamente il
 * blocco successivo rende impossibile riprendere; accettare tutto ciò che
 * arriva sovrascrive byte buoni con byte di una sessione diversa.
 *
 * La regola sta in mezzo, e poggia sull'impronta del blocco:
 *
 *  · l'offset atteso → si scrive;
 *  · un offset già superato, con la STESSA impronta → è la ripetizione di un
 *    blocco già scritto: si conferma senza riscrivere (idempotente);
 *  · un offset già superato con un'impronta DIVERSA → sono due contenuti che
 *    pretendono lo stesso posto: si rifiuta, perché scegliere significherebbe
 *    indovinare quale dei due è il file vero;
 *  · un offset oltre quello atteso → lascerebbe un buco di byte mai scritti,
 *    che nessun controllo successivo potrebbe distinguere da zeri legittimi.
 */
function decidiBlocco({ offset, contenuto, scritti, improntePerOffset = new Map(), massimo = Infinity }) {
  const inizio = Number(offset);
  if (!Number.isInteger(inizio) || inizio < 0) {
    return { azione: 'rifiuta', motivo: 'Offset del blocco non valido.' };
  }
  if (!Buffer.isBuffer(contenuto) || !contenuto.length) {
    return { azione: 'rifiuta', motivo: 'Blocco vuoto o non binario.' };
  }
  const impronta = sha256(contenuto);
  if (inizio < scritti) {
    const nota = improntePerOffset.get(inizio);
    if (nota && nota.impronta === impronta && nota.lunghezza === contenuto.length) {
      return { azione: 'gia-scritto', impronta, scritti };
    }
    return {
      azione: 'rifiuta',
      motivo: `Conflitto sul blocco all'offset ${inizio}: è già stato caricato un contenuto diverso.`,
    };
  }
  if (inizio > scritti) {
    return {
      azione: 'rifiuta',
      motivo: `Blocco fuori sequenza: atteso l'offset ${scritti}, ricevuto ${inizio}.`,
    };
  }
  if (scritti + contenuto.length > massimo) {
    return { azione: 'rifiuta', motivo: `Artefatto troppo grande: massimo ${massimo} byte.` };
  }
  return { azione: 'scrivi', impronta, scritti: scritti + contenuto.length };
}

/* --- Ticket di accesso ---------------------------------------------------- */

/**
 * Un permesso breve, legato a UNA risorsa e a UN attore.
 *
 * Serve perché un download nel browser non passa da `fetch`: è il browser a
 * fare la richiesta, e non c'è modo di mettergli un header `Authorization`.
 * L'alternativa — il token di sessione nell'URL — è quella che il piano vieta
 * (§7): finirebbe nei log del server, nei log del proxy, nel `Referer` e nella
 * cronologia, e con esso si può fare TUTTO, non solo scaricare quel file.
 *
 * Il ticket invece nomina la risorsa, scade, e non autorizza altro. È firmato,
 * non cifrato: non contiene segreti, contiene un'affermazione che solo il
 * server può aver prodotto.
 */
function creaTicket({ segreto, risorsa, attore, ownerId, scadenzaMs = 5 * 60 * 1000, adesso = Date.now() }) {
  if (!segreto) throw new Error('Segreto dei ticket di trasferimento mancante.');
  const corpo = {
    r: String(risorsa), a: String(attore || ''), o: String(ownerId || ''),
    e: adesso + scadenzaMs,
  };
  const testo = Buffer.from(JSON.stringify(corpo), 'utf8').toString('base64url');
  const firma = crypto.createHmac('sha256', segreto).update(testo).digest('base64url');
  return `${testo}.${firma}`;
}

/**
 * @returns {{ok:true, risorsa:string, attore:string, ownerId:string}|{ok:false, motivo:string}}
 */
function verificaTicket({ segreto, ticket, adesso = Date.now() }) {
  const grezzo = String(ticket || '');
  const punto = grezzo.lastIndexOf('.');
  if (punto <= 0) return { ok: false, motivo: 'Ticket malformato.' };
  const testo = grezzo.slice(0, punto);
  const firma = grezzo.slice(punto + 1);
  const atteso = crypto.createHmac('sha256', segreto).update(testo).digest('base64url');
  // Confronto a tempo costante: un confronto normale perde byte per byte
  // quanto della firma è corretto, ed è tutto ciò che serve per costruirla.
  const a = Buffer.from(firma);
  const b = Buffer.from(atteso);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, motivo: 'Ticket non valido.' };
  }
  let corpo;
  try { corpo = JSON.parse(Buffer.from(testo, 'base64url').toString('utf8')); }
  catch { return { ok: false, motivo: 'Ticket illeggibile.' }; }
  if (!corpo || typeof corpo !== 'object') return { ok: false, motivo: 'Ticket illeggibile.' };
  if (!(Number(corpo.e) > adesso)) return { ok: false, motivo: 'Ticket scaduto.' };
  return { ok: true, risorsa: String(corpo.r), attore: String(corpo.a), ownerId: String(corpo.o) };
}

module.exports = {
  interpretaRange,
  etagDi,
  decidiDownload,
  decidiBlocco,
  creaTicket,
  verificaTicket,
  sha256,
};

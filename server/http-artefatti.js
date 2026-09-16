'use strict';

/**
 * Il data-plane HTTP degli artefatti: i file viaggiano qui, i comandi restano su Socket.IO.
 *
 * §7 del piano: Socket.IO conserva comandi, permessi e avanzamento; i file
 * passano su endpoint HTTP autenticati dedicati. Il browser non può impostare
 * header su un download avviato per navigazione, quindi il download si
 * autorizza con un ticket breve legato a risorsa e attore
 * (`db/trasferimenti.js`: firmato, non cifrato, qualche minuto di vita);
 * l'upload passa da `fetch` e usa `Authorization: Bearer`.
 *
 * Il ticket NON è un token di sessione: nomina una risorsa sola
 * (`caricamenti`, `caricamento:<id>`, `artefatto:<id>`) dentro il tenant di chi
 * lo ha chiesto, e con esso non si può fare altro. La cilindrata sta tutta in
 * `db/trasferimenti.js` (Range, ETag, blocchi) e `db/uploadDisco.js` (byte su
 * disco): qui restano solo HTTP e permessi di accesso.
 */

const express = require('express');
const fs = require('fs');
const {
  decidiDownload, etagDi, verificaTicket, creaTicket, sha256,
} = require('../db/trasferimenti');

// Id opachi mai scelti dal client per i percorsi: anche qui si valida la forma
// prima di usarli, perché un giorno qualcuno riusi queste funzioni altrove.
const ID_SICURO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function validaRisorsa(risorsa) {
  const s = String(risorsa == null ? '' : risorsa);
  if (s === 'caricamenti') return s;
  const m = /^(caricamento|artefatto):(.+)$/.exec(s);
  if (m && ID_SICURO.test(m[2]) && m[2] !== '.' && m[2] !== '..') return s;
  throw new Error(`Risorsa del ticket non valida: "${s}".`);
}

/**
 * Un ticket firmato non e' revocabile da se': porta solo una scadenza, quindi
 * fra la revoca di un accesso e la fine del ticket resta una finestra in cui si
 * scarica un artefatto che puo' contenere l'intero database. La revoca a caldo
 * di CodeDB chiude i socket del soggetto (`disconnettiSocketDi`,
 * `rivalidaPrincipal`): la presenza di un socket vivo dell'attore e' quindi il
 * segnale di revoca che esiste gia', e usarlo non richiede alcuno stato nuovo.
 *
 * Predicato iniettato perche' fuori dall'RBAC non c'e' alcuna revoca da
 * onorare — e perche' senza di esso questo modulo resta provabile senza server.
 */
function creaModuloArtefatti({
  archivio, segreto, scadenzaTicketMs = 5 * 60 * 1000, now = () => Date.now(),
  registraEvento = () => {}, attoreAncoraValido = () => true,
} = {}) {
  if (!archivio) throw new Error('Modulo artefatti senza archivio su disco.');
  if (!segreto) throw new Error('Segreto dei ticket di trasferimento mancante.');

  // Traccia di audit: solo ciclo di vita ed esiti, mai il ticket (è una
  // credenziale) né i byte. I blocchi andati a buon fine non si registrano —
  // un upload da GB ne avrebbe migliaia — ma ogni rifiuto sì.
  function traccia(tipo, { attore = null, ownerId = null, risorsa = null, esito = 'ok', dettaglio = null } = {}) {
    try {
      registraEvento({
        quando: new Date(now()).toISOString(), tipo, attore, ownerId, risorsa, esito, dettaglio,
      });
    } catch (_) { /* l'audit non ferma il trasferimento */ }
  }

  function emettiTicket({ risorsa, attore, ownerId } = {}) {
    return creaTicket({
      segreto, risorsa: validaRisorsa(risorsa), attore, ownerId, scadenzaMs: scadenzaTicketMs, adesso: now(),
    });
  }

  function ticketDa(req) {
    const header = String(req.get('authorization') || '');
    const m = /^Bearer (.+)$/.exec(header.trim());
    const ticket = m ? m[1].trim() : String((req.query && req.query.ticket) || '').trim();
    if (!ticket) return { ok: false, motivo: 'Ticket mancante.' };
    return verificaTicket({ segreto, ticket, adesso: now() });
  }

  function statoDaCodice(codice) {
    return { NON_TROVATO: 404, SCADUTO: 410, CONFLITTO: 409, SEQUENZA: 409, INCOMPLETO: 409, LIMITE: 413 }[codice] || 400;
  }

  function errore(res, stato, messaggio) {
    return res.status(stato).json({ ok: false, error: messaggio });
  }

  /** Autorizza e confina: risorsa attesa, tenant del ticket, nient'altro. */
  function autorizza(req, res, attesa) {
    const verifica = ticketDa(req);
    if (!verifica.ok) {
      traccia('accesso-negato', { risorsa: attesa, esito: 'negato', dettaglio: verifica.motivo });
      return { errore: errore(res, 403, verifica.motivo) };
    }
    if (!attoreAncoraValido(verifica.attore, verifica.ownerId)) {
      traccia('accesso-negato', {
        attore: verifica.attore, ownerId: verifica.ownerId, risorsa: attesa,
        esito: 'negato', dettaglio: 'Accesso dell’attore non piu valido.',
      });
      return { errore: errore(res, 403, 'Accesso revocato: questo ticket non vale più.') };
    }
    if (verifica.risorsa !== attesa) {
      traccia('accesso-negato', {
        attore: verifica.attore, ownerId: verifica.ownerId, risorsa: attesa,
        esito: 'negato', dettaglio: 'Ticket non valido per questa risorsa.',
      });
      return { errore: errore(res, 403, 'Ticket non valido per questa risorsa.') };
    }
    return verifica;
  }

  async function serviDownload(req, res, soloIntestazioni) {
    let id;
    try {
      id = validaRisorsa(`artefatto:${req.params.id}`).split(':')[1];
    } catch {
      return errore(res, 400, 'Identificatore di artefatto non valido.');
    }
    const auth = autorizza(req, res, `artefatto:${id}`);
    if (auth.errore) return auth.errore;
    let manifest;
    let file;
    try {
      ({ file, manifest } = req.archivio.percorsoDati(id, auth.ownerId));
    } catch (err) {
      traccia('scaricamento', {
        attore: auth.attore, ownerId: auth.ownerId, risorsa: `artefatto:${id}`,
        esito: 'fallito', dettaglio: err.message,
      });
      return errore(res, statoDaCodice(err.codice), err.message);
    }
    const etag = etagDi({ digest: manifest.digest });
    const decisione = decidiDownload({ headers: req.headers, dimensione: manifest.dimensione, etag });
    res.set('ETag', etag);
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${manifest.nome}"`);
    res.set('Cache-Control', 'no-store');
    if (decisione.stato === 416) {
      res.set('Content-Range', decisione.contentRange);
      traccia('scaricamento', {
        attore: auth.attore, ownerId: auth.ownerId, risorsa: `artefatto:${id}`,
        esito: 'intervallo-non-soddisfacibile',
      });
      return res.status(416).end();
    }
    res.set('Content-Length', String(decisione.lunghezza));
    if (decisione.stato === 206) {
      res.set('Content-Range', decisione.contentRange);
      res.status(206);
    } else {
      res.status(200);
    }
    if (soloIntestazioni) {
      traccia('scaricamento', {
        attore: auth.attore, ownerId: auth.ownerId, risorsa: `artefatto:${id}`,
        esito: 'intestazioni', dettaglio: `stato ${decisione.stato}`,
      });
      return res.end();
    }
    // Completato o interrotto si sa solo alla fine dello stream: la traccia
    // onesta aspetta l'evento, non la decisione.
    let tracciato = false;
    const chiudi = (esito) => {
      if (tracciato) return;
      tracciato = true;
      traccia('scaricamento', {
        attore: auth.attore, ownerId: auth.ownerId, risorsa: `artefatto:${id}`,
        esito, dettaglio: `stato ${decisione.stato}, ${decisione.lunghezza} byte`,
      });
    };
    res.on('finish', () => chiudi(decisione.stato === 206 ? 'ripresa-completata' : 'completato'));
    res.on('close', () => chiudi('interrotto'));
    const flusso = fs.createReadStream(file, { start: decisione.inizio, end: decisione.fine });
    flusso.on('error', () => {
      try { res.destroy(); } catch { /* connessione già chiusa */ }
    });
    flusso.pipe(res);
  }

  function monta(app, { verificaOrigine = () => ({ ok: true }), limiteBlocco = 4 * 1024 * 1024 } = {}) {
    const cancello = (req, res, next) => {
      req.archivio = archivio;
      const verdetto = verificaOrigine(req);
      if (!verdetto.ok) return errore(res, 403, verdetto.reason || verdetto.motivo || 'Origine non consentita.');
      return next();
    };

    app.post('/artefatti/caricamenti', cancello, express.json({ limit: '16kb' }), (req, res) => {
      const auth = autorizza(req, res, 'caricamenti');
      if (auth.errore) return auth.errore;
      let aperto;
      try {
        aperto = archivio.avvia(auth.ownerId, auth.attore);
      } catch (err) {
        traccia('caricamento-avviato', {
          attore: auth.attore, ownerId: auth.ownerId, risorsa: 'caricamenti',
          esito: 'fallito', dettaglio: err.message,
        });
        return errore(res, statoDaCodice(err.codice), err.message);
      }
      traccia('caricamento-avviato', {
        attore: auth.attore, ownerId: auth.ownerId, risorsa: `caricamento:${aperto.uploadId}`,
      });
      return res.json({
        ok: true, uploadId: aperto.uploadId, maxChunkBytes: aperto.maxChunkBytes, maxBytes: aperto.maxBytes,
        ticket: emettiTicket({ risorsa: `caricamento:${aperto.uploadId}`, attore: auth.attore, ownerId: auth.ownerId }),
      });
    });

    app.post('/artefatti/caricamenti/:id/blocco', cancello, express.raw({ type: '*/*', limit: limiteBlocco }), (req, res) => {
      let id;
      try {
        id = validaRisorsa(`caricamento:${req.params.id}`).split(':')[1];
      } catch {
        return errore(res, 400, 'Identificatore di caricamento non valido.');
      }
      const auth = autorizza(req, res, `caricamento:${id}`);
      if (auth.errore) return auth.errore;
      const offset = Number(req.get('x-codedb-offset'));
      if (!Number.isInteger(offset) || offset < 0) {
        return errore(res, 400, 'Offset del blocco mancante o non valido.');
      }
      const contenuto = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!contenuto.length) return errore(res, 400, 'Blocco vuoto.');
      const dichiarato = String(req.get('x-codedb-blocco-sha256') || '').toLowerCase();
      if (sha256(contenuto) !== dichiarato) {
        traccia('blocco-rifiutato', {
          attore: auth.attore, ownerId: auth.ownerId, risorsa: `caricamento:${id}`,
          esito: 'rifiutato', dettaglio: 'impronta del blocco non coincide',
        });
        return errore(res, 400, 'Impronta del blocco non coincide con il contenuto.');
      }
      try {
        const esito = archivio.aggiungi(id, auth.ownerId, { offset, contenuto, attore: auth.attore });
        return res.json({ ok: true, ...esito });
      } catch (err) {
        traccia('blocco-rifiutato', {
          attore: auth.attore, ownerId: auth.ownerId, risorsa: `caricamento:${id}`,
          esito: 'rifiutato', dettaglio: err.message,
        });
        return errore(res, statoDaCodice(err.codice), err.message);
      }
    });

    app.post('/artefatti/caricamenti/:id/finalizza', cancello, express.json({ limit: '16kb' }), (req, res) => {
      let id;
      try {
        id = validaRisorsa(`caricamento:${req.params.id}`).split(':')[1];
      } catch {
        return errore(res, 400, 'Identificatore di caricamento non valido.');
      }
      const auth = autorizza(req, res, `caricamento:${id}`);
      if (auth.errore) return auth.errore;
      try {
        const manifest = archivio.finalizza(id, auth.ownerId, {
          dimensioneAttesa: req.body && req.body.dimensioneAttesa,
          digestAtteso: req.body && req.body.digestAtteso,
          nome: req.body && req.body.nome,
          attore: auth.attore,
        });
        traccia('caricamento-finalizzato', {
          attore: auth.attore, ownerId: auth.ownerId, risorsa: `artefatto:${manifest.id}`,
          dettaglio: `${manifest.dimensione} byte`,
        });
        return res.json({
          ok: true, manifest,
          ticket: emettiTicket({ risorsa: `artefatto:${manifest.id}`, attore: auth.attore, ownerId: auth.ownerId }),
        });
      } catch (err) {
        traccia('caricamento-finalizzato', {
          attore: auth.attore, ownerId: auth.ownerId, risorsa: `caricamento:${id}`,
          esito: 'fallito', dettaglio: err.message,
        });
        return errore(res, statoDaCodice(err.codice), err.message);
      }
    });

    app.post('/artefatti/caricamenti/:id/scarta', cancello, (req, res) => {
      let id;
      try {
        id = validaRisorsa(`caricamento:${req.params.id}`).split(':')[1];
      } catch {
        return errore(res, 400, 'Identificatore di caricamento non valido.');
      }
      const auth = autorizza(req, res, `caricamento:${id}`);
      if (auth.errore) return auth.errore;
      try {
        const esito = archivio.scarta(id, auth.ownerId, auth.attore);
        traccia('caricamento-scartato', {
          attore: auth.attore, ownerId: auth.ownerId, risorsa: `caricamento:${id}`,
        });
        return res.json(esito);
      } catch (err) {
        return errore(res, statoDaCodice(err.codice), err.message);
      }
    });

    app.get('/artefatti/:id/scarica', cancello, (req, res) => serviDownload(req, res, false));
    app.head('/artefatti/:id/scarica', cancello, (req, res) => serviDownload(req, res, true));
    return app;
  }

  return { emettiTicket, monta, validaRisorsa };
}

module.exports = { creaModuloArtefatti, validaRisorsa };

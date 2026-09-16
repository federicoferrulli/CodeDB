'use strict';

/**
 * Il diario delle operazioni di import: il registro in memoria dimentica tutto
 * al riavvio, e un'operazione `in_corso` al momento del crash resterebbe senza
 * esito — con staging e recupero penzolanti e, peggio, con un COMMIT o una
 * rinomina dall'esito incerto che nessuno riconcilia prima di ritentare.
 *
 * Ogni voce è un file JSON per tenant (`<radice>/<opId>.json`), scritto in
 * modo atomico all'accettazione, a ogni cambio di fase e alla conclusione. Il
 * contenuto è lo stato PUBBLICO (niente adapter, niente strategy, niente
 * segreti): fingerprint del piano, connessione, destinazione, fase, riferimenti
 * a staging/recupero, errore. Alla ripartenza `riconcilia` dichiara
 * `intervento_richiesto` con `esitoIncerto: true` tutto ciò che era ancora in
 * volo — mai «completato», mai cancellato: un recupero con errore non si
 * elimina da solo.
 */

const fs = require('fs');
const path = require('path');

/**
 * Chi sta scrivendo QUESTO diario, in questo momento.
 *
 * `riconcilia` gira a ogni lettura, non solo all'avvio: senza un modo di
 * distinguere «in volo adesso» da «in volo quando il processo e' morto»
 * dichiarerebbe a esito incerto le operazioni vive — comprese le proprie.
 * L'identita' dell'istanza copre il caso locale; il battito (`vivoAl`) copre
 * quello di un secondo processo che condivide la stessa radice (server + CLI,
 * due istanze, Electron), dove il pid non prova nulla.
 */
const ISTANZA = `${process.pid}-${Date.now()}`;

/** Oltre questo silenzio una voce in volo e' considerata orfana. */
const GRAZIA_MS = Number(process.env.CODEDB_IMPORT_DIARIO_GRAZIA_MS) || 60 * 1000;

function guasto(codice, messaggio) {
  const err = new Error(messaggio);
  err.codice = codice;
  return err;
}

function idSicuro(value, cosa) {
  const s = String(value == null ? '' : value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(s) || s === '.' || s === '..') {
    throw guasto('INVALIDO', `${cosa} non valido.`);
  }
  return s;
}

/**
 * Il proprietario si VALIDA, non si riscrive: sostituire i caratteri non
 * ammessi con `_` fa condividere una cartella a due tenant diversi (`a/b` e
 * `a_b`), che e' il contrario di un isolamento. Gli ownerId reali sono UUID
 * o `local`, quindi rifiutare non toglie nulla a nessuno.
 */
function proprietarioSicuro(ownerId) {
  const s = String(ownerId == null ? '' : ownerId).trim();
  if (!s) throw guasto('INVALIDO', 'Proprietario mancante.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(s) || s === '.' || s === '..') {
    throw guasto('INVALIDO', 'Proprietario non valido.');
  }
  return s;
}

function creaDiario({ radicePer, now = () => new Date().toISOString() } = {}) {
  if (typeof radicePer !== 'function') throw new Error('Diario senza radice per tenant.');

  const dirDi = (ownerId) => {
    const dir = path.resolve(radicePer(proprietarioSicuro(ownerId)));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const fileDi = (ownerId, operationId) =>
    path.join(dirDi(ownerId), `${idSicuro(operationId, 'Operazione')}.json`);

  function scrivi(ownerId, operationId, voce) {
    const file = fileDi(ownerId, operationId);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...voce }));
    fs.renameSync(tmp, file);
  }

  return {
    registra({ ownerId, operationId, fingerprint, connection, targetDb, attore = null, tabId = null }) {
      scrivi(ownerId, operationId, {
        operationId: idSicuro(operationId, 'Operazione'),
        ownerId: proprietarioSicuro(ownerId),
        attore, tabId, fingerprint, connection: connection || null, targetDb: targetDb || null,
        status: 'in_corso', phase: 'accettata', progress: [],
        iniziatoAl: now(), terminatoAl: null, recovery: null, staging: null,
        errore: null, esitoIncerto: false,
        istanza: ISTANZA, vivoAl: now(),
      });
    },

    /**
     * Il battito di un'operazione viva. Lo manda il registro mentre lavora,
     * anche quando la fase non cambia: una fase lunga e silenziosa non deve
     * sembrare un processo morto.
     */
    batte({ ownerId, operationId }) {
      const voce = this.leggi({ ownerId, operationId });
      if (!voce || voce.status !== 'in_corso') return false;
      voce.istanza = ISTANZA;
      voce.vivoAl = now();
      scrivi(ownerId, operationId, voce);
      return true;
    },

    /** Solo cambi di fase ed esito, non ogni avanzamento: i punti di recupero. */
    fase({ ownerId, operationId, phase, progress = null }) {
      const voce = this.leggi({ ownerId, operationId });
      if (!voce) return;
      voce.phase = phase;
      voce.istanza = ISTANZA;
      voce.vivoAl = now();
      if (progress) voce.progress = progress.slice(-20);
      scrivi(ownerId, operationId, voce);
    },

    conclude({ ownerId, operationId, status, recovery = null, staging = null, errore = null }) {
      const voce = this.leggi({ ownerId, operationId });
      if (!voce) return;
      voce.status = status;
      voce.phase = 'terminata';
      voce.recovery = recovery;
      voce.staging = staging;
      voce.errore = errore;
      // L'esito c'e': se un riconcilia l'aveva dichiarato incerto mentre
      // l'operazione era ancora viva, l'incertezza finisce qui.
      voce.esitoIncerto = false;
      voce.vivoAl = now();
      voce.terminatoAl = now();
      scrivi(ownerId, operationId, voce);
    },

    leggi({ ownerId, operationId }) {
      let voce;
      try {
        voce = JSON.parse(fs.readFileSync(fileDi(ownerId, operationId), 'utf8'));
      } catch {
        return null;
      }
      return voce && voce.v === 1 ? voce : null;
    },

    elenca(ownerId) {
      let nomi = [];
      try {
        nomi = fs.readdirSync(dirDi(ownerId)).filter((n) => n.endsWith('.json'));
      } catch { return []; }
      const voci = [];
      for (const nome of nomi) {
        const voce = this.leggi({ ownerId, operationId: nome.slice(0, -5) });
        if (voce) voci.push(voce);
      }
      return voci.sort((a, b) => String(a.iniziatoAl).localeCompare(String(b.iniziatoAl)));
    },

    /**
     * Dopo un riavvio tutto ciò che era in volo è a esito incerto: un COMMIT o
     * una rinomina potrebbero essere andati a buon fine senza lasciare traccia.
     * Si dichiara, non si indovina — e si conserva per la riconciliazione
     * manuale. Idempotente: una voce già riconciliata non cambia più.
     *
     * ORFANA, non «in volo»: si riconcilia solo ciò che nessuno sta più
     * seguendo. Una voce di QUESTA istanza è viva per definizione; una di
     * un'altra istanza è viva finché batte. Senza le due guardie ogni
     * `list` — e ne arriva uno a ogni apertura di tab — dichiarava fallita
     * l'operazione che stava lavorando in quel momento.
     *
     * ponytail: il battito e' su file, quindi la finestra di grazia e' anche
     * la latenza con cui un crash viene riconosciuto. Se servisse piu' stretta,
     * un lock file con lease e' il passo successivo.
     */
    riconcilia(ownerId, { grazia = GRAZIA_MS, adesso = Date.now() } = {}) {
      const riconciliate = [];
      for (const voce of this.elenca(ownerId)) {
        if (voce.status !== 'in_corso' || voce.esitoIncerto) continue;
        if (voce.istanza === ISTANZA) continue;
        const battito = Date.parse(voce.vivoAl || voce.iniziatoAl || '');
        if (Number.isFinite(battito) && battito + grazia > adesso) continue;
        voce.status = 'intervento_richiesto';
        voce.phase = 'terminata';
        voce.errore = 'Processo terminato durante l\u2019esecuzione: esito incerto, riconciliare catalogo e journal prima di ritentare.';
        voce.esitoIncerto = true;
        voce.terminatoAl = now();
        scrivi(ownerId, voce.operationId, voce);
        riconciliate.push(voce);
      }
      return riconciliate;
    },

    rimuovi({ ownerId, operationId }) {
      try { fs.rmSync(fileDi(ownerId, operationId), { force: true }); } catch { /* già sparita */ }
      return { ok: true };
    },
  };
}

module.exports = { creaDiario };

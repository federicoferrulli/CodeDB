'use strict';

// CodeDB — eventi-app. Stato e dipendenze appartengono alla singola istanza.

function createModule({ informazioni, identita }) {
  function registra(socketContext, lifecycle) {
    // --- Informazioni sull'installazione ---------------------------------------

    /**
     * Versione dell'applicazione, letta dal `package.json` del server.
     *
     * Serve alla guida introduttiva (`public/js/onboarding.js`) per due decisioni:
     * se mostrare le novità dopo un aggiornamento e cosa scriverci. Passa dal
     * SOCKET, non da `/handshake-check`: quell'endpoint risponde anche a chi non
     * ha superato il gate sull'Origin e non ha alcuna sessione, e la versione
     * esatta di un'installazione raggiungibile in rete è un'informazione che non
     * c'è motivo di regalare a chi non è ancora entrato.
     */
    lifecycle.amministrativo('app:info', (_payload, cb) => {
      cb({ ok: true, version: informazioni.APP_VERSION, ...informazioni.capacitaDesktop() });
    });

    /**
     * "Controlla aggiornamenti…" richiesto dall'interfaccia web.
     *
     * Perché passa da qui invece che da un IPC di Electron: la finestra carica la
     * stessa UI servita da questo server ed è `sandbox: true` senza preload, per
     * cui un canale IPC sarebbe esposto a qualunque pagina finisse lì dentro. Ma
     * quando CodeDB gira come app desktop il server vive NELLO STESSO processo
     * del main di Electron, quindi il gestore degli aggiornamenti è raggiungibile
     * direttamente — senza aprire alcun canale nuovo verso il renderer.
     *
     * L'evento non installa nulla: apre i dialog nativi, dove l'utente decide se
     * scaricare e se riavviare.
     */
    lifecycle.amministrativo('app:updates:check', (_payload, cb) => {
      identita.assertManage(socketContext.principal);
      const ponte = informazioni.ponteDesktop();
      if (!ponte) {
        throw new Error('Gli aggiornamenti automatici sono disponibili solo nell\'app desktop CodeDB.');
      }
      ponte.controllaAggiornamenti();
      cb({ ok: true });
    });

    /**
     * Licenza, manleva ed elenco delle librerie di terze parti, per la schermata
     * "Informazioni & Licenza" (`public/js/about.js`).
     *
     * Il testo della manleva e dell'EULA NON è scritto qui: si legge da
     * `MANLEVA.md` ed `EULA.md`, che sono anche le sorgenti di
     * `build/license.txt` mostrato dall'installer. Due copie dello stesso
     * impegno legale divergerebbero alla prima correzione.
     *
     * Le licenze delle dipendenze si leggono dai loro `package.json` invece di
     * essere elencate a mano: un elenco scritto a mano resta indietro al primo
     * aggiornamento e dichiarerebbe il falso proprio nella schermata che serve a
     * dire il vero. Calcolato una volta sola e tenuto in cache.
     */
    lifecycle.amministrativo('app:license', (_payload, cb) => {
      cb({ ok: true, ...informazioni.datiLicenza() });
    });
  }

  return registra;
}

module.exports = { createModule };

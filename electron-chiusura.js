'use strict';

/** Il recupero vive nel processo principale: un renderer bloccato non può mostrare la conferma. */
function proteggiChiusura(window, dialog, app) {
  let richiesta = false;
  let uscita = false;
  let conferma = false;
  let timer;
  const annullaAttesa = () => { clearTimeout(timer); timer = undefined; };
  const terminaRichiesta = () => { richiesta = false; annullaAttesa(); };
  const annullaChiusura = () => { uscita = false; terminaRichiesta(); };
  const chiediUscita = event => {
    // Finché la finestra decide, Electron non deve restare nello stato "quit in corso".
    event.preventDefault();
    uscita = true;
    window.close();
  };
  app.on('before-quit', chiediUscita);

  async function chiediRecupero() {
    annullaAttesa();
    if (!richiesta || conferma || window.isDestroyed()) return;
    conferma = true;
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning', title: 'CodeDB',
        message: 'La finestra non ha completato la chiusura.',
        detail: 'Puoi attendere che torni a rispondere oppure forzarne la chiusura. '
          + 'Forzando perderai le modifiche non salvate; eventuali scritture già inviate al database potrebbero essere state eseguite e andranno verificate.',
        buttons: ['Attendi', 'Forza chiusura'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (richiesta && response === 1 && !window.isDestroyed()) window.destroy();
    } catch (err) {
      console.error('[Electron] Impossibile mostrare la conferma di chiusura:', err);
    } finally {
      conferma = false;
      annullaChiusura();
    }
  }

  window.on('close', () => {
    richiesta = true;
    if (timer || conferma) return;
    timer = setTimeout(chiediRecupero, 5000);
    timer.unref();
  });
  window.on('unresponsive', () => { if (richiesta) void chiediRecupero(); });
  // La normale protezione dei dati ha risposto: non confonderla con un blocco.
  window.webContents.on('will-prevent-unload', terminaRichiesta);
  window.once('closed', () => {
    terminaRichiesta();
    app.removeListener('before-quit', chiediUscita);
    if (uscita) app.quit();
  });
  return { annullaChiusura };
}

module.exports = { proteggiChiusura };

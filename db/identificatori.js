'use strict';

/* ---------------------------------------------------------------------------
 * Il ponte lato server verso la regola unica degli identificatori.
 *
 * La regola vera sta in `public/js/identificatori.mjs`, e sta lì per un motivo
 * solo: il browser deve poterla scaricare. Il server è CommonJS, quindi la
 * raggiunge con `require()` — che Node concede a un modulo ES purché il file lo
 * dichiari con l'estensione e non abbia `await` di primo livello. Nessuna copia
 * viene fatta qui: questo file è un rimando, e se un giorno il ponte non
 * servisse più basterebbe cancellarlo.
 * ------------------------------------------------------------------------- */

module.exports = require('../public/js/identificatori.mjs');

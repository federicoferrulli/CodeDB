'use strict';

// DEFAULT_GENERATED indica un default valutato dal server: il valore resta
// scrivibile e va conservato nei backup, diversamente dalle colonne calcolate.
function colonnaGenerata(extra) {
  return /\b(?:VIRTUAL|STORED)\s+GENERATED\b/i.test(String(extra || ''));
}

module.exports = { colonnaGenerata };

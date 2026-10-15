'use strict';
// I documenti BSON possono contenere qualsiasi nome: i marcatori interni
// non devono essere falsificabili da un campo o da un oggetto dello script.
module.exports = {
  VALORE_BSON: Symbol('valore BSON'), OGGETTO_HOST: Symbol('oggetto host'),
  FUNZIONE_SCRIPT: Symbol('funzione script'), FUNZIONE_NATIVA: Symbol('funzione nativa'),
  CURSORE: Symbol('cursore'),
};

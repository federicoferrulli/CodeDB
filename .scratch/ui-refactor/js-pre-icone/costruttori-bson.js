'use strict';

// File volutamente compatibile sia con <script type="module"> sia con
// require(): lint/formattatore nel browser e interprete sul server leggono la
// stessa whitelist, senza mantenerne due copie destinate a divergere.
const vocabolarioCostruttoriBson = Object.freeze({
  chiamate: Object.freeze(['ObjectId', 'ISODate', 'NumberLong', 'NumberInt', 'NumberDecimal', 'UUID']),
  conNew: Object.freeze(['Date', 'ObjectId', 'ISODate', 'NumberLong', 'NumberInt', 'NumberDecimal', 'UUID']),
});

globalThis.CODEDB_COSTRUTTORI_BSON = vocabolarioCostruttoriBson;
if (typeof module !== 'undefined' && module.exports) module.exports = vocabolarioCostruttoriBson;

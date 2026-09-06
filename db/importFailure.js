'use strict';

// Una risposta del driver persa o non confermata non prova il mancato INSERT.
// Il marcatore impedisce anche al trasporto server di ripetere l'intero blocco.
function assertImportOutcomeKnown(err) {
  const text = [err && err.name, err && err.code, err && err.message].join(' ');
  const uncertain = err && (err.importOutcomeUnknown || err.writeConcernError
    || (err.writeConcernErrors && err.writeConcernErrors.length))
    || /MongoNetwork|MongoServerSelection|MongoWriteConcern|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|PROTOCOL_CONNECTION_LOST|PROTOCOL_ENQUEUE_AFTER|connection.*(?:lost|closed|terminated|reset)|socket.*(?:closed|hang up)|timeout/i.test(text)
    || /^(08\w{3}|57P0[123])$/.test(String(err && err.code));
  if (uncertain) {
    err.importOutcomeUnknown = true;
    throw err;
  }
}

module.exports = { assertImportOutcomeKnown };

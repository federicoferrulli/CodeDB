'use strict';

const MongoDbStrategy = require('./MongoDbStrategy');
const MySqlStrategy = require('./MySqlStrategy');
const PostgreSqlStrategy = require('./PostgreSqlStrategy');

const STRATEGIES = {
  mongodb: MongoDbStrategy,
  mysql: MySqlStrategy,
  postgresql: PostgreSqlStrategy,
  postgres: PostgreSqlStrategy,
};

const DEFAULT_PORTS = {
  mongodb: 27017,
  mysql: 3306,
  postgresql: 5432,
  postgres: 5432,
};

// Istanzia la strategia per il tipo di database richiesto.
// dbType assente = 'mongodb', per retrocompatibilità con le connessioni
// salvate prima dell'introduzione del campo.
function getStrategy(dbType) {
  const key = String(dbType || 'mongodb').trim().toLowerCase();
  const Strategy = STRATEGIES[key];
  if (!Strategy) throw new Error(`Tipo di database non supportato: "${dbType}"`);
  return new Strategy();
}

function defaultPort(dbType) {
  const key = String(dbType || 'mongodb').trim().toLowerCase();
  return DEFAULT_PORTS[key] || 27017;
}

function isSqlType(dbType) {
  const key = String(dbType || '').trim().toLowerCase();
  return key === 'mysql' || key === 'postgresql' || key === 'postgres';
}

module.exports = {
  getStrategy,
  defaultPort,
  isSqlType,
  SUPPORTED_TYPES: Object.keys(STRATEGIES),
};

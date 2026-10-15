'use strict';
// I nomi dei nodi risolvono nella rete Docker; sul solo host le porte sono loopback.
// Il gateway resta riconosciuto per il fixture precedente sql-replica-containers.
const dns = require('node:dns');
const originale = dns.lookup;
dns.lookup = function lookup(host, options, callback) {
  if (host !== 'host.docker.internal' && !/^codedb-sql-node-270(?:39|40|41)$/.test(host)) return originale.apply(this, arguments);
  if (typeof options === 'function') { callback = options; options = {}; }
  process.nextTick(() => options?.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4));
};

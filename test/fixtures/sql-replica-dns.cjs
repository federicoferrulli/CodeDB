'use strict';
// Solo nei processi di test: i container raggiungono il gateway Docker,
// i client Windows raggiungono le stesse porte pubblicate sul loopback.
const dns = require('node:dns'), lookup = dns.lookup;
dns.lookup = function (hostname, ...args) {
  return lookup.call(this, hostname === 'host.docker.internal' ? '127.0.0.1' : hostname, ...args);
};

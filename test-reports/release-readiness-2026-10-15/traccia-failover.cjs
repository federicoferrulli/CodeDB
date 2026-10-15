'use strict';
require('node:module').registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/e2e-sql-mongo-failover.js')) return result;
  let source = String(result.source).replace('serverSelectionTimeoutMS: 20000,', 'monitorCommands: true, serverSelectionTimeoutMS: 20000,');
  source = source.replace('let connected = false, stopped;', `
  for (const event of ['commandStarted','commandSucceeded','commandFailed']) client.on(event, e => {
    console.log(JSON.stringify({ora:new Date().toISOString(),event,comando:e.commandName,id:e.requestId,
      server:e.address,durata:e.duration,errore:e.failure?.message}));
  });
  let connected = false, stopped;`);
  return { ...result, source };
} });

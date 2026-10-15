'use strict';
// Processo dedicato: il JavaScript di mongosh ha i privilegi OS dell'amministratore.
const vm = require('node:vm');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { inspect } = require('node:util');
const { Console } = require('node:console');
const { Writable } = require('node:stream');
const { NodeDriverServiceProvider } = require('@mongosh/service-provider-node-driver');
const { ShellInstanceState, getShellApiType, toShellResult } = require('@mongosh/shell-api');
const { ShellEvaluator } = require('@mongosh/shell-evaluator');
let state, evaluator, context, bson, limiteBytes, stampe = [], dbRichiesto, occupato = false, outputSuperato = false;
const flussi = new Map(), domande = new Map();
const invia = data => new Promise(resolve => {
  if (!process.connected) return resolve();
  process.send(data, () => resolve());
});
function valoriJs(value, seen = new Set()) {
  // EJSON converte BigInt in Long troncando a 64 bit: fuori da BSON lo mostriamo esatto.
  if (typeof value === 'bigint') return `${value}n`;
  if (!value || typeof value !== 'object' || value._bsontype) return value;
  const tag = Object.prototype.toString.call(value);
  if (!['[object Object]', '[object Array]', '[object Map]', '[object Set]'].includes(tag)) return value;
  if (seen.has(value)) throw Object.assign(new Error('Risultato JavaScript circolare'), {circular:true});
  seen.add(value);
  let result;
  if (tag === '[object Array]' || tag === '[object Set]') result = [...value].map(v => valoriJs(v, seen));
  else result = Object.fromEntries((tag === '[object Map]' ? [...value] : Object.entries(value)).map(([k,v]) => [k,valoriJs(v,seen)]));
  seen.delete(value);
  return result;
}
function serializza(value) {
  let normalized;
  try { normalized = valoriJs(value); }
  catch (err) { if (!err.circular) throw err; normalized = inspect(value, {depth:6,colors:false}); }
  const encoded = bson.EJSON.serialize(normalized, { relaxed: false });
  // Gli interi BSON piccoli restano numeri della griglia; Long e Decimal rimangono esatti.
  const text = JSON.stringify(encoded, (key, v) => typeof v === 'bigint' ? `${v}n` : v && typeof v === 'object'
    ? Object.keys(v).length === 1 && ('$numberInt' in v || '$numberDouble' in v)
      ? (Number.isFinite(Number(v.$numberInt ?? v.$numberDouble)) ? Number(v.$numberInt ?? v.$numberDouble) : v) : v : v);
  if (Buffer.byteLength(text || '') > limiteBytes) throw new Error('Risultato mongosh oltre il limite di byte. Restringi il risultato.');
  return text === undefined ? null : JSON.parse(text);
}
const valuta = (code, filename = 'query.mongosh.js') => evaluator.customEval(
  (source, ctx, file) => new vm.Script(source, { filename: file,
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInContext(ctx), code, context, filename);
async function avvia(options) {
  limiteBytes = options.maxBytes;
  const provider = await NodeDriverServiceProvider.connect(options.uri, {
    appName: 'CodeDB-mongosh', serverSelectionTimeoutMS: 6000, connectTimeoutMS: 6000,
  });
  bson = provider.bsonLibrary;
  state = new ShellInstanceState(provider, new EventEmitter());
  state.isInteractive = true;
  const output = new Writable({write(chunk, encoding, done) {
    const text = chunk.toString().replace(/\n$/, '');
    if (stampe.length >= 1000 || Buffer.byteLength(stampe.join('\n')) + chunk.length > limiteBytes) outputSuperato = true;
    else { stampe.push(text); void invia({event:'output',lines:[text]}); }
    done();
  }});
  context = vm.createContext({ process, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
    AbortController, AbortSignal, fetch, structuredClone, console: new Console({stdout:output,stderr:output}),
    require: createRequire(path.join(process.cwd(), 'query.mongosh.js')) });
  context.global = context;
  state.setCtx(context);
  evaluator = new ShellEvaluator(state, value => value);
  const config = new Map([['enableTelemetry', false]]);
  state.setEvaluationListener({
    getCryptLibraryOptions: () => ({
      ...(process.env.CODEDB_MONGOSH_CRYPT_SHARED_LIB_PATH ? {
        cryptSharedLibPath: process.env.CODEDB_MONGOSH_CRYPT_SHARED_LIB_PATH, cryptSharedLibRequired: true,
      } : {}),
      ...(process.env.CODEDB_MONGOSH_MONGOCRYPTD_URI ? {
        mongocryptdURI: process.env.CODEDB_MONGOSH_MONGOCRYPTD_URI, mongocryptdBypassSpawn: true,
      } : {}),
    }),
    getConfig: key => config.get(key),
    setConfig: (key, value) => { config.set(key, value); return 'success'; },
    resetConfig: key => { config.delete(key); return 'success'; },
    onPrint: values => {
      const line = values.map(v => typeof v.printable === 'string' ? v.printable : inspect(v.printable, { depth: 6, colors: false })).join(' ');
      if (stampe.length >= 1000 || Buffer.byteLength(stampe.join('\n') + line) > limiteBytes) throw new Error('Output mongosh oltre il limite.');
      stampe.push(line);
      void invia({event:'output',lines:[line]});
    },
    onClearCommand: () => { stampe = []; },
    onExit: code => { throw Object.assign(new Error('Chiusura mongosh richiesta.'), {mongoshExitCode: Number(code) || 0}); },
    onPrompt: (question, type) => new Promise(resolve => {
      const id = randomUUID(); domande.set(id, resolve); void invia({ event: 'prompt', id, question, type });
    }),
    onLoad: async filename => {
      const resolvedFilename = path.resolve(filename), code = await fs.readFile(resolvedFilename, 'utf8');
      return { resolvedFilename, evaluate: () => valuta(code, resolvedFilename) };
    },
  });
  return { pronto: true };
}
async function osserva(cursor) {
  for (const [id, f] of flussi) if (f.cursor === cursor) return id;
  if (flussi.size >= 10) throw new Error('Massimo 10 change stream visualizzati per tab: chiudine uno.');
  const id = randomUUID(), f = { cursor, chiuso: false };
  flussi.set(id, f);
  // tryNext apre il cursore prima dell'ack: una scrittura successiva non va persa.
  let primo;
  try { primo = await cursor.tryNext(); }
  catch (err) { flussi.delete(id); await cursor.close().catch(() => {}); throw err; }
  await invia({ event: 'stream', id, status: 'aperto', resumeToken: serializza(cursor.getResumeToken()) });
  if (primo) await invia({ event: 'stream', id, status: 'evento', document: serializza(primo), resumeToken: serializza(cursor.getResumeToken()) });
  f.loop = (async () => {
    try {
      while (!f.chiuso && !cursor.isClosed()) {
        const document = await cursor.tryNext();
        if (document) await invia({ event: 'stream', id, status: 'evento', document: serializza(document), resumeToken: serializza(cursor.getResumeToken()) });
        else await new Promise(resolve => setTimeout(resolve, 25));
      }
      await invia({ event: 'stream', id, status: 'chiuso', resumeToken: serializza(cursor.getResumeToken()) });
    } catch (err) {
      await invia({ event: 'stream', id, status: f.chiuso ? 'chiuso' : 'errore', error: f.chiuso ? undefined : err.message,
        resumeToken: serializza(cursor.getResumeToken()) });
    } finally { await cursor.close().catch(() => {}); flussi.delete(id); }
  })();
  return id;
}
async function esegui({ code, db }) {
  stampe = [];
  outputSuperato = false;
  await invia({event:'evaluation',status:'running'});
  if (db && db !== dbRichiesto) { state.setDbFunc(state.currentDb.getSiblingDB(db)); dbRichiesto = db; }
  const raw = await valuta(code);
  if (outputSuperato) throw new Error('Output mongosh oltre il limite.');
  const type = getShellApiType(raw);
  let docs = [], streamId, cursorHasMore = false;
  if (type === 'ChangeStreamCursor') {
    streamId = await osserva(raw);
    docs = [{ changeStream: streamId, stato: 'In ascolto' }];
  } else {
    const result = await toShellResult(raw);
    let value = result.printable;
    if (value instanceof Map) value = Object.fromEntries(value);
    if (typeof value === 'function') value = inspect(value);
    if (['Cursor', 'AggregationCursor', 'RunCommandCursor', 'CursorIterationResult'].includes(result.type)) {
      cursorHasMore = value?.cursorHasMore === true;
      value = value?.documents || value;
    }
    if (value !== undefined) {
      value = serializza(value);
      docs = Array.isArray(value) ? value.map(v => v && typeof v === 'object' ? v : { valore: v })
        : [value && typeof value === 'object' ? value : { valore: value }];
    }
  }
  if (!docs.length && stampe.length) docs = stampe.map((output, i) => ({ '#': i + 1, output }));
  return { docs, scriptOutput: stampe, streamId, cursorHasMore, activeDb: state.currentDb.getName(), runtime: 'mongosh' };
}
process.on('message', async msg => {
  if (msg.action === 'answer') { domande.get(msg.promptId)?.(String(msg.value || '')); domande.delete(msg.promptId); return; }
  try {
    let result;
    if (msg.action === 'init') result = await avvia(msg.options);
    else if (msg.action === 'closeStream') {
      const f = flussi.get(msg.streamId);
      if (f) { f.chiuso = true; await f.cursor.close(); await f.loop; }
      result = { chiuso: !!f };
    } else if (msg.action === 'close') {
      for (const f of flussi.values()) f.chiuso = true;
      await state?.close(); await invia({ id: msg.id, result: { chiuso: true } }); process.exit(0); return;
    } else {
      if (occupato) throw new Error('Una query mongosh è già in esecuzione in questo tab.');
      occupato = true;
      try { result = await esegui(msg); } finally { occupato = false; }
    }
    await invia({ id: msg.id, result });
  } catch (err) {
    if (Number.isInteger(err.mongoshExitCode)) {
      await state?.close(); await invia({id:msg.id,result:{docs:[],exited:true,exitCode:err.mongoshExitCode,runtime:'mongosh'}});
      process.exit(err.mongoshExitCode);
    }
    await invia({ id: msg.id, error: { message: err.message, name: err.name, code: err.code } });
  }
});
process.on('disconnect', () => process.exit(0));

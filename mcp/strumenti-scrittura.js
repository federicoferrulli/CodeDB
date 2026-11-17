'use strict';

/* ---------------------------------------------------------------------------
 * Strumenti MCP di mutazione con conferma esplicita (human-in-the-loop):
 * - execute_write (singola e batch omogeneo su MongoDB, MySQL e PostgreSQL)
 * - execute_ddl (DDL di schema su MySQL e PostgreSQL)
 * - set_connection_read_only (modifica del solo flag readOnly in connections.ini)
 * ------------------------------------------------------------------------- */

const { z } = require('zod');
const { EJSON } = require('bson');
const DbFactory = require('../db/DbFactory');
const { can, canWholeConnection } = require('../auth/permissions');
const { DDL_AUTH_CAPABILITIES, SQL_DDL_AUTHORIZED } = require('../auth/capabilities');
const { normalizzaDocumentiInsert } = require('../db/mongoInsert');
const { descriviEsitoParziale } = require('./esitoScrittura');
const {
  WRITE_OP_CAPABILITY, errMsg, jsonResult,
  assertWriteSql, assertDdlSql, parseNonEmptyObject,
} = require('./guardie');

const CAMPI_SCRITTURA_SINGOLA = [
  'collection', 'operation', 'doc', 'filter', 'set', 'upsert', 'sql',
];

const writeDescriptorSchema = z.union([
  z.object({ sql: z.string() }).strict(),
  z.object({
    collection: z.string().optional(),
    operation: z.enum(['insert', 'update', 'delete', 'drop_collection', 'drop_database']),
    doc: z.union([z.string(), z.array(z.record(z.string(), z.unknown())).min(1)]).optional(),
    filter: z.string().optional(),
    set: z.string().optional(),
    upsert: z.boolean().optional(),
  }).strict(),
]);

function buildWriteOp(sess, args, db) {
  const dropOp = String(args.operation || '').trim().toLowerCase();
  if (dropOp === 'drop_collection') {
    const coll = String(args.collection || '').trim();
    if (!coll) throw new Error('Parametro "collection" mancante per drop_collection.');
    return {
      summary: { dbType: sess.dbType, db, collection: coll, operation: dropOp },
      exec: async () => { await sess.strategy.dropCollection(db, coll); return { dropped: `${db}.${coll}` }; },
    };
  }
  if (dropOp === 'drop_database') {
    return {
      summary: { dbType: sess.dbType, db, operation: dropOp },
      exec: async () => { await sess.strategy.dropDatabase(db); return { dropped: db }; },
    };
  }
  if (DbFactory.isSqlType(sess.dbType)) {
    const sql = String(args.sql || '').trim();
    if (!sql) throw new Error('Per MySQL/PostgreSQL usa il parametro "sql" con uno statement INSERT/UPDATE/DELETE (REPLACE solo MySQL).');
    assertWriteSql(sql);
    return {
      summary: { dbType: sess.dbType, db, sql },
      exec: () => sess.strategy.collectionAggregate(db, null, { pipeline: sql }),
    };
  }
  if (args.sql && String(args.sql).trim()) {
    throw new Error('Il parametro "sql" vale solo per MySQL/PostgreSQL: su MongoDB usa "operation" con "doc"/"filter"/"set".');
  }
  const coll = String(args.collection || '').trim();
  if (!coll) throw new Error('Parametro "collection" mancante.');
  const operation = String(args.operation || '').trim().toLowerCase();
  if (operation === 'insert') {
    const docText = typeof args.doc === 'string' ? args.doc : JSON.stringify(args.doc);
    if (!docText || !docText.trim()) throw new Error('Parametro "doc" mancante per l\'insert.');
    let valore;
    try {
      valore = EJSON.parse(docText, { relaxed: false });
    } catch (err) {
      throw new Error(`Documento o array EJSON non valido: ${errMsg(err)}`);
    }
    const { documenti, multiplo } = normalizzaDocumentiInsert(valore);
    return {
      summary: {
        dbType: 'mongodb', db, collection: coll, operation,
        ...(!multiplo ? { doc: docText } : {}), documentCount: documenti.length,
      },
      quotaPayload: docText,
      exec: () => sess.strategy.docInsert(db, coll, { doc: docText }),
    };
  }
  if (operation === 'update') {
    parseNonEmptyObject(args.filter, 'Filtro');
    parseNonEmptyObject(args.set, 'Oggetto "set"');
    const upsert = args.upsert === true;
    return {
      summary: {
        dbType: 'mongodb', db, collection: coll, operation,
        filter: args.filter, set: args.set, upsert,
      },
      exec: () => sess.strategy.collectionUpdateMany(db, coll, {
        filter: args.filter, set: args.set, upsert,
      }),
    };
  }
  if (operation === 'delete') {
    parseNonEmptyObject(args.filter, 'Filtro');
    return {
      summary: { dbType: 'mongodb', db, collection: coll, operation, filter: args.filter },
      exec: () => sess.strategy.collectionDeleteMany(db, coll, { filter: args.filter }),
    };
  }
  throw new Error('Parametro "operation" mancante o non valido: usa "insert", "update", "delete", "drop_collection" o "drop_database" (per il DML su MySQL usa "sql").');
}

function classeDelDescrittore(descrittore) {
  if (descrittore && descrittore.sql !== undefined) return 'sql';
  const operazione = String((descrittore && descrittore.operation) || '').trim();
  return (operazione === 'drop_collection' || operazione === 'drop_database') ? 'drop' : 'mongo';
}

function assertBatchOmogeneo(sess, descrittori) {
  const classi = descrittori.map(classeDelDescrittore);
  const quante = (classe) => classi.filter((c) => c === classe).length;
  const suSql = DbFactory.isSqlType(sess.dbType);

  if (suSql && quante('drop')) {
    const drop = descrittori[classi.indexOf('drop')];
    throw new Error(
      `Su ${sess.dbType} un batch ammette solo statement "sql": `
      + `"${String(drop.operation).trim()}" e' un'operazione di schema e non puo' far parte di un `
      + 'blocco transazionale. Eseguila come scrittura singola, oppure usa execute_ddl.'
    );
  }
  if (quante('sql') && (quante('mongo') || quante('drop'))) {
    throw new Error(
      'Batch misto: "operations" deve contenere o soli statement "sql" (MySQL/PostgreSQL) '
      + 'o soli descrittori MongoDB ("operation" con "doc"/"filter"/"set"), mai i due insieme.'
    );
  }
  if (suSql && quante('mongo')) {
    throw new Error(`Su ${sess.dbType} ogni descrittore del batch deve avere il campo "sql".`);
  }
  if (!suSql && quante('sql')) {
    throw new Error('Il parametro "sql" vale solo per MySQL/PostgreSQL: su MongoDB usa "operation" con "doc"/"filter"/"set".');
  }
}

async function stimaImpatto(sess, db, summary) {
  try {
    if (summary.operation === 'update' || summary.operation === 'delete') {
      return (await sess.strategy.collectionFind(db, summary.collection, { filter: summary.filter, limit: 1 })).total;
    }
    if (summary.operation === 'drop_collection') {
      return (await sess.strategy.collectionFind(db, summary.collection, { limit: 1 })).total;
    }
    if (summary.operation === 'drop_database') {
      return (await sess.strategy.listCollections(db)).length;
    }
  } catch { /* la stima è facoltativa */ }
  return undefined;
}

async function stimaImpattoBatch(sess, db, sommari) {
  let totale;
  for (const sommario of sommari || []) {
    const stima = await stimaImpatto(sess, db, sommario);
    if (Number.isFinite(stima)) totale = (totale || 0) + stima;
  }
  return totale;
}

function buildWriteRequest(sess, args, db) {
  if (!Array.isArray(args.operations)) return buildWriteOp(sess, args, db);
  if (CAMPI_SCRITTURA_SINGOLA.some((field) => args[field] !== undefined)) {
    throw new Error('Non mescolare "operations" con i parametri di una scrittura singola.');
  }
  assertBatchOmogeneo(sess, args.operations);
  const operations = args.operations.map((descriptor) => buildWriteOp(sess, descriptor, db));
  const quotaPayload = operations.map((operation) => operation.quotaPayload).filter(Boolean).join('\n');

  if (DbFactory.isSqlType(sess.dbType)) {
    const summary = {
      dbType: sess.dbType,
      db,
      operation: 'batch',
      transactional: true,
      operationCount: operations.length,
      operations: operations.map((operation) => operation.summary),
    };
    const sql = operations.map((operation) => operation.summary.sql);
    return {
      summary,
      ...(quotaPayload ? { quotaPayload } : {}),
      exec: () => sess.strategy.executeWriteBatch(db, sql),
    };
  }

  const summary = {
    dbType: sess.dbType,
    db,
    operation: 'batch',
    transactional: false,
    atomicita: 'assente: le mutazioni sono applicate in ordine e un errore non annulla le precedenti',
    operationCount: operations.length,
    operations: operations.map((operation) => operation.summary),
  };
  return {
    summary,
    ...(quotaPayload ? { quotaPayload } : {}),
    exec: async () => {
      const results = [];
      for (let index = 0; index < operations.length; index++) {
        try {
          results.push(await operations[index].exec());
        } catch (err) {
          const failedOperationResult = err.auditResult;
          err.auditResult = {
            transactional: false,
            operationCount: operations.length,
            completed: results.length,
            failedIndex: index,
            results,
            ...(failedOperationResult ? { failedOperationResult } : {}),
          };
          throw err;
        }
      }
      return {
        transactional: false,
        operationCount: operations.length,
        completed: results.length,
        results,
      };
    },
  };
}

function registraStrumentiScrittura({
  tool, session, deps, audit, confirmFlow,
  requireDbSession, sessionPrincipal, refreshWritesAllowed,
}) {
  tool('execute_write', {
    title: 'Esegui scrittura (con conferma)',
    description:
      'Esegue una scrittura sul database in due passaggi. Funziona solo su connessioni salvate con readOnly=false ' +
      'esplicito in connections.ini (default: sola lettura). ' +
      'Primo passo: chiama SENZA confirm_token per ottenere l\'anteprima dell\'operazione e un token di conferma. ' +
      'Mostra l\'anteprima all\'utente umano e chiedi la sua approvazione esplicita: solo dopo richiama con confirm_token. ' +
      'NON confermare mai di tua iniziativa. Il token è monouso: expires_in_seconds indica la sua validità. ' +
      'MongoDB: "operation" (insert|update|delete) con "doc" (insert: documento o array non vuoto di documenti) ' +
      'o "filter"+"set" (update, con "upsert=true" opzionale) o "filter" (delete), in Extended JSON; ' +
      'filtri vuoti rifiutati. MySQL/PostgreSQL: "sql" con INSERT/UPDATE/DELETE (MySQL anche REPLACE); UPDATE/DELETE richiedono WHERE. ' +
      'Su tutti i dbType "operation" ammette anche "drop_collection" (elimina la collection/tabella indicata) e ' +
      '"drop_database" (elimina l\'intero database "db"); i db di sistema sono protetti. Nessun altro DDL è ammesso. ' +
      'Per piu mutazioni usa "operations": un array non vuoto di descrittori tutti SQL o tutti MongoDB; ' +
      'l\'anteprima e il confirm_token coprono l\'intero blocco, eseguito in ordine (in una transazione unica su MySQL/PostgreSQL). ' +
      'Ogni richiesta ed esecuzione viene registrata in un audit log sul server.',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Database (MySQL/PostgreSQL: schema) su cui operare'),
      collection: z.string().optional().describe('Collection/tabella su cui operare (per MongoDB e per drop_collection)'),
      operation: z.enum(['insert', 'update', 'delete', 'drop_collection', 'drop_database']).optional().describe('Tipo di scrittura: insert/update/delete solo MongoDB; drop_collection e drop_database per tutti i dbType'),
      doc: z.union([
        z.string(),
        z.array(z.record(z.string(), z.unknown())).min(1),
      ]).optional().describe('Solo MongoDB insert: documento EJSON serializzato oppure array non vuoto di documenti Extended JSON'),
      filter: z.string().optional().describe('Solo MongoDB update/delete: filtro esplicito in Extended JSON (mai vuoto)'),
      set: z.string().optional().describe('Solo MongoDB update: campi da aggiornare ($set) in Extended JSON'),
      upsert: z.boolean().optional().describe('Solo MongoDB update: true per inserire un documento se il filtro non trova corrispondenze (default: false)'),
      sql: z.string().optional().describe('Solo MySQL/PostgreSQL: statement INSERT/UPDATE/DELETE (REPLACE solo MySQL); UPDATE/DELETE con WHERE'),
      operations: z.array(writeDescriptorSchema).min(1).optional().describe('Batch non vuoto di descrittori tutti SQL oppure tutti MongoDB, alternativo ai parametri di scrittura singola'),
      confirm_token: z.string().optional().describe('Token restituito dal primo passo, da inviare solo dopo la conferma esplicita dell\'utente umano'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (args) => {
    const sess = requireDbSession(args.connection_id);
    if (!refreshWritesAllowed(session, sess, deps)) {
      throw new Error(`La connessione "${sess.name}" è in sola lettura: per abilitare le scritture imposta readOnly=false nella sua sezione di connections.ini, oppure usa il tool set_connection_read_only (richiede la conferma esplicita dell'utente umano).`);
    }
    const db = String(args.db || '').trim();
    if (!db) throw new Error('Parametro "db" mancante.');

    const descriptors = Array.isArray(args.operations) ? args.operations : [args];
    let deniedCapability = null;
    for (const descriptor of descriptors) {
      const operationCap = WRITE_OP_CAPABILITY[String(descriptor.operation || '').trim()];
      const requiredCaps = operationCap
        ? [operationCap]
        : (descriptor.sql ? ['read', assertWriteSql(descriptor.sql)] : []);
      const missingCap = requiredCaps.find((capability) => !can(sessionPrincipal(session), {
        connName: sess.name, capability, db, coll: descriptor.collection || null,
      }));
      if (missingCap) {
        deniedCapability = missingCap;
        break;
      }
    }
    if (deniedCapability) {
      throw new Error(
        'Permesso negato: la API key usata non ha i privilegi di scrittura sulla connessione "'
        + sess.name + '".'
      );
    }

    confirmFlow.sweep();
    const auditBase = { sessionId: session.id, connection: sess.name, dbType: sess.dbType };

    const token = String(args.confirm_token || '').trim();
    if (token) {
      const pending = confirmFlow.consume(token, 'write', (p) => p.connectionId === String(args.connection_id), 'connessione');
      try {
        const result = await pending.exec();
        audit({ ...auditBase, event: 'executed', ...pending.summary, result });
        return jsonResult({ executed: true, ...pending.summary, result });
      } catch (err) {
        audit({
          ...auditBase, event: 'failed', ...pending.summary, error: errMsg(err),
          ...(err && err.auditResult ? { result: err.auditResult } : {}),
        });
        const parziale = descriviEsitoParziale(err && err.auditResult);
        if (parziale) err.message = `${errMsg(err)} — ${parziale}`;
        throw err;
      }
    }

    const op = buildWriteRequest(sess, args, db);
    const affectedEstimate = op.summary.operation === 'batch'
      ? await stimaImpattoBatch(sess, db, op.summary.operations)
      : await stimaImpatto(sess, db, op.summary);

    audit({ ...auditBase, event: 'requested', ...op.summary, affectedEstimate });
    return confirmFlow.issue('write', { connectionId: String(args.connection_id), exec: op.exec, summary: op.summary }, {
      toolName: 'execute_write',
      preview: op.summary,
      extra: affectedEstimate != null ? { affected_estimate: affectedEstimate } : undefined,
      quotaPayload: op.quotaPayload,
    });
  });

  tool('execute_ddl', {
    title: 'Esegui DDL (con conferma)',
    description:
      'Esegue un singolo comando DDL su MySQL o PostgreSQL in due passaggi. Funziona solo su connessioni ' +
      'salvate con readOnly=false. Primo passo: chiama SENZA confirm_token e passa "sql" per ottenere ' +
      'anteprima e token; mostra l\'anteprima all\'utente umano e chiedi conferma esplicita. Solo dopo ' +
      'richiama con lo stesso connection_id e db e con confirm_token (senza bisogno di ripetere sql). ' +
      'NON confermare autonomamente. Sono ammessi CREATE, ALTER, DROP, TRUNCATE, RENAME e COMMENT; ' +
      'DML, statement multipli, comandi amministrativi e I/O su file sono rifiutati. Richiede la capability ' +
      'ddl o manage. Ogni richiesta, esecuzione e fallimento viene registrato come evento distruttivo.',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Database (MySQL) o schema (PostgreSQL) nel cui contesto eseguire il DDL'),
      sql: z.string().optional().describe('Singolo statement DDL; obbligatorio nel primo passo, omesso alla conferma'),
      confirm_token: z.string().optional().describe('Token restituito dal primo passo, da inviare solo dopo la conferma esplicita dell\'utente umano'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (args) => {
    const sess = requireDbSession(args.connection_id);
    if (!refreshWritesAllowed(session, sess, deps)) {
      throw new Error(`La connessione "${sess.name}" e' in sola lettura: per eseguire DDL imposta readOnly=false oppure usa set_connection_read_only con conferma esplicita.`);
    }
    if (!DbFactory.isSqlType(sess.dbType)) {
      throw new Error('execute_ddl e\' disponibile solo per database relazionali MySQL e PostgreSQL.');
    }
    const db = String(args.db || '').trim();
    if (!db) throw new Error('Parametro "db" mancante.');

    const principal = sessionPrincipal(session);
    const ddlAllowed = DDL_AUTH_CAPABILITIES.some((capability) =>
      can(principal, { connName: sess.name, capability, db }));
    if (!ddlAllowed) {
      throw new Error(
        'Permesso negato: la API key usata non ha la capability ddl o manage sulla connessione "'
        + sess.name + '".'
      );
    }

    confirmFlow.sweep();
    const auditBase = {
      sessionId: session.id,
      ownerId: principal.ownerId,
      userId: principal.id,
      connection: sess.name,
      dbType: sess.dbType,
      db,
      operation: 'ddl',
      tool: 'execute_ddl',
      category: 'write',
      destructive: true,
    };

    const token = String(args.confirm_token || '').trim();
    if (token) {
      const pending = confirmFlow.consume(
        token,
        'ddl',
        (entry) => entry.connectionId === String(args.connection_id) && entry.summary.db === db,
        'operazione DDL',
      );
      try {
        const result = await pending.exec();
        audit({ ...auditBase, event: 'executed', sql: pending.summary.sql, result });
        return jsonResult({ executed: true, ...pending.summary, result });
      } catch (err) {
        audit({ ...auditBase, event: 'failed', sql: pending.summary.sql, error: errMsg(err) });
        throw err;
      }
    }

    const sql = assertDdlSql(args.sql);
    const summary = { dbType: sess.dbType, db, operation: 'ddl', sql };
    const exec = () => sess.strategy.collectionAggregate(db, null, {
      pipeline: sql,
      [SQL_DDL_AUTHORIZED]: true,
    });
    audit({ ...auditBase, event: 'requested', sql });
    return confirmFlow.issue('ddl', {
      connectionId: String(args.connection_id), summary, exec,
    }, {
      toolName: 'execute_ddl',
      preview: summary,
      quotaPayload: sql,
    });
  });

  tool('set_connection_read_only', {
    title: 'Cambia il flag readOnly di una connessione salvata (con conferma)',
    description:
      'Imposta il flag readOnly di una connessione salvata in connections.ini (unico campo modificabile via MCP: ' +
      'mai credenziali o altri parametri). Con read_only=false la connessione diventa scrivibile per execute_write; ' +
      'con read_only=true torna in sola lettura. Funziona in due passaggi come execute_write: ' +
      'primo passo SENZA confirm_token per ottenere anteprima e token; mostra l\'anteprima all\'utente umano e ' +
      'richiama col token solo dopo la sua approvazione esplicita. NON confermare mai di tua iniziativa. ' +
      'Il cambio vale anche per le connessioni MCP già aperte dalla richiesta successiva. ' +
      'Ogni richiesta ed esecuzione viene registrata nell\'audit log.',
    inputSchema: {
      connection_name: z.string().describe('Nome della connessione salvata (vedi list_saved_connections)'),
      read_only: z.boolean().optional().describe('Nuovo valore del flag: false = scritture consentite, true = sola lettura (obbligatorio al primo passo)'),
      confirm_token: z.string().optional().describe('Token restituito dal primo passo, da inviare solo dopo la conferma esplicita dell\'utente umano'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (args) => {
    const name = String(args.connection_name || '').trim();
    if (!name) throw new Error('Parametro "connection_name" mancante.');
    if (!canWholeConnection(sessionPrincipal(session), name, 'manage')) {
      throw new Error(`Permesso negato: la API key usata non può modificare la configurazione della connessione "${name}".`);
    }
    confirmFlow.sweep();
    const auditBase = { sessionId: session.id, connection: name, operation: 'set_connection_read_only' };

    const token = String(args.confirm_token || '').trim();
    if (token) {
      const pending = confirmFlow.consume(token, 'ini', (p) => p.name === name, 'richiesta');
      try {
        deps.setConnectionReadOnly(name, pending.readOnly, sessionPrincipal(session).ownerId);
        audit({ ...auditBase, event: 'executed', readOnly: pending.readOnly });
        return jsonResult({
          executed: true,
          connection: name,
          readOnly: pending.readOnly,
          nota: 'Il nuovo flag vale per le prossime connessioni: riapri con connect_database per applicarlo.',
        });
      } catch (err) {
        audit({ ...auditBase, event: 'failed', readOnly: pending.readOnly, error: errMsg(err) });
        throw err;
      }
    }

    if (typeof args.read_only !== 'boolean') {
      throw new Error('Parametro "read_only" mancante: indica true (sola lettura) o false (scritture consentite).');
    }
    const conn = deps.loadConnections(sessionPrincipal(session).ownerId)[name];
    if (!conn) throw new Error(`Connessione salvata "${name}" inesistente: verifica con list_saved_connections.`);
    const current = String(conn.readOnly || '').trim().toLowerCase() !== 'false';
    if (current === args.read_only) {
      return jsonResult({ changed: false, connection: name, readOnly: current, message: 'Il flag ha già il valore richiesto: nessuna modifica necessaria.' });
    }
    audit({ ...auditBase, event: 'requested', readOnly: args.read_only });
    return confirmFlow.issue('ini', { name, readOnly: args.read_only }, {
      toolName: 'set_connection_read_only',
      preview: { connection: name, readOnly: { da: current, a: args.read_only } },
    });
  });
}

module.exports = {
  registraStrumentiScrittura,
  writeDescriptorSchema,
};

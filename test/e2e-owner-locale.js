'use strict';

// Impostare CODEDB_E2E_MONGO_URI sull'istanza di prova.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MongoClient } = require('mongodb');
const { AppStore } = require('../auth/AppStore');
const { LocalEntitlementProvider } = require('../auth/EntitlementProvider');

async function run() {
  const uri = process.env.CODEDB_E2E_MONGO_URI;
  if (!uri) throw new Error('Indica il MongoDB di prova con CODEDB_E2E_MONGO_URI.');
  const client = new MongoClient(uri);
  const dbName = 'e2e_owner_' + randomUUID().replaceAll('-', '');
  const store = new AppStore({ uri, dbName });
  const db = client.db(dbName);
  const iniziale = { email: 'prima@locale.test', password: 'prima-password' };
  const ruotato = { email: 'dopo@locale.test', password: 'seconda-password' };
  function provider({ email, password }, legacyId = '') {
    return new LocalEntitlementProvider(store, { CODEDB_OWNER_EMAIL: email, CODEDB_OWNER_PASSWORD: password, CODEDB_LOCAL_OWNER_ID: legacyId });
  }
  let propria = false;
  try {
    await client.connect();
    assert.equal((await client.db('admin').admin().listDatabases({ nameOnly: true, filter: { name: dbName } })).databases.length, 0);
    await db.createCollection('fixture');
    propria = true;
    await store.connect();
    const [a, b] = await Promise.all([provider(iniziale).bootstrap(), provider(iniziale).bootstrap()]);
    assert.equal(a._id, b._id);
    await db.collection('users').updateOne({ _id: a._id }, { $unset: { localOwner: '' } });
    const iniz = await provider(iniziale).bootstrap();
    assert.equal(iniz._id, a._id);
    await db.collection('users').updateOne({ _id: a._id }, { $unset: { localOwner: '' } });
    const altro = await store.upsertOwner({ email: 'altro@locale.test', password: 'altra-password', plan: 'self-hosted' });
    const tokenAltro = await store.createSession(altro);
    await assert.rejects(provider(ruotato).bootstrap(), /Più tenant/);
    const sub = await store.createSubUser({ ownerId: iniz.ownerId, email: 'sub@locale.test', password: 'sub-password' });
    const primo = provider(iniziale, iniz.ownerId);
    assert.equal((await primo.bootstrap()).ownerId, iniz.ownerId);
    await assert.rejects(provider({ email: sub.email, password: 'collisione' }).bootstrap(), err => err.code === 11000);
    const token = await store.createSession(iniz);
    const chiave = await store.createApiKey({ ownerId: iniz.ownerId, subjectId: iniz._id });
    await primo.bootstrap();
    assert((await store.resolveSession(token)) && (await store.resolveApiKey(chiave.key)));
    assert.equal(await store.resolveSession(tokenAltro), null);
    const nuovo = provider(ruotato);
    const owner = await nuovo.bootstrap();
    assert.equal(owner.ownerId, iniz.ownerId);
    assert.equal(await nuovo.verifyOwner(iniziale), null);
    assert.equal((await nuovo.verifyOwner(ruotato))._id, iniz._id);
    assert.equal(await store.resolveSession(token), null);
    assert.equal(await store.resolveApiKey(chiave.key), null);
    assert.equal((await store.listSubUsers(owner.ownerId))[0]._id, sub._id);
    // Una richiesta di login già in corso può presentare la vecchia fotografia
    // dell'owner dopo la pulizia del bootstrap.
    assert.equal(await store.resolveSession(await store.createSession(iniz)), null);
    await assert.rejects(provider(ruotato, altro._id).bootstrap(), /diverso/);
    const successivo = provider({ ...ruotato, password: 'terza-password' });
    const recente = await store.createSession(owner);
    await successivo.bootstrap();
    assert.equal(await store.resolveSession(recente), null);
    console.log('OK owner locale: identità legacy, cambio email e password, revoca, riavvio e tenant ambiguo.');
  } finally {
    await store.close();
    try { if (propria) await db.dropDatabase(); } finally { await client.close(); }
  }
}

run().catch(err => { console.error(err); process.exitCode = 1; });

'use strict';

/* ---------------------------------------------------------------------------
 * Control plane: il database applicativo di CodeDB (utenti, ruoli, grant, API
 * key, sessioni). È interno all'applicazione e non ha nulla a che vedere con le
 * connessioni dell'utente: per questo NON è una DbStrategy ma un piccolo
 * repository sul driver MongoDB (già dipendenza del progetto).
 *
 * Vive solo quando CODEDB_RBAC=on. Configurazione:
 *   CODEDB_APP_DB_URI   URI Mongo del control plane (obbligatorio)
 *   CODEDB_APP_DB_NAME  nome del database (default: codedb_control)
 * ------------------------------------------------------------------------- */

const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const { ALL_CAPABILITIES, makePrincipal } = require('./principal');
const {
  SESSION_TTL_MS, hashPassword, verifyPassword, newSessionToken, newApiKey, hashToken,
} = require('./sessions');

// Ruoli predefiniti (ownerId: null = validi per tutti i tenant). `editor` non
// include `delete`: cancellare è una capability distinta, concessa da `admin`
// o da un ruolo custom.
const SEED_ROLES = {
  owner:  ALL_CAPABILITIES.slice(),
  admin:  ALL_CAPABILITIES.slice(),
  editor: ['read', 'write'],
  viewer: ['read'],
};

function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Scope di un grant: null = nessun limite; altrimenti liste di pattern glob.
function normScope(scope) {
  if (!scope || typeof scope !== 'object') return null;
  const list = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
  const databases = list(scope.databases);
  const collections = list(scope.collections);
  if (!databases.length && !collections.length) return null;
  return { databases, collections };
}

class AppStore {
  constructor({ uri, dbName } = {}) {
    this.uri = uri || process.env.CODEDB_APP_DB_URI || '';
    this.dbName = dbName || process.env.CODEDB_APP_DB_NAME || 'codedb_control';
    this.client = null;
    this.db = null;
  }

  async connect() {
    if (!this.uri) {
      throw new Error('CODEDB_RBAC=on richiede CODEDB_APP_DB_URI: l\'URI del MongoDB che ospita il control plane (utenti, ruoli, permessi).');
    }
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 8000 });
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    await this.ensureIndexes();
    await this.seedRoles();
    return this;
  }

  async close() {
    if (this.client) await this.client.close().catch(() => {});
    this.client = null;
    this.db = null;
  }

  col(name) {
    if (!this.db) throw new Error('Control plane non inizializzato.');
    return this.db.collection(name);
  }

  async ensureIndexes() {
    await this.col('users').createIndex({ ownerId: 1, email: 1 }, { unique: true });
    await this.col('roles').createIndex({ ownerId: 1, name: 1 }, { unique: true });
    await this.col('grants').createIndex({ subjectId: 1, connName: 1 }, { unique: true });
    await this.col('grants').createIndex({ ownerId: 1 });
    await this.col('api_keys').createIndex({ hashedKey: 1 }, { unique: true });
    await this.col('api_keys').createIndex({ ownerId: 1 });
    await this.col('sessions').createIndex({ tokenHash: 1 }, { unique: true });
    // Pulizia automatica delle sessioni scadute a carico di MongoDB.
    await this.col('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  async seedRoles() {
    for (const [name, capabilities] of Object.entries(SEED_ROLES)) {
      await this.col('roles').updateOne(
        { ownerId: null, name },
        { $setOnInsert: { _id: crypto.randomUUID(), ownerId: null, name, capabilities, builtIn: true } },
        { upsert: true },
      );
    }
  }

  /* --- Utenti --------------------------------------------------------------- */

  findUserById(id) {
    return this.col('users').findOne({ _id: String(id) });
  }

  findOwnerByEmail(email) {
    return this.col('users').findOne({ type: 'owner', email: normEmail(email) });
  }

  findUserByEmail(email, ownerId = null) {
    const q = { email: normEmail(email) };
    if (ownerId) q.ownerId = String(ownerId);
    return this.col('users').findOne(q);
  }

  listSubUsers(ownerId) {
    return this.col('users')
      .find({ ownerId: String(ownerId), type: 'subuser' })
      .project({ passwordHash: 0 })
      .toArray();
  }

  countSubUsers(ownerId) {
    return this.col('users').countDocuments({ ownerId: String(ownerId), type: 'subuser' });
  }

  /** Crea (o aggiorna) l'owner del tenant. Idempotente: usato al bootstrap. */
  async upsertOwner({ email, password, displayName, externalId = null, plan = null }) {
    const mail = normEmail(email);
    const existing = await this.findOwnerByEmail(mail);
    if (existing) {
      const patch = { externalId, plan, status: 'active' };
      // La password dell'owner resta quella del provider di identità: la si
      // riallinea solo se ne arriva una nuova (es. env cambiata).
      if (password) patch.passwordHash = hashPassword(password);
      await this.col('users').updateOne({ _id: existing._id }, { $set: patch });
      return this.findUserById(existing._id);
    }
    const id = crypto.randomUUID();
    const doc = {
      _id: id,
      type: 'owner',
      ownerId: id, // l'owner è il proprio tenant
      email: mail,
      displayName: displayName || mail,
      passwordHash: password ? hashPassword(password) : null,
      externalId,
      plan,
      status: 'active',
      createdAt: new Date(),
    };
    await this.col('users').insertOne(doc);
    return doc;
  }

  async createSubUser({ ownerId, email, password, displayName }) {
    const mail = normEmail(email);
    if (!mail) throw new Error('Email del sottoutente mancante.');
    if (!password || String(password).length < 8) {
      throw new Error('La password del sottoutente deve essere di almeno 8 caratteri.');
    }
    if (await this.findUserByEmail(mail, ownerId)) {
      throw new Error(`Esiste già un utente con l'email "${mail}".`);
    }
    const doc = {
      _id: crypto.randomUUID(),
      type: 'subuser',
      ownerId: String(ownerId),
      email: mail,
      displayName: displayName || mail,
      passwordHash: hashPassword(password),
      externalId: null,
      plan: null,
      status: 'active',
      createdAt: new Date(),
    };
    await this.col('users').insertOne(doc);
    const { passwordHash, ...safe } = doc;
    return safe;
  }

  async updateSubUser(ownerId, subjectId, { status, displayName, password }) {
    const patch = {};
    if (status) {
      if (!['active', 'suspended'].includes(status)) throw new Error('Stato non valido: usa "active" o "suspended".');
      patch.status = status;
    }
    if (displayName != null) patch.displayName = String(displayName);
    if (password) {
      if (String(password).length < 8) throw new Error('La password deve essere di almeno 8 caratteri.');
      patch.passwordHash = hashPassword(password);
    }
    if (!Object.keys(patch).length) return { updated: 0 };
    const res = await this.col('users').updateOne(
      { _id: String(subjectId), ownerId: String(ownerId), type: 'subuser' }, { $set: patch },
    );
    if (!res.matchedCount) throw new Error('Sottoutente non trovato.');
    // Sospensione: le sessioni e le API key attive vanno chiuse subito.
    if (patch.status === 'suspended' || patch.passwordHash) await this.deleteSessionsForUser(subjectId);
    return { updated: res.modifiedCount };
  }

  async deleteSubUser(ownerId, subjectId) {
    const res = await this.col('users').deleteOne({ _id: String(subjectId), ownerId: String(ownerId), type: 'subuser' });
    if (!res.deletedCount) throw new Error('Sottoutente non trovato.');
    await this.col('grants').deleteMany({ subjectId: String(subjectId) });
    await this.col('api_keys').deleteMany({ subjectId: String(subjectId) });
    await this.deleteSessionsForUser(subjectId);
    return { deleted: 1 };
  }

  /* --- Ruoli ---------------------------------------------------------------- */

  async listRoles(ownerId) {
    return this.col('roles').find({ $or: [{ ownerId: null }, { ownerId: String(ownerId) }] }).toArray();
  }

  /** Capability di un ruolo: il ruolo custom del tenant vince su quello globale. */
  async roleCapabilities(ownerId, name) {
    const own = await this.col('roles').findOne({ ownerId: String(ownerId), name: String(name) });
    if (own) return own.capabilities || [];
    const global = await this.col('roles').findOne({ ownerId: null, name: String(name) });
    return global ? global.capabilities || [] : null;
  }

  /* --- Grant ---------------------------------------------------------------- */

  listGrants(ownerId) {
    return this.col('grants').find({ ownerId: String(ownerId) }).toArray();
  }

  async setGrant({ ownerId, subjectId, connName, role, scope }) {
    const subject = await this.col('users').findOne({ _id: String(subjectId), ownerId: String(ownerId) });
    if (!subject) throw new Error('Sottoutente non trovato.');
    const capabilities = await this.roleCapabilities(ownerId, role);
    if (!capabilities) throw new Error(`Ruolo "${role}" inesistente.`);
    const conn = String(connName || '').trim();
    if (!conn) throw new Error('Nome della connessione mancante.');
    const doc = { ownerId: String(ownerId), subjectId: String(subjectId), connName: conn, role: String(role), scope: normScope(scope) };
    await this.col('grants').updateOne(
      { subjectId: doc.subjectId, connName: doc.connName },
      { $set: doc, $setOnInsert: { _id: crypto.randomUUID(), createdAt: new Date() } },
      { upsert: true },
    );
    return doc;
  }

  async revokeGrant(ownerId, subjectId, connName) {
    const res = await this.col('grants').deleteOne({
      ownerId: String(ownerId), subjectId: String(subjectId), connName: String(connName),
    });
    return { deleted: res.deletedCount };
  }

  /** Grant di un soggetto, già denormalizzati con le capability del ruolo. */
  async grantsForSubject(ownerId, subjectId) {
    const grants = await this.col('grants').find({ subjectId: String(subjectId) }).toArray();
    if (!grants.length) return [];
    const roles = await this.listRoles(ownerId);
    // Il ruolo custom del tenant ha la precedenza su quello globale omonimo.
    const byName = new Map();
    for (const r of roles) if (r.ownerId === null) byName.set(r.name, r.capabilities || []);
    for (const r of roles) if (r.ownerId !== null) byName.set(r.name, r.capabilities || []);
    return grants.map((g) => ({
      connName: g.connName,
      role: g.role,
      scope: g.scope || null,
      capabilities: byName.get(g.role) || [],
    }));
  }

  /* --- API key -------------------------------------------------------------- */

  listApiKeys(ownerId) {
    return this.col('api_keys')
      .find({ ownerId: String(ownerId), revokedAt: null })
      .project({ hashedKey: 0 })
      .toArray();
  }

  async createApiKey({ ownerId, subjectId, label, connScope }) {
    const subject = await this.col('users').findOne({ _id: String(subjectId), ownerId: String(ownerId) });
    if (!subject) throw new Error('Utente non trovato in questo account.');
    const { raw, prefix } = newApiKey();
    const doc = {
      _id: crypto.randomUUID(),
      ownerId: String(ownerId),
      subjectId: String(subjectId),
      hashedKey: hashToken(raw),
      prefix,
      connScope: Array.isArray(connScope) && connScope.length ? connScope.map(String) : null,
      label: String(label || '').trim() || 'API key',
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
    };
    await this.col('api_keys').insertOne(doc);
    const { hashedKey, ...safe } = doc;
    // `key` è l'unico momento in cui la chiave in chiaro esiste fuori dal client.
    return { ...safe, key: raw };
  }

  async revokeApiKey(ownerId, keyId) {
    const res = await this.col('api_keys').updateOne(
      { _id: String(keyId), ownerId: String(ownerId) }, { $set: { revokedAt: new Date() } },
    );
    if (!res.matchedCount) throw new Error('API key non trovata.');
    return { revoked: 1 };
  }

  /** Risolve una API key in chiaro nel principal corrispondente (o null). */
  async resolveApiKey(rawKey) {
    if (!rawKey) return null;
    const doc = await this.col('api_keys').findOne({ hashedKey: hashToken(rawKey), revokedAt: null });
    if (!doc) return null;
    const user = await this.findUserById(doc.subjectId);
    if (!user || user.status !== 'active') return null;
    // Aggiornamento best-effort: non deve mai far fallire la richiesta.
    this.col('api_keys').updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
    return this.principalFor(user, doc.connScope);
  }

  /* --- Sessioni UI ---------------------------------------------------------- */

  async createSession(user) {
    const token = newSessionToken();
    await this.col('sessions').insertOne({
      _id: crypto.randomUUID(),
      tokenHash: hashToken(token),
      userId: String(user._id),
      ownerId: String(user.ownerId),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      lastSeenAt: new Date(),
    });
    return token;
  }

  async resolveSession(token) {
    if (!token) return null;
    const sess = await this.col('sessions').findOne({ tokenHash: hashToken(token) });
    // L'indice TTL passa ogni minuto: la scadenza va verificata anche a mano.
    if (!sess || sess.expiresAt <= new Date()) return null;
    const user = await this.findUserById(sess.userId);
    if (!user || user.status !== 'active') return null;
    this.col('sessions').updateOne({ _id: sess._id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
    return this.principalFor(user, null);
  }

  async deleteSession(token) {
    if (!token) return { deleted: 0 };
    const res = await this.col('sessions').deleteOne({ tokenHash: hashToken(token) });
    return { deleted: res.deletedCount };
  }

  async deleteSessionsForUser(userId) {
    const res = await this.col('sessions').deleteMany({ userId: String(userId) });
    return { deleted: res.deletedCount };
  }

  /* --- Autenticazione ------------------------------------------------------- */

  /**
   * Verifica le credenziali di un sottoutente (l'owner passa dal provider).
   *
   * L'unicità delle email è per tenant (indice `{ownerId, email}`): due owner
   * diversi POSSONO avere un sottoutente con la stessa email, ed è corretto che
   * sia così in un SaaS. Cercare con un `findOne` senza ownerId però ne
   * selezionava uno arbitrario: se le password erano diverse, l'utente legittimo
   * dell'altro tenant si vedeva rifiutare credenziali giuste, senza alcun errore
   * lato server e senza modo di indicare il proprio tenant dall'interfaccia.
   *
   * Si verificano quindi TUTTI gli omonimi. Se più di uno accetta la stessa
   * password l'accesso viene rifiutato in modo esplicito invece di scegliere a
   * caso: è un caso raro, e sceglierne uno significherebbe far entrare qualcuno
   * nel tenant sbagliato.
   */
  async verifySubUser(email, password) {
    const candidates = await this.col('users')
      .find({ email: normEmail(email), type: 'subuser' })
      .toArray();

    const matches = [];
    for (const user of candidates) {
      // Il confronto (scrypt + timingSafeEqual) gira su ogni candidato attivo,
      // così il tempo di risposta non rivela quale record ha corrisposto.
      if (user.status !== 'active') continue;
      if (verifyPassword(password, user.passwordHash)) matches.push(user);
    }

    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const err = new Error(
        'Questa email esiste su più account con la stessa password: contatta l\'amministratore per distinguerli.'
      );
      err.ambiguousLogin = true;
      throw err;
    }
    return null;
  }

  /** Costruisce il principal completo (grant denormalizzati) per un utente. */
  async principalFor(user, connScope = null) {
    const grants = user.type === 'owner' ? [] : await this.grantsForSubject(user.ownerId, user._id);
    return makePrincipal(user, grants, connScope);
  }
}

module.exports = { AppStore, SEED_ROLES, normScope, normEmail };

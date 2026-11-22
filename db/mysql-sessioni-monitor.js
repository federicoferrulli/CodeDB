'use strict';

const sessioni = require('./sessioni');
const { definisciMetodi } = require('./prototipoStrategia');

function installaSessioniMysql(prototipo) {
  definisciMetodi(prototipo, {
    async listSessions() {
      const pool = this.requirePool();
      const conn = await pool.getConnection();
      try {
        const [rows] = await conn.query(
          `SELECT p.ID, p.USER, p.HOST, p.DB, p.COMMAND, p.TIME, p.STATE, p.INFO,
                  t.THREAD_ID AS STABLE_ID
             FROM information_schema.PROCESSLIST p
             LEFT JOIN performance_schema.threads t ON t.PROCESSLIST_ID = p.ID
            ORDER BY (p.COMMAND <> 'Sleep') DESC, p.TIME DESC
            LIMIT ${sessioni.MAX_SESSIONI + 1}`
        );

        if (this._notaPrivilegi === undefined) {
          this._notaPrivilegi = null;
          try {
            const [grants] = await conn.query('SHOW GRANTS FOR CURRENT_USER()');
            const testo = grants.map((r) => Object.values(r)[0]).join('\n');
            if (!/\b(PROCESS|ALL PRIVILEGES)\b/i.test(testo)) {
              this._notaPrivilegi = 'Vengono mostrate solo le sessioni dell\'utente collegato: manca il privilegio PROCESS, necessario per vedere quelle degli altri utenti.';
            }
          } catch { /* SHOW GRANTS negato: si preferisce nessuna nota a una sbagliata */ }
        }
        const nota = this._notaPrivilegi;

        const { coppie, saBloccanti, transazioni } = await this.attesePerLock(conn);
        const troncato = rows.length > sessioni.MAX_SESSIONI;
        const lista = sessioni.ordina(sessioni.collegaBlocchi(
          sessioni.normalizzaMysql(rows.slice(0, sessioni.MAX_SESSIONI), {
            threadIds: this.threadIdsDelPool(),
            transazioni,
          }),
          coppie
        ));
        return {
          sessioni: lista,
          capacita: { annullaQuery: true, terminaConnessione: true, saBloccanti },
          troncato,
          nota,
        };
      } finally {
        conn.release();
      }
    },

    async attesePerLock(conn) {
      const query = (sql) => conn.query(sql).then(([r]) => r);
      const mappa = (rows) => rows
        .filter((r) => r.attesa != null && r.blocca != null)
        .map((r) => ({ attesa: String(r.attesa), blocca: String(r.blocca) }));

      let transazioni = [];
      try {
        transazioni = (await query('SELECT trx_mysql_thread_id AS id FROM information_schema.innodb_trx'))
          .map((r) => r.id).filter((v) => v != null);
      } catch { /* privilegi mancanti: si rinuncia al dettaglio, non al pannello */ }

      try {
        return {
          transazioni,
          coppie: mappa(await query(
            `SELECT r.trx_mysql_thread_id AS attesa, b.trx_mysql_thread_id AS blocca
               FROM performance_schema.data_lock_waits w
               JOIN information_schema.innodb_trx r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
               JOIN information_schema.innodb_trx b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID`
          )),
          saBloccanti: true,
        };
      } catch (_e8) {
        try {
          return {
            transazioni,
            coppie: mappa(await query(
              `SELECT r.trx_mysql_thread_id AS attesa, b.trx_mysql_thread_id AS blocca
                 FROM information_schema.innodb_lock_waits w
                 JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_trx_id
                 JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_trx_id`
            )),
            saBloccanti: true,
          };
        } catch (_e57) {
          return { transazioni, coppie: [], saBloccanti: false };
        }
      }
    },

    threadIdsDelPool() {
      const ids = [];
      try {
        const raw = (this.pool && this.pool.pool) || this.pool;
        const all = raw && raw._allConnections;
        const arr = !all ? [] : (typeof all.toArray === 'function' ? all.toArray() : Array.from(all));
        for (const c of arr) {
          const id = c && (c.threadId != null ? c.threadId : (c.connection && c.connection.threadId));
          if (id != null) ids.push(id);
        }
      } catch { /* internals non disponibili */ }
      return ids;
    },

    async killSession(id, modo, identitaOsservata) {
      const pool = this.requirePool();
      const num = Number(String(id).trim());
      if (!Number.isInteger(num) || num <= 0) throw new Error(`Id di sessione non valido: "${id}".`);
      const conn = await pool.getConnection();
      try {
        const [correnti] = await conn.query(
          'SELECT THREAD_ID AS STABLE_ID FROM performance_schema.threads WHERE PROCESSLIST_ID = ?',
          [num]
        );
        const corrente = correnti[0] && `mysql-thread:${correnti[0].STABLE_ID}`;
        sessioni.assertIdentitaSessione(identitaOsservata, corrente);
        await conn.query(modo === 'connessione' ? `KILL CONNECTION ${num}` : `KILL QUERY ${num}`);
        return { terminata: true, modo: modo === 'connessione' ? 'connessione' : 'query' };
      } finally {
        conn.release();
      }
    },

    async cancelQuery(opHandle) {
      if (!opHandle || !opHandle.connectionId || !this.pool) return { cancelled: false };
      return { cancelled: await this.uccidiSulServer(opHandle.connectionId) };
    },
  });
}

module.exports = { installaSessioniMysql };

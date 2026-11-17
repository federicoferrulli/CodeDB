'use strict';

const sessioni = require('./sessioni');
const { definisciMetodi } = require('./prototipoStrategia');

/**
 * Monitor delle sessioni e dei lock PostgreSQL (`pg_stat_activity` +
 * `pg_blocking_pids`), introspezione difensiva dei backend del pool locale,
 * terminazione verificata per identità (`pid` + `backend_start`) e
 * annullamento delle query in corso (`pg_cancel_backend`).
 */
function installaSessioniPg(prototipo) {
  return definisciMetodi(prototipo, {
    async listSessions() {
      const pool = this.requirePool();
      const { rows } = await pool.query(
        `SELECT pid,
                usename,
                client_addr::text AS client_addr,
                client_port,
                datname,
                state,
                query,
                wait_event_type,
                wait_event,
                backend_type,
                application_name,
                -- Il driver converte timestamptz in Date perdendo i microsecondi:
                -- l'identità confrontata prima del kill deve restare esatta.
                backend_start::text AS backend_start,
                -- Si chiama SOLO sulle righe che stanno davvero aspettando un
                -- lock pesante (wait_event_type = 'Lock'), evitando prese
                -- inutili sullo stato condiviso del lock manager.
                CASE WHEN wait_event_type = 'Lock' THEN pg_blocking_pids(pid) END AS blocking,
                EXTRACT(EPOCH FROM (now() - COALESCE(
                  CASE WHEN state = 'active' THEN query_start ELSE state_change END,
                  backend_start))) AS secondi
           FROM pg_stat_activity
          ORDER BY secondi DESC NULLS LAST
          LIMIT $1`,
        [sessioni.MAX_SESSIONI + 1]
      );

      const nascoste = rows.some((r) => String(r.query || '').includes('insufficient privilege'));
      const nota = nascoste
        ? 'Il testo delle query degli altri utenti non è visibile: serve il ruolo "pg_monitor" (o "pg_read_all_stats") sull\'utente della connessione.'
        : null;

      const troncato = rows.length > sessioni.MAX_SESSIONI;
      const usate = rows.slice(0, sessioni.MAX_SESSIONI);
      const coppie = [];
      for (const r of usate) {
        for (const b of (Array.isArray(r.blocking) ? r.blocking : [])) coppie.push({ attesa: r.pid, blocca: b });
      }
      const lista = sessioni.ordina(sessioni.collegaBlocchi(
        sessioni.normalizzaPostgres(usate, { processIDs: this.processIDsDelPool() }),
        coppie
      ));
      return {
        sessioni: lista,
        capacita: { annullaQuery: true, terminaConnessione: true, saBloccanti: true },
        troncato,
        nota,
      };
    },

    processIDsDelPool() {
      const ids = [];
      try {
        for (const c of (this.pool && this.pool._clients) || []) {
          if (c && c.processID != null) ids.push(c.processID);
        }
      } catch { /* internals non disponibili */ }
      return ids;
    },

    async killSession(id, modo, identitaOsservata) {
      const pool = this.requirePool();
      const pid = Number(String(id).trim());
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Id di sessione non valido: "${id}".`);
      const fn = modo === 'connessione' ? 'pg_terminate_backend' : 'pg_cancel_backend';
      const prefisso = 'postgres-backend:';
      if (!String(identitaOsservata || '').startsWith(prefisso)) {
        sessioni.assertIdentitaSessione(identitaOsservata, null);
      }
      const backendStart = String(identitaOsservata).slice(prefisso.length);
      const res = await pool.query(
        `SELECT ${fn}(pid) AS esito
           FROM pg_stat_activity
          WHERE pid = $1 AND backend_start = $2::timestamptz`,
        [pid, backendStart]
      );
      if (!res.rows || !res.rows.length) sessioni.assertIdentitaSessione(identitaOsservata, null);
      const esito = !!(res.rows && res.rows[0] && res.rows[0].esito);
      return { terminata: esito, modo: modo === 'connessione' ? 'connessione' : 'query' };
    },

    async cancelQuery(opHandle) {
      if (!opHandle || !opHandle.processID || !this.pool) return { cancelled: false };
      const client = await this.pool.connect();
      try {
        const res = await client.query('SELECT pg_cancel_backend($1) AS cancelled', [opHandle.processID]);
        const cancelled = !!(res.rows && res.rows[0] && res.rows[0].cancelled);
        return { cancelled };
      } catch (_err) {
        return { cancelled: false };
      } finally {
        client.release();
      }
    },
  });
}

module.exports = { installaSessioniPg };

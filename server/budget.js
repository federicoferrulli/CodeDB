'use strict';

// CodeDB — budget. Stato e dipendenze appartengono alla singola istanza.

function createModule() {
  /* ---------------------------------------------------------------------------
   * Socket handling — una sessione (strategia + eventuale tunnel) per ogni tab
   * aperto nel browser; il tabId viaggia in ogni payload. Client storici senza
   * tabId ricadono sulla sessione "default" (stesso comportamento di prima).
   * ------------------------------------------------------------------------- */

  // Limiti di sicurezza e prevenzione esaurimento risorse
  const MAX_SESSIONS_PER_SOCKET = 8;

  const MAX_GLOBAL_SESSIONS = 100;

  const MAX_GLOBAL_SOCKETS = 500;

  const MAX_SOCKETS_PER_IP = 20;

  let activeGlobalSessions = 0;

  const ipConnections = new Map();

  return {
    MAX_SESSIONS_PER_SOCKET,
    MAX_GLOBAL_SESSIONS,
    MAX_GLOBAL_SOCKETS,
    MAX_SOCKETS_PER_IP,
    get activeGlobalSessions() { return activeGlobalSessions; },
    tryAcquireGlobalSession() {
      if (activeGlobalSessions >= MAX_GLOBAL_SESSIONS) return false;
      activeGlobalSessions++;
      return true;
    },
    releaseGlobalSession() {
      if (activeGlobalSessions <= 0) throw new Error('Rilascio di una quota sessione non acquisita.');
      activeGlobalSessions--;
    },
    ipConnections
  };
}

module.exports = { createModule };

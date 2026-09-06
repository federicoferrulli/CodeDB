'use strict';

// CodeDB — mcp. Stato e dipendenze appartengono alla singola istanza.
const { attachMcp } = require('../mcp/McpGateway');
const { allowedConnections } = require('../auth/permissions');

function createModule({ trasporto, vault, connessioni, config, identita, budget }) {
  /* ---------------------------------------------------------------------------
   * Gateway MCP: espone i tools di sola lettura per i client AI sull'endpoint
   * /mcp (Streamable HTTP). Riusa le connessioni salvate e il ciclo di vita
   * delle sessioni di questo file; il budget globale è condiviso coi socket.
   * ------------------------------------------------------------------------- */

  const mcpControl = attachMcp(trasporto.app, {
    env: config.env,
    loadConnections: vault.loadConnections,
    connLabel: vault.connLabel,
    connDbType: vault.connDbType,
    // Unica scrittura su connections.ini concessa al gateway MCP: il flag
    // readOnly di una connessione salvata (mai gli altri campi, mai i segreti).
    // La conferma umana a due passaggi è responsabilità del gateway.
    setConnectionReadOnly: (name, readOnly, ownerId) => {
      const sections = vault.loadConnections(ownerId);
      const key = String(name || '').trim();
      if (!sections[key]) throw new Error(`Connessione salvata "${key}" inesistente.`);
      sections[key].readOnly = readOnly ? 'true' : 'false';
      vault.saveConnections(sections, ownerId);
    },
    establishConnection: connessioni.establishConnection,
    teardownConnection: connessioni.teardownConnection,
    // Autenticazione dei client MCP: con RBAC acceso ogni richiesta deve portare
    // una API key valida (Authorization: Bearer …), che risolve nel principal i
    // cui grant limitano poi connessioni, database e operazioni.
    rbacOn: config.rbacOn,
    resolveApiKey: identita.resolvePrincipalFromApiKey,
    allowedConnections,
    maxDbSessions: budget.MAX_SESSIONS_PER_SOCKET,
    tryAcquireGlobalSession: budget.tryAcquireGlobalSession,
    releaseGlobalSession: budget.releaseGlobalSession,
  });

  return {
    mcpControl
  };
}

module.exports = { createModule };

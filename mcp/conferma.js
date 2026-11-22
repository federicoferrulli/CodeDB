'use strict';

/* ---------------------------------------------------------------------------
 * Flusso di conferma esplicita a due passaggi (human-in-the-loop) per MCP.
 *
 * Primo passo (`issue`): valida l'operazione, prenota la quota in ConfirmQuota,
 * registra un token monouso con scadenza e restituisce l'anteprima da mostrare
 * all'utente umano.
 * Secondo passo (`consume`): verifica kind, corrispondenza e scadenza, consuma
 * il token in modo monouso e rilascia la prenotazione di quota.
 * ------------------------------------------------------------------------- */

const crypto = require('crypto');
const { DEFAULTS: MCP_DEFAULTS } = require('./Settings');
const { jsonResult } = require('./guardie');

function creaFlussoConferma({ session, deps, sessionPrincipal }) {
  function sweep() {
    const now = Date.now();
    for (const [token, p] of session.pendingWrites) {
      if (p.expiresAt <= now) {
        session.pendingWrites.delete(token);
        if (p.expiryTimer) clearTimeout(p.expiryTimer);
        deps.confirmQuota.release(p.reservation);
        deps.activity?.expire(p);
      }
    }
  }

  function consume(token, kind, matches, mismatchNoun) {
    const pending = session.pendingWrites.get(token);
    if (!pending || pending.expiresAt <= Date.now() || pending.kind !== kind || !matches(pending)) {
      throw new Error(`confirm_token sconosciuto, scaduto o di un'altra ${mismatchNoun}: ripeti la richiesta senza token.`);
    }
    session.pendingWrites.delete(token); // monouso
    if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
    deps.confirmQuota.release(pending.reservation);
    deps.activity?.consume(pending);
    return pending;
  }

  function issue(kind, data, { toolName, preview, extra, quotaPayload }) {
    const principal = sessionPrincipal(session);
    const reservation = deps.confirmQuota.reserve(
      `${principal.ownerId}:${principal.id}`,
      { kind, data, preview, quotaPayload },
    );
    const confirmToken = crypto.randomUUID();
    const ttl = (deps.mcpSettings?.get().confirmTimeoutSeconds || MCP_DEFAULTS.confirmTimeoutSeconds) * 1000;
    const pending = {
      kind, ...data, reservation, expiresAt: Date.now() + ttl,
    };
    deps.activity?.pending(pending);
    pending.expiryTimer = setTimeout(() => {
      if (session.pendingWrites.get(confirmToken) !== pending) return;
      session.pendingWrites.delete(confirmToken);
      deps.confirmQuota.release(reservation);
      deps.activity?.expire(pending);
    }, ttl);
    pending.expiryTimer.unref?.();
    session.pendingWrites.set(confirmToken, pending);
    return jsonResult({
      requires_confirmation: true,
      confirm_token: confirmToken,
      expires_in_seconds: ttl / 1000,
      preview,
      ...(extra || {}),
      istruzioni: `Mostra l'anteprima all'utente umano e chiedi conferma esplicita. Solo se l'utente approva, richiama ${toolName} con questo confirm_token. Se l'utente rifiuta, non richiamare il tool.`,
    });
  }

  return { sweep, consume, issue };
}

module.exports = { creaFlussoConferma };

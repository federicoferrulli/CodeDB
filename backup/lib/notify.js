'use strict';

/* ---------------------------------------------------------------------------
 * Notifica Slack (incoming webhook) al termine delle operazioni. Un errore
 * di notifica non deve mai far fallire il backup: viene solo loggato.
 * ------------------------------------------------------------------------- */

async function notifySlack(webhookUrl, text, log) {
  if (!webhookUrl) return;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (log) log.info('Notifica Slack inviata.');
  } catch (err) {
    if (log) log.error(`Invio notifica Slack fallito: ${(err && err.message) || err}`);
  }
}

module.exports = { notifySlack };

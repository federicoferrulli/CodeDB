'use strict';

/* ---------------------------------------------------------------------------
 * CodeDB — Redazione dei segreti dai testi che escono dal processo.
 *
 * Il messaggio di un driver NON è un testo neutro. Di fronte a una stringa di
 * connessione malformata o non risolvibile, il driver MongoDB riporta
 * comunemente l'URI nel messaggio — e una connessione salvata in modalità URI
 * contiene `mongodb://utente:password@host`. Lo stesso vale per un errore di
 * `ssh2` che cita il percorso della chiave privata.
 *
 * Quel messaggio finiva tale e quale in due posti che non lo trattengono:
 * la notifica Slack (un servizio ESTERNO, con la password nel corpo della
 * richiesta) e `backup.log`, che resta sul disco insieme ai backup e viene
 * copiato con essi.
 *
 * La redazione è volutamente grossolana e conservativa: meglio oscurare
 * qualcosa che non era un segreto che lasciarne passare uno.
 * ------------------------------------------------------------------------- */

// utente:password dentro un URI di qualunque schema (mongodb://, postgres://,
// mysql://, ssh://…). Si conserva lo schema e l'host: senza, il messaggio
// smette di dire DOVE è fallita la connessione, che è la sua unica utilità.
const URI_CREDENZIALI = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]*)@/g;

// Percorsi di chiavi private: il nome del file non è un segreto, la sua
// posizione sul disco di chi esegue i backup un po' sì.
const CHIAVE_PRIVATA = /((?:^|[\s'"(])(?:[A-Za-z]:)?[\\/][^\s'")]*?)(id_(?:rsa|ed25519|ecdsa|dsa)[^\s'")]*)/g;

/**
 * Oscura i segreti in un testo destinato a uscire dal processo.
 *
 * @param {string} testo
 * @param {string[]} [extra] valori letterali da oscurare comunque (le password
 *   della connessione in uso, che si conoscono e che nessun regex indovinerebbe).
 */
function redigi(testo, extra = []) {
  let out = String(testo == null ? '' : testo);

  // I valori noti per primi: potrebbero contenere caratteri che alterano
  // l'interpretazione dei regex successivi.
  for (const v of extra) {
    if (!v || typeof v !== 'string' || v.length < 3) continue;
    out = out.split(v).join('***');
  }

  out = out.replace(URI_CREDENZIALI, (_m, schema, utente) => `${schema}${utente}:***@`);
  out = out.replace(CHIAVE_PRIVATA, (_m, prefisso, nome) => `${prefisso.slice(0, 1)}…/${nome}`);
  return out;
}

module.exports = { redigi };

'use strict';

// CodeDB — eventi-vault. Stato e dipendenze appartengono alla singola istanza.
const Vault = require('../db/vault');
const { allowedConnections, canUseConnection, isInstallAdmin } = require('../auth/permissions');
const crypto = require('crypto');

function createModule({ vault, identita, config }) {
  function registra(socketContext, lifecycle) {
    // --- Vault & Password ------------------------------------------------------

    lifecycle.amministrativo('vault:status', (_payload, cb) => {
      cb({
        ok: true,
        ...vault.stato(socketContext.principal && socketContext.principal.ownerId),
        // Chi non amministra l'installazione non può cambiare la passphrase né
        // azzerare il vault (CDB-A02): la UI nasconde i comandi invece di
        // offrirli e farli fallire con un permesso negato.
        amministrabile: isInstallAdmin(socketContext.principal, config.env),
      });
    });

    lifecycle.amministrativo('vault:unlock', ({ passphrase }, cb) => {
      // Sbloccare il vault significa provare una passphrase globale dell'istanza:
      // riservato all'amministratore dell'account.
      identita.assertManage(socketContext.principal);

      // Stesso freno del login (CDB-66): ogni tentativo costa uno scrypt da ~28 ms
      // durante i quali l'event loop è fermo per tutte le sessioni, e senza limite
      // questo è insieme un oracolo per la passphrase e un modo per bloccare il
      // server. La chiave è l'indirizzo del client, come per /auth/login.
      const ipClient = socketContext.socket.handshake.address || 'unknown';
      if (identita.loginBlocked(ipClient)) {
        throw new Error('Troppi tentativi di sblocco falliti: riprova tra un minuto.');
      }

      const esito = vault.tryUnlockVault(passphrase || '');
      if (!esito.ok) identita.noteLoginFailure(ipClient);
      else identita.loginAttempts.delete(ipClient);
      cb(esito);
    });

    /**
     * Ricomincia da capo dopo una passphrase dimenticata: connessioni salvate
     * messe da parte e vault nuovo con la passphrase indicata.
     *
     * È l'unico modo di uscire da un vault bloccato senza conoscere la
     * passphrase, quindi non chiede (e non può chiedere) alcun segreto: la
     * barriera è l'accesso stesso all'applicazione — con RBAC spento chi apre la
     * UI è già l'amministratore della macchina, con RBAC acceso serve
     * l'amministratore dell'INSTALLAZIONE (`assertInstallAdmin`). Cosa distrugge
     * va detto senza giri di parole, ed è per questo che il client deve
     * dichiararlo esplicitamente con `confirm: true`.
     */
    lifecycle.amministrativo('vault:reset', ({ passphrase, confirm } = {}, cb) => {
      // Non `manage`: resetVault sposta il connections.ini condiviso E quelli di
      // OGNI owner, poi genera una DEK nuova — i segreti degli altri tenant
      // restano cifrati con una chiave che nessuno possiede più (CDB-A02).
      identita.assertInstallAdmin(socketContext.principal, 'azzerare il vault');

      if (confirm !== true) {
        throw new Error('Conferma mancante: l\'operazione elimina le connessioni salvate.');
      }
      if (typeof passphrase !== 'string') {
        throw new Error('Passphrase non valida.');
      }

      const res = vault.resetVault(passphrase);
      if (!res.ok) throw new Error(res.error);

      cb({
        ok: true,
        spostati: res.spostati,
        avviso: res.spostati.length
          ? `Le connessioni precedenti non sono state cancellate: i file sono accanto a connections.ini con suffisso .${res.suffisso} (restano illeggibili senza la vecchia passphrase). Da ora il server va avviato con la nuova passphrase (GUI_MONGO_PASSPHRASE) oppure sbloccato dall'interfaccia.`
          : 'Vault ricreato. Da ora il server va avviato con la nuova passphrase (GUI_MONGO_PASSPHRASE) oppure sbloccato dall\'interfaccia.',
      });
    });

    /**
     * Cambia (o imposta) la passphrase del vault.
     *
     * Il vault è unico per installazione, quindi l'operazione tocca TUTTI i
     * tenant: è riservata a chi amministra l'INSTALLAZIONE, non a chi ha `manage`
     * — che è ogni owner sul proprio account (CDB-A02). Si pretende inoltre la
     * passphrase attuale anche a vault già sbloccato: chi si siede a una sessione
     * lasciata aperta non deve poter cambiare la chiave dei segreti altrui.
     */
    lifecycle.amministrativo('vault:setPassphrase', ({ current, next } = {}, cb) => {
      identita.assertInstallAdmin(socketContext.principal, 'cambiare la passphrase del vault');

      if (vault.stato().locked) {
        throw new Error('Vault bloccato: sbloccalo con la passphrase attuale prima di cambiarla.');
      }
      if (typeof next !== 'string' || next.length < 1) {
        throw new Error('La nuova passphrase non può essere vuota.');
      }

      // Verifica della passphrase attuale, senza toccare lo stato del vault.
      const attuale = String(current == null ? '' : current);
      const valida = vault.verificaPassphrase(attuale);
      if (!valida) {
        throw new Error('La passphrase attuale non è corretta.');
      }

      const res = vault.changeVaultPassphrase(next);
      if (!res.ok) throw new Error(res.error);

      cb({
        ok: true,
        migrated: !!res.migrated,
        // La nuova passphrase vale da SUBITO in memoria, ma i prossimi avvii la
        // pretendono: senza dirlo, un riavvio troverebbe il vault bloccato e
        // sembrerebbe un guasto.
        avviso: 'Da ora il server va avviato con la nuova passphrase (GUI_MONGO_PASSPHRASE) oppure sbloccato dall\'interfaccia.',
      });
    });

    // --- Connessioni salvate ----------------------------------------------------
    // Non richiedono una connessione DB attiva: servono proprio prima di averla.

    lifecycle.amministrativo('connections:list', (_payload, cb) => {
      const all = vault.loadConnections(socketContext.principal.ownerId);
      // Un sottoutente vede soltanto le connessioni su cui ha un grant.
      const visible = allowedConnections(socketContext.principal, Object.keys(all));
      const connections = visible
        .map((name) => ({ name, label: vault.connLabel(all[name]), dbType: vault.connDbType(all[name]), folder: all[name].folder || '' }));
      cb({ ok: true, connections });
    });

    lifecycle.amministrativo('connections:delete', async ({ name }, cb) =>
      identita.withConnectionAclLock(socketContext.principal.ownerId, async () => {
      identita.assertManage(socketContext.principal);
      const conns = vault.loadConnections(socketContext.principal.ownerId);
      if (!conns[name]) throw new Error(`Connessione salvata "${name}" non trovata.`);
      await identita.revocaAccessiConnessione(
        socketContext.principal.ownerId, name, 'connessione salvata eliminata'
      );
      delete conns[name];
      vault.saveConnections(conns, socketContext.principal.ownerId);
      cb({ ok: true });
      }));

    // Campi di una connessione salvata per popolarne il form di modifica.
    // I segreti non vengono mai rimandati al browser: si segnala solo se esistono.
    lifecycle.amministrativo('connections:get', ({ name }, cb) => {
      if (!canUseConnection(socketContext.principal, String(name || ''))) {
        throw new Error(`Permesso negato: nessun accesso alla connessione "${name}".`);
      }
      const conn = vault.loadConnections(socketContext.principal.ownerId)[name];
      if (!conn) throw new Error(`Connessione salvata "${name}" non trovata.`);
      const fields = { ...conn };
      const has = (f) => conn[f] != null && conn[f] !== '';
      const flags = {
        hasPassword: has('password'),
        hasUri: has('uri'),
        hasSshPassword: has('sshPassword'),
        hasSshPassphrase: has('sshPassphrase'),
      };
      for (const f of vault.SECRET_FIELDS) delete fields[f];
      cb({ ok: true, fields, ...flags });
    });

    // Crea o aggiorna una connessione salvata senza connettersi. oldName, se
    // diverso da name, rinomina la connessione. Password vuota nel form =
    // mantieni quella già salvata.
    lifecycle.amministrativo('connections:save', async ({ name, oldName, cfg }, cb) =>
      identita.withConnectionAclLock(socketContext.principal.ownerId, async () => {
      identita.assertManage(socketContext.principal);
      name = String(name || '').trim();
      vault.assertConnName(name);
      const conns = vault.loadConnections(socketContext.principal.ownerId);
      const previous = oldName ? conns[oldName] : conns[name];
      if (oldName && !previous) throw new Error(`Connessione salvata "${oldName}" non trovata.`);
      // Il nome è la chiave della sezione .ini: due connessioni con lo stesso nome
      // si sovrascriverebbero. Rifiuta se il nome è già in uso da un'ALTRA
      // connessione (nuova connessione, o modifica che rinomina su un nome occupato).
      if (conns[name] && name !== oldName) {
        throw new Error(`Esiste già una connessione chiamata "${name}". Scegli un nome diverso.`);
      }
      let next = vault.sanitizeConnCfg(cfg || {});
      if (previous) next = vault.preserveConnSecrets(next, previous);
      if (vault.connMode(next) === 'uri' && !next.uri) {
        throw new Error('Inserisci la URI MongoDB completa.');
      }
      if (oldName && oldName !== name) {
        await identita.revocaAccessiConnessione(
          socketContext.principal.ownerId, oldName, 'connessione salvata rinominata'
        );
        delete conns[oldName];
      }
      conns[name] = next;
      vault.saveConnections(conns, socketContext.principal.ownerId);
      cb({ ok: true });
      }));

    // Esporta il file .ini completo (password incluse, ma cifrate). Con
    // `passphrase` i segreti vengono ri-cifrati con la sua chiave (SHA256), così
    // il file è importabile su un'installazione che gira con QUELLA passphrase —
    // senza mai esporre i segreti in chiaro. Vuota = passphrase di questa
    // installazione (comportamento storico). I segreti sono comunque decifrati in
    // memoria da loadConnections e ri-cifrati qui, mai trasmessi in chiaro.
    lifecycle.amministrativo('connections:export', ({ passphrase } = {}, cb) => {
      identita.assertManage(socketContext.principal);
      const conns = vault.loadConnections(socketContext.principal.ownerId);
      if (!Object.keys(conns).length) throw new Error('Nessuna connessione salvata da esportare.');
      const pass = passphrase == null ? '' : String(passphrase);
      if (pass === '') {
        // Nessuna passphrase indicata: si esporta con la chiave dell'installazione
        // corrente, cioè il file è utile solo su questa macchina.
        cb({ ok: true, ini: vault.stringifyIni(vault.encryptSections(conns)) });
        return;
      }
      // Con una passphrase scelta il file per definizione LASCIA la macchina, e
      // fino a qui veniva cifrato con SHA256(passphrase): nessun salt, un solo
      // passaggio di hash, cioè miliardi di tentativi al secondo su GPU — proprio
      // il difetto che il formato v2 del vault esiste per risolvere. Si usa la
      // stessa derivazione del vault (scrypt + salt casuale per file) e i
      // parametri viaggiano in un'intestazione, così l'import può rifarla.
      const salt = crypto.randomBytes(16);
      const chiave = Vault.deriveKek(pass, salt, Vault.SCRYPT);
      const toSave = vault.encryptSections(conns, chiave);
      const conIntestazione = {
        [vault.SEZIONE_EXPORT]: {
          version: String(Vault.VERSION),
          kdf: 'scrypt',
          salt: salt.toString('hex'),
          N: String(Vault.SCRYPT.N),
          r: String(Vault.SCRYPT.r),
          p: String(Vault.SCRYPT.p),
          keylen: String(Vault.SCRYPT.keylen),
        },
        ...toSave,
      };
      cb({ ok: true, ini: vault.stringifyIni(conIntestazione) });
    });

    // Importa connessioni da un file .ini: le sezioni con lo stesso nome di una
    // connessione esistente vengono sovrascritte, le altre aggiunte.
    lifecycle.amministrativo('connections:import', ({ ini, passphrase } = {}, cb) => {
      identita.assertManage(socketContext.principal);
      const incoming = vault.parseIni(String(ini || ''));
      // Intestazione di un file esportato con una passphrase scelta: dice come
      // ridervarne la chiave. Senza, l'unico modo era confrontare i segreti con la
      // DEK locale — che su un vault v2 è casuale e non coincide MAI con una
      // chiave derivata da una passphrase, quindi il flusso "esporta con
      // passphrase, importa sull'altra macchina" non era realizzabile.
      const intestazione = incoming[vault.SEZIONE_EXPORT];
      delete incoming[vault.SEZIONE_EXPORT];
      let chiaveFile = null;
      if (intestazione) {
        const pass = passphrase == null ? '' : String(passphrase);
        if (!pass) {
          throw new Error('Questo file è stato esportato con una passphrase: indicala per poterlo importare.');
        }
        const salt = Buffer.from(String(intestazione.salt || ''), 'hex');
        if (!salt.length) throw new Error('Intestazione del file di export incompleta: manca il salt.');
        chiaveFile = Vault.deriveKek(pass, salt, {
          N: Number(intestazione.N) || Vault.SCRYPT.N,
          r: Number(intestazione.r) || Vault.SCRYPT.r,
          p: Number(intestazione.p) || Vault.SCRYPT.p,
          keylen: Number(intestazione.keylen) || Vault.SCRYPT.keylen,
          maxmem: Vault.SCRYPT.maxmem,
        });
      }

      const names = Object.keys(incoming);
      if (!names.length) throw new Error('Nessuna connessione trovata nel file importato.');
      const conns = vault.loadConnections(socketContext.principal.ownerId);
      let imported = 0;
      let overwritten = 0;
      for (const name of names) {
        vault.assertConnName(name);
        const cfg = vault.sanitizeConnCfg(incoming[name]);
        if (!Object.keys(cfg).length) continue; // sezione senza campi utili
        // I segreti cifrati devono poter essere letti QUI: un "ENC:" estraneo
        // verrebbe scoperto solo al riavvio, e con decryptFailures > 0 il server
        // rifiuterebbe di partire. Con l'intestazione si decifra con la chiave del
        // FILE e si ri-cifra con quella dell'installazione, altrimenti nel vault
        // resterebbe un segreto che solo il file sa aprire.
        for (const f of vault.SECRET_FIELDS) {
          if (!cfg[f] || !cfg[f].startsWith('ENC:')) continue;
          if (chiaveFile) {
            let chiaro;
            try {
              chiaro = Vault.decryptWith(cfg[f], chiaveFile);
            } catch {
              throw new Error(`Il segreto "${f}" della connessione "${name}" non si apre con la passphrase indicata: controllala e riprova.`);
            }
            cfg[f] = vault.encryptSecret(chiaro);
            continue;
          }
          try {
            vault.decryptRaw(cfg[f]);
          } catch {
            throw new Error(`Il segreto "${f}" della connessione "${name}" è cifrato con un'altra passphrase: esporta/importa con la stessa passphrase, oppure rimuovi i segreti dal file e reinseriscili dopo l'import.`);
          }
        }
        if (conns[name]) overwritten += 1; else imported += 1;
        conns[name] = cfg;
      }
      if (!imported && !overwritten) throw new Error('Il file non contiene connessioni valide.');
      vault.saveConnections(conns, socketContext.principal.ownerId);
      cb({ ok: true, imported, overwritten });
    });
  }

  return registra;
}

module.exports = { createModule };

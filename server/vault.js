'use strict';

// CodeDB — vault. Stato e dipendenze appartengono alla singola istanza.
const path = require('path');
const Vault = require('../db/vault');
const fs = require('fs');

function createModule({ config, errori, dependencies }) {
  /* ---------------------------------------------------------------------------
   * Connessioni salvate (connections.ini)
   * ------------------------------------------------------------------------- */

  // CODEDB_CONNECTIONS_FILE: override usato dai test per lavorare su un file
  // temporaneo senza mai toccare il connections.ini reale (stesso env della CLI
  // di backup, vedi backup/lib/connstore.js).
  const CONNECTIONS_FILE = config.env.CODEDB_CONNECTIONS_FILE || path.join(config.rootDir, 'connections.ini');

  const CONN_FIELDS = [
    'dbType', 'uri', 'host', 'port', 'username', 'password', 'authSource', 'database',
    // Modalità esplicita: evita di conservare una vecchia URI (che ha priorità
    // sui campi host/porta) quando l'utente passa al form Parametri.
    'connectionMode',
    // Cartella/gruppo di appartenenza nella sidebar del connection manager.
    'folder',
    // Fase 3 MCP: le scritture via execute_write sono consentite solo se la
    // connessione dichiara esplicitamente readOnly=false (default: sola lettura).
    'readOnly',
    // Tunnel SSH (ortogonale al dbType): 'ssh' = "true" per abilitarlo.
    // sshHostKey: impronta SHA256 della host key del bastion. NON è un segreto
    // (è un'impronta pubblica) ma va conservata: è ciò che rende rilevabile un
    // MITM sul tunnel. Registrata al primo collegamento riuscito.
    'ssh', 'sshHost', 'sshPort', 'sshUser', 'sshPassword', 'sshKeyFile', 'sshPassphrase', 'sshHostKey',
  ];

  // Campi segreti: mai rimandati al browser, riusati dal valore salvato se il form
  // li lascia vuoti (vedi connections:get/save e mongo:connect con keepPasswordFrom).
  const SECRET_FIELDS = ['password', 'sshPassword', 'sshPassphrase', 'uri'];

  // Sezione di intestazione dei file esportati con una passphrase scelta: porta
  // il salt e i parametri scrypt con cui ridervare la chiave sull'altra macchina.
  // Il nome comincia e finisce con `__` perché non possa essere scambiato per una
  // connessione (assertConnName rifiuta comunque i nomi che non sembrano tali).
  const SEZIONE_EXPORT = '__codedb_export__';

  // Chiave con cui i segreti sono cifrati. Nel formato v2 è la **DEK** casuale
  // sbustata dalla passphrase (db/vault.js); nei vault v1 non ancora migrati è
  // ancora `SHA256(passphrase)`. Da qui in giù il resto del codice non vede la
  // differenza: cifra e decifra con questa chiave e basta.
  let encryptionKey = Vault.legacyKey(config.env.GUI_MONGO_PASSPHRASE || '');

  // Metadati del vault v2 (null = vault ancora in formato v1).
  let vaultMeta = null;

  // Il vault è protetto da una passphrase non vuota? (CDB-66)
  //
  // Serve solo alla modale, per sapere se sta IMPOSTANDO la prima passphrase o
  // cambiandone una esistente. La risposta si ottiene provando ad aprire la DEK
  // con la passphrase vuota — cioè con uno `scryptSync` da ~28 ms, durante i quali
  // l'event loop è fermo per TUTTE le sessioni. Calcolarla a ogni `vault:status`
  // (evento che non richiede alcuna capability) rendeva la risposta a una domanda
  // di sola presentazione un modo per bloccare il server. Si calcola quindi una
  // volta e si aggiorna nei soli tre punti che possono cambiarla: sblocco,
  // cambio passphrase, azzeramento.
  let vaultProtetto = !!config.env.GUI_MONGO_PASSPHRASE;

  function aggiornaVaultProtetto(passphraseNonVuota) {
    vaultProtetto = !!passphraseNonVuota;
  }

  // Conta i segreti che non si decifrano: all'avvio un valore > 0 significa
  // passphrase sbagliata e il server rifiuta di partire (vedi main), invece di
  // proseguire e riscrivere il file coi segreti azzerati.
  let decryptFailures = 0;

  function encryptSecret(text, cryptoKey = encryptionKey) {
    return Vault.encryptWith(text, cryptoKey);
  }

  // Decifra un segreto ENC:iv:tag:testo; lancia se la chiave non è quella giusta.
  function decryptRaw(text) {
    return Vault.decryptWith(text, encryptionKey);
  }

  function decryptSecret(text) {
    if (!text || typeof text !== 'string') return text;
    if (!text.startsWith('ENC:')) return text; // non cifrato (plain text)
    if (!encryptionKey) return text; // vault bloccato: restituisci il cifrato intatto
    try {
      return decryptRaw(text);
    } catch (e) {
      console.error('Errore decrittazione segreto:', e.message);
      decryptFailures += 1;
      // Conserva il testo cifrato: così un eventuale salvataggio successivo
      // riscrive il file col cifrato originale intatto, mai col segreto azzerato
      // (encryptSecret lascia passare i valori già "ENC:").
      return text;
    }
  }

  /**
   * Il vault è utilizzabile con la chiave attuale?
   *
   * Serve all'avvio senza GUI_MONGO_PASSPHRASE, dove la chiave è quella derivata
   * dalla passphrase vuota. Non basta chiedersi "ci sono segreti cifrati?": chi non
   * ha mai impostato una passphrase HA segreti cifrati, ma con la chiave vuota —
   * per lui non deve cambiare nulla e nessuna modale deve comparire. La domanda
   * giusta è se i segreti presenti si decifrano davvero.
   *
   * Legge tutti i vault (quello storico condiviso e, con RBAC, quelli per owner).
   * @returns {boolean} true se non c'è nulla da decifrare o si decifra tutto.
   */
  function probeVault() {
    // Vault v2: la domanda ha una risposta esatta e a costo zero — la DEK si
    // sbusta con la passphrase vuota oppure no.
    const meta = Vault.readMeta(CONNECTIONS_FILE);
    if (meta) {
      const dataKey = Vault.unwrapDataKey(meta, '');
      // Qui la domanda "il vault ha una passphrase?" è già stata posta e pagata:
      // se la chiave vuota NON apre la DEK, una passphrase c'è (CDB-66).
      aggiornaVaultProtetto(!dataKey);
      if (!dataKey) return false;
      encryptionKey = dataKey;
      vaultMeta = meta;
      return true;
    }

    const before = decryptFailures;
    decryptFailures = 0;
    try {
      loadConnections();
      // Con RBAC acceso ogni owner ha il proprio file: vanno verificati tutti,
      // altrimenti il vault sembrerebbe a posto solo perché il file condiviso lo è.
      if (config.rbacOn()) {
        try {
          if (fs.existsSync(CONNECTIONS_DIR)) {
            for (const f of fs.readdirSync(CONNECTIONS_DIR)) {
              if (f.endsWith('.ini')) loadConnections(path.basename(f, '.ini'));
            }
          }
        } catch { /* nessuna cartella per-owner: resta solo il file storico */ }
      }
    } catch (err) {
      console.error(`Impossibile leggere le connessioni salvate: ${errori.errMsg(err)}`);
    }
    const ok = decryptFailures === 0;
    decryptFailures = before;
    return ok;
  }

  /**
   * Apre il vault con la passphrase indicata.
   *
   * Due formati possibili:
   *  · **v2** (metadati presenti): si sbusta la DEK. Un solo tentativo, esatto —
   *    o la chiave si apre o la passphrase è sbagliata.
   *  · **v1** (nessun metadato): la chiave È la passphrase, e si verifica
   *    provando a decifrare i segreti presenti.
   *
   * Non riscrive nulla: la migrazione a v2 è un passo separato ed esplicito
   * (`migrateVaultToV2`), perché toccare l'unica copia dei segreti su disco deve
   * essere una decisione, non un effetto collaterale dell'avvio.
   */
  function tryUnlockVault(passphrase) {
    if (typeof passphrase !== 'string') {
      return { ok: false, error: 'Passphrase non valida.' };
    }

    const meta = Vault.readMeta(CONNECTIONS_FILE);
    if (meta) {
      const dataKey = Vault.unwrapDataKey(meta, passphrase);
      if (!dataKey) {
        return { ok: false, error: 'Passphrase errata: la chiave del vault non si apre.' };
      }
      encryptionKey = dataKey;
      vaultMeta = meta;
      decryptFailures = 0;
      aggiornaVaultProtetto(passphrase !== '');
      return { ok: true };
    }

    // Formato v1.
    const oldKey = encryptionKey;
    const oldFailures = decryptFailures;

    encryptionKey = Vault.legacyKey(passphrase);
    decryptFailures = 0;

    loadConnections();
    if (decryptFailures > 0) {
      encryptionKey = oldKey;
      decryptFailures = oldFailures;
      return { ok: false, error: 'Passphrase errata: i segreti cifrati non si decifrano con questa chiave.' };
    }
    vaultMeta = null;
    aggiornaVaultProtetto(passphrase !== '');
    return { ok: true, legacy: true };
  }

  /** Elenco dei file .ini che compongono il vault (condiviso + per-owner). */
  function vaultFiles() {
    const files = [];
    if (fs.existsSync(CONNECTIONS_FILE)) files.push({ file: CONNECTIONS_FILE, ownerId: null });
    try {
      if (fs.existsSync(CONNECTIONS_DIR)) {
        for (const f of fs.readdirSync(CONNECTIONS_DIR)) {
          if (f.endsWith('.ini')) files.push({ file: path.join(CONNECTIONS_DIR, f), ownerId: path.basename(f, '.ini') });
        }
      }
    } catch { /* nessuna cartella per-owner */ }
    return files;
  }

  /**
   * Porta il vault dal formato v1 al v2 ri-cifrando i segreti con una DEK nuova.
   *
   * È l'unico momento in cui i segreti vengono riscritti, quindi vale la pena
   * essere prudenti: si lavora su tutto in memoria, si tiene una copia
   * pre-migrazione FUORI dalla rotazione .bak (che i riavvii consumano), si
   * scrive, e si **rilegge per verificare** che ogni segreto torni identico
   * all'originale. Se qualcosa non torna, si ripristina e non si migra.
   *
   * @param {string} newPassphrase passphrase con cui avvolgere la nuova DEK
   * @returns {{ok: true, migrated: number} | {ok: false, error: string}}
   */
  function migrateVaultToV2(newPassphrase) {
    if (!encryptionKey) return { ok: false, error: 'Vault bloccato: sbloccalo prima di cambiare passphrase.' };

    // 1. Tutto in chiaro in memoria, con la chiave attuale.
    const inMemoria = [];
    for (const { file, ownerId } of vaultFiles()) {
      decryptFailures = 0;
      const sezioni = loadConnections(ownerId);
      if (decryptFailures > 0) {
        return { ok: false, error: `Alcuni segreti in "${path.basename(file)}" non si decifrano: migrazione annullata.` };
      }
      inMemoria.push({ file, ownerId, sezioni });
    }

    // 2. Copia pre-migrazione, con un nome che la rotazione .bak non tocca.
    const copie = [];
    try {
      for (const { file } of inMemoria) {
        const copia = `${file}.pre-vault2`;
        if (fs.existsSync(file)) { fs.copyFileSync(file, copia); copie.push(copia); }
      }
    } catch (err) {
      return { ok: false, error: `Impossibile creare la copia di sicurezza: ${errori.errMsg(err)}` };
    }

    // 3. Nuova DEK e riscrittura.
    const { meta, dataKey } = Vault.createMeta(newPassphrase);
    const chiavePrecedente = encryptionKey;
    try {
      encryptionKey = dataKey;
      for (const { sezioni, ownerId } of inMemoria) {
        if (Object.keys(sezioni).length) saveConnections(sezioni, ownerId);
      }
      Vault.writeMeta(CONNECTIONS_FILE, meta);

      // 4. Verifica rileggendo dal disco: i segreti devono tornare identici.
      for (const { sezioni, ownerId } of inMemoria) {
        decryptFailures = 0;
        const riletto = loadConnections(ownerId);
        if (decryptFailures > 0) throw new Error('rilettura fallita dopo la migrazione');
        for (const [nome, sec] of Object.entries(sezioni)) {
          for (const campo of SECRET_FIELDS) {
            if ((sec[campo] || '') !== ((riletto[nome] || {})[campo] || '')) {
              throw new Error(`il segreto "${campo}" di "${nome}" non corrisponde dopo la migrazione`);
            }
          }
        }
      }
    } catch (err) {
      // Ripristino: si torna al formato v1 esattamente com'era.
      encryptionKey = chiavePrecedente;
      try {
        for (const { file } of inMemoria) {
          const copia = `${file}.pre-vault2`;
          if (fs.existsSync(copia)) fs.copyFileSync(copia, file);
        }
        const metaFile = Vault.metaFileFor(CONNECTIONS_FILE);
        if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
      } catch { /* ripristino best-effort: le copie restano su disco */ }
      return { ok: false, error: `Migrazione annullata (${errori.errMsg(err)}). I file sono stati ripristinati; la copia di sicurezza è in *.pre-vault2.` };
    }

    vaultMeta = meta;
    decryptFailures = 0;
    return { ok: true, migrated: inMemoria.length, copie };
  }

  /**
   * Cambia la passphrase del vault.
   *
   * Su un vault v2 è un'operazione minuscola: si riavvolge la DEK e si riscrive
   * il solo file dei metadati. I segreti non vengono toccati — nessuna finestra
   * in cui l'unica copia delle credenziali è a metà scrittura.
   * Su un vault v1 la stessa richiesta fa la migrazione (una volta sola).
   */
  function changeVaultPassphrase(newPassphrase) {
    if (typeof newPassphrase !== 'string') {
      return { ok: false, error: 'Passphrase non valida.' };
    }
    if (!encryptionKey) {
      return { ok: false, error: 'Vault bloccato: sbloccalo con la passphrase attuale prima di cambiarla.' };
    }

    if (!vaultMeta) {
      const res = migrateVaultToV2(newPassphrase);
      if (!res.ok) return res;
      return { ok: true, migrated: true };
    }

    const nuovoMeta = Vault.rewrapDataKey(vaultMeta, encryptionKey, newPassphrase);
    const metaFile = Vault.metaFileFor(CONNECTIONS_FILE);
    const precedente = fs.existsSync(metaFile) ? fs.readFileSync(metaFile, 'utf8') : null;
    try {
      Vault.writeMeta(CONNECTIONS_FILE, nuovoMeta);
      // Verifica: la nuova passphrase deve aprire la STESSA chiave dati.
      const riletto = Vault.readMeta(CONNECTIONS_FILE);
      const prova = Vault.unwrapDataKey(riletto, newPassphrase);
      if (!prova || !prova.equals(encryptionKey)) throw new Error('verifica fallita');
      vaultMeta = riletto;
      aggiornaVaultProtetto(newPassphrase !== '');
      return { ok: true, migrated: false };
    } catch (err) {
      if (precedente !== null) {
        try { fs.writeFileSync(metaFile, precedente, 'utf8'); } catch { /* best-effort */ }
      }
      return { ok: false, error: `Cambio passphrase annullato: ${errori.errMsg(err)}. La passphrase precedente resta valida.` };
    }
  }

  /**
   * Ricomincia da capo: vault nuovo con una passphrase nuova, connessioni salvate
   * messe da parte.
   *
   * È l'unica via d'uscita da una passphrase dimenticata. Senza di essa il vault
   * bloccato è un vicolo cieco: la modale di sblocco chiede l'unica cosa che
   * l'utente non ha, e l'applicazione non si apre nemmeno per creare una
   * connessione nuova (i segreti non si decifrano, e non esiste — per costruzione
   * — alcun recupero).
   *
   * I file NON vengono cancellati ma **rinominati** in `*.pre-reset-<timestamp>`:
   * sono comunque illeggibili senza la passphrase perduta, quindi non c'è nulla da
   * proteggere in più, mentre chi si ricorda la passphrase il giorno dopo (o ha
   * premuto per sbaglio) può rimetterli al loro posto. Cancellare l'unica copia
   * dei segreti su richiesta di un clic sarebbe l'unica operazione davvero
   * irreversibile di tutta l'applicazione.
   *
   * @param {string} newPassphrase passphrase del vault nuovo (vuota = nessuna)
   * @returns {{ok: true, spostati: string[], suffisso: string} | {ok: false, error: string}}
   */
  function resetVault(newPassphrase) {
    if (typeof newPassphrase !== 'string') {
      return { ok: false, error: 'Passphrase non valida.' };
    }

    const suffisso = `pre-reset-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const daSpostare = vaultFiles().map((v) => v.file);
    const metaFile = Vault.metaFileFor(CONNECTIONS_FILE);
    if (fs.existsSync(metaFile)) daSpostare.push(metaFile);

    const mosse = [];
    try {
      for (const file of daSpostare) {
        const destinazione = `${file}.${suffisso}`;
        fs.renameSync(file, destinazione);
        mosse.push({ file, destinazione });
      }
    } catch (err) {
      // Rimetti a posto quello che era già stato spostato: meglio il vault
      // bloccato di prima che un vault a metà.
      for (const { file, destinazione } of mosse) {
        try { fs.renameSync(destinazione, file); } catch { /* best-effort */ }
      }
      return { ok: false, error: `Impossibile mettere da parte i file del vault: ${errori.errMsg(err)}` };
    }
    const spostati = mosse.map((m) => path.basename(m.destinazione));

    // Vault nuovo di zecca: DEK casuale avvolta dalla passphrase indicata.
    const { meta, dataKey } = Vault.createMeta(newPassphrase);
    try {
      Vault.writeMeta(CONNECTIONS_FILE, meta);
    } catch (err) {
      return { ok: false, error: `Vault non ricreato: ${errori.errMsg(err)}` };
    }
    encryptionKey = dataKey;
    vaultMeta = meta;
    decryptFailures = 0;
    aggiornaVaultProtetto(newPassphrase !== '');

    return { ok: true, spostati, suffisso };
  }

  // Nomi che non possono essere usati come sezione o come chiave (CDB-21):
  // assegnare `sections.__proto__ = {}` non crea una sezione, CAMBIA il prototipo
  // dell'oggetto — e `constructor`/`prototype` sono la stessa famiglia di
  // sorprese. Un nome di connessione arriva dall'utente, quindi la difesa va qui,
  // nel parser, non nel chiamante.
  const CHIAVI_INI_VIETATE = new Set(['__proto__', 'constructor', 'prototype']);

  function parseIni(text) {
    // `Object.create(null)`: nessun prototipo da inquinare, nemmeno per sbaglio.
    const sections = Object.create(null);
    let current = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith(';') || line.startsWith('#')) continue;
      const header = line.match(/^\[(.+)\]$/);
      if (header) {
        if (CHIAVI_INI_VIETATE.has(header[1])) {
          console.warn(`[connections.ini] Sezione "${header[1]}" ignorata: nome riservato.`);
          current = null;
          continue;
        }
        current = sections[header[1]] = Object.create(null);
        continue;
      }
      const eq = line.indexOf('=');
      if (current && eq > 0) {
        const chiave = line.slice(0, eq).trim();
        if (CHIAVI_INI_VIETATE.has(chiave)) continue;
        current[chiave] = line.slice(eq + 1).trim();
      }
    }
    return sections;
  }

  function stringifyIni(sections) {
    // L'intestazione descrive il file com'è DAVVERO (CDB-23): i segreti sono
    // cifrati (prefisso ENC:), e dirli "in chiaro" spingeva a trattare male un
    // file che invece va conservato — mentre la cosa importante da sapere è che
    // senza la passphrase quei segreti non si recuperano.
    const lines = [
      '; Connessioni salvate di CodeDB.',
      '; Le password e i segreti SSH sono cifrati (valori con prefisso ENC:) con la',
      '; chiave del vault, custodita in vault.json accanto a questo file.',
      '; Senza la passphrase del vault NON sono recuperabili: conserva entrambi i file.',
    ];
    for (const [name, values] of Object.entries(sections)) {
      lines.push('', `[${name}]`);
      for (const [key, val] of Object.entries(values)) {
        if (val != null && String(val).trim() !== '') lines.push(`${key}=${String(val).trim()}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  // Isolamento multi-tenant delle connessioni salvate: con RBAC attivo ogni owner
  // ha il proprio file data/conns/<ownerId>.ini, così un tenant non può vedere né
  // usare le connessioni (né i segreti) di un altro. Con RBAC spento — o per
  // l'owner locale/root — resta il file storico condiviso CONNECTIONS_FILE, e i
  // test continuano a usare l'override CODEDB_CONNECTIONS_FILE. La chiave del vault
  // (passphrase) resta unica per installazione: cambia solo il file, non la chiave.
  const CONNECTIONS_DIR = config.env.CODEDB_CONNECTIONS_DIR
    || path.join(path.dirname(CONNECTIONS_FILE), 'conns');

  function connectionsFileFor(ownerId) {
    const id = String(ownerId == null ? '' : ownerId).trim();
    if (!config.rbacOn() || !id || id === 'local') return CONNECTIONS_FILE;
    const safe = id.replace(/[^A-Za-z0-9_.-]/g, '_');
    return path.join(CONNECTIONS_DIR, `${safe}.ini`);
  }

  /**
   * Ci sono segreti salvati (password del DB, password o passphrase SSH)?
   *
   * Si guarda il file GREZZO, senza decifrare nulla: la risposta serve a un
   * evento che non richiede capability, e l'unica cosa che deve dire è "c'è
   * qualcosa da proteggere", non cosa.
   *
   * NB: non basta cercare `ENC:`. Un segreto scritto a mano nel file resta **in
   * chiaro** finché non c'è una passphrase (`encryptPlaintextSecretsOnce` gira
   * solo nel ramo con passphrase), e quello è il caso ancora più urgente da
   * segnalare. Un file assente o illeggibile vale "nessun segreto": l'avviso è un
   * suggerimento, non una barriera, e non deve inventare allarmi.
   */
  function haSegretiSalvati(ownerId) {
    try {
      const sezioni = parseIni(fs.readFileSync(connectionsFileFor(ownerId), 'utf8'));
      return Object.values(sezioni).some((sec) =>
        SECRET_FIELDS.some((f) => sec[f] && String(sec[f]).trim() !== ''));
    } catch {
      return false;
    }
  }

  function loadConnections(ownerId) {
    try {
      const sections = parseIni(fs.readFileSync(connectionsFileFor(ownerId), 'utf8'));
      for (const sec of Object.values(sections)) {
        for (const f of SECRET_FIELDS) {
          if (sec[f]) sec[f] = decryptSecret(sec[f]);
        }
      }
      return sections;
    } catch {
      return {}; // file assente o illeggibile: nessuna connessione salvata
    }
  }

  // Cifra i segreti (password, credenziali SSH) di una copia profonda delle
  // sezioni, senza toccare l'originale: usata sia prima di riscrivere il file
  // sia prima di esportarlo, così i due percorsi restano un solo punto di verità.
  // `cryptoKey` permette all'export di cifrare con una passphrase diversa da
  // quella dell'installazione corrente (default: la chiave del vault attivo).
  function encryptSections(sections, cryptoKey = encryptionKey) {
    const copy = {};
    for (const name in sections) {
      const secCopy = { ...sections[name] };
      for (const f of SECRET_FIELDS) {
        if (secCopy[f]) secCopy[f] = encryptSecret(secCopy[f], cryptoKey);
      }
      copy[name] = secCopy;
    }
    return copy;
  }

  function saveConnections(sections, ownerId) {
    const file = connectionsFileFor(ownerId);
    const toSave = encryptSections(sections);
    // La directory per-owner potrebbe non esistere ancora al primo salvataggio.
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* già presente */ }
    // Prima di riscrivere, conserva le due versioni precedenti (.bak e .bak2):
    // il file è l'unica copia dei segreti sul disco e la migrazione all'avvio con
    // una passphrase sbagliata li azzererebbe; due generazioni proteggono anche
    // se dopo una migrazione corrotta arriva un ulteriore salvataggio dalla UI.
    try {
      fs.copyFileSync(file + '.bak', file + '.bak2');
    } catch { /* nessun .bak precedente: niente da ruotare */ }
    try {
      fs.copyFileSync(file, file + '.bak');
    } catch { /* file ancora inesistente: nessun backup da fare */ }
    fs.writeFileSync(file, stringifyIni(toSave), 'utf8');
  }

  function assertConnName(name) {
    if (!name || /[\[\]\r\n]/.test(name)) {
      throw new Error(`Nome di connessione non valido: "${name}"`);
    }
    // Il nome diventa la chiave di un oggetto: `__proto__` e compagnia non
    // creerebbero una connessione ma toccherebbero il prototipo (CDB-21). Il
    // parser li scarta già in lettura; qui si evita di scriverli.
    if (CHIAVI_INI_VIETATE.has(name)) {
      throw new Error(`Nome di connessione riservato: "${name}". Scegline un altro.`);
    }
  }

  // Tiene solo i campi noti e non vuoti di una configurazione di connessione.
  function sanitizeConnCfg(cfg) {
    const clean = Object.fromEntries(
      CONN_FIELDS
        .filter((f) => cfg[f] != null && String(cfg[f]).trim() !== '')
        .map((f) => [f, String(cfg[f]).trim()])
    );
    return preserveConnSecrets(clean, null);
  }

  // dbType assente nelle connessioni salvate prima del supporto multi-db.
  function connDbType(cfg) {
    return String(cfg.dbType || 'mongodb').trim().toLowerCase();
  }

  function sshEnabled(cfg) {
    return String(cfg.ssh || '').trim().toLowerCase() === 'true';
  }

  function connMode(cfg) {
    const mode = String((cfg && cfg.connectionMode) || '').trim().toLowerCase();
    if (mode === 'uri' || mode === 'fields') return mode;
    // Compatibilità coi file creati prima dell'introduzione del marcatore.
    return cfg && cfg.uri && String(cfg.uri).trim() ? 'uri' : 'fields';
  }

  // Riusa soltanto i segreti coerenti con la modalità selezionata. In particolare,
  // passando da URI a Parametri la vecchia URI va eliminata: MongoDB le darebbe
  // priorità e continuerebbe a collegarsi alla destinazione precedente.
  function preserveConnSecrets(next, previous) {
    const merged = { ...next, connectionMode: connMode(next) };
    const previousMode = connMode(previous || {});
    if (merged.connectionMode === 'uri') {
      if (!merged.uri && previousMode === 'uri' && previous && previous.uri) merged.uri = previous.uri;
      delete merged.password;
      // L'app non combina URI e tunnel SSH: il tunnel deve riscrivere host e
      // porta, cosa non sicura su una URI arbitraria. Non conservare credenziali
      // SSH irraggiungibili in questa modalità.
      delete merged.sshPassword;
      delete merged.sshPassphrase;
      return merged;
    }
    delete merged.uri;
    if (previousMode === 'fields' && previous && !merged.password && previous.password) {
      merged.password = previous.password;
    }

    // I segreti SSH sopravvivono a un aggiornamento solo mentre il tunnel resta
    // attivo. Disattivandolo vengono rimossi invece di restare inutilizzati nel
    // file delle connessioni.
    if (sshEnabled(merged)) {
      if (previousMode === 'fields' && previous) {
        for (const f of ['sshPassword', 'sshPassphrase']) {
          if (!merged[f] && previous[f]) merged[f] = previous[f];
        }
      }
    } else {
      delete merged.sshPassword;
      delete merged.sshPassphrase;
    }
    return merged;
  }

  // Etichetta mostrata in UI: della URI conserva solo destinazione e percorso.
  // Query string, frammento e credenziali possono contenere token o password.
  function connLabel(cfg) {
    let base;
    if (cfg.uri && cfg.uri.trim()) {
      try {
        const parsed = new URL(cfg.uri.trim());
        const auth = parsed.username || parsed.password ? '***@' : '';
        base = `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname || ''}`;
      } catch {
        base = 'URI MongoDB configurata';
      }
    } else {
      const type = connDbType(cfg);
      base = `${(cfg.host || 'localhost').trim()}:${String(cfg.port || dependencies.DbFactory.defaultPort(type)).trim()}`;
    }
    return sshEnabled(cfg) ? `${base} (via SSH)` : base;
  }

  /**
   * Cifra i segreti rimasti in chiaro nei file del vault, e SOLO quelli.
   *
   * Prima questa migrazione avveniva riscrivendo l'intero vault a ogni avvio
   * riuscito: il file veniva ri-cifrato con IV nuovi e la rotazione consumava una
   * generazione di backup (`.bak` → `.bak2`) ogni volta, così due riavvii
   * bruciavano entrambe le copie di sicurezza. Ora si riscrive solo se c'è
   * davvero qualcosa da cifrare.
   */
  function encryptPlaintextSecretsOnce() {
    if (!encryptionKey) return;
    for (const { file, ownerId } of vaultFiles()) {
      let grezzo;
      try { grezzo = parseIni(fs.readFileSync(file, 'utf8')); } catch { continue; }
      const daCifrare = Object.values(grezzo).some((sec) =>
        SECRET_FIELDS.some((f) => sec[f] && !String(sec[f]).startsWith('ENC:')));
      if (!daCifrare) continue;
      try {
        const encoded = stringifyIni(encryptSections(loadConnections(ownerId)));
        // Non usare saveConnections qui: ruoterebbe il file in chiaro in .bak.
        // Si sovrascrivono prima entrambe le copie e soltanto alla fine il file
        // corrente; se il processo si interrompe, il corrente resta rilevabile al
        // prossimo avvio e la migrazione viene ripetuta.
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* già presente */ }
        fs.writeFileSync(file + '.bak2', encoded, 'utf8');
        fs.writeFileSync(file + '.bak', encoded, 'utf8');
        fs.writeFileSync(file, encoded, 'utf8');
        console.log(`Segreti in chiaro cifrati in "${path.basename(file)}".`);
      } catch (err) {
        console.error(`Impossibile cifrare i segreti in chiaro di "${path.basename(file)}": ${errori.errMsg(err)}`);
      }
    }
  }

  function initialize() {
    const passphrase = config.env.GUI_MONGO_PASSPHRASE;
    if (passphrase) {
      if (!tryUnlockVault(passphrase).ok) throw new Error('Passphrase errata fornita via GUI_MONGO_PASSPHRASE: i segreti non si decifrano.');
      encryptPlaintextSecretsOnce();
    } else if (!probeVault()) {
      encryptionKey = null; decryptFailures = 0;
      console.warn('Vault BLOCCATO: sblocca i segreti dall’interfaccia web.');
    }
  }

  function stato(ownerId) {
    return { locked: encryptionKey === null, formato: vaultMeta ? Vault.VERSION : 1,
      protetto: vaultProtetto, segreti: haSegretiSalvati(ownerId) };
  }

  function verificaPassphrase(passphrase) {
    if (encryptionKey === null) return false;
    return vaultMeta ? !!Vault.unwrapDataKey(vaultMeta, passphrase)
      : Vault.legacyKey(passphrase).equals(encryptionKey);
  }

  return {
    stato,
    verificaPassphrase,
    SECRET_FIELDS,
    SEZIONE_EXPORT,
    encryptSecret,
    decryptRaw,
    tryUnlockVault,
    changeVaultPassphrase,
    resetVault,
    parseIni,
    stringifyIni,
    loadConnections,
    encryptSections,
    saveConnections,
    assertConnName,
    sanitizeConnCfg,
    connDbType,
    sshEnabled,
    connMode,
    preserveConnSecrets,
    connLabel,
    initialize
  };
}

module.exports = { createModule };

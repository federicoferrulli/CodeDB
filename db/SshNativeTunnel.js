'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { utils } = require('ssh2');

function temporary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-ssh-native-'));
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('codedb-ssh-native-')) throw new Error('Directory temporanea SSH non valida.');
  fs.chmodSync(root, 0o700);
  if (process.platform === 'win32') {
    try {
      // chmod non imposta le ACL Windows: il materiale privato appartiene solo all'utente corrente.
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference = "Stop"; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; '
        + '$acl = New-Object System.Security.AccessControl.DirectorySecurity; '
        + '$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); '
        + '$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"); '
        + '$acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($env:CODEDB_SSH_TEMP_DIR, $acl);'],
      { env: { ...process.env, CODEDB_SSH_TEMP_DIR: root }, windowsHide: true, stdio: 'pipe', timeout: 10000 });
    } catch {
      fs.rmSync(root, { recursive: true, force: true });
      throw new Error('Impossibile proteggere i file temporanei SSH con le autorizzazioni Windows.');
    }
  }
  return {
    root,
    write(name, contents, mode = 0o600) { const file = path.join(root, name); fs.writeFileSync(file, contents, { mode }); return file; },
    close() {
      // Il percorso proviene da mkdtemp, resta confinato alla directory temporanea.
      if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('codedb-ssh-native-')) throw new Error('Directory temporanea SSH non valida.');
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function rispostaAskpass(prompt, env = process.env) {
  // Node interpreta il prompt passato da ssh come nome del programma e vi antepone cwd.
  const prefix = process.cwd() + require('node:path').sep;
  if (prompt.startsWith(prefix)) prompt = prompt.slice(prefix.length);
  if (/^\s*(?:Enter\s+)?passphrase\b/i.test(prompt)) return env.CODEDB_SSH_KEY_PASSPHRASE || '';
  if (/^\s*(?:Enter\s+)?PIN\b/i.test(prompt)) return env.CODEDB_SSH_KEY_PIN || '';
  return null;
}

function ambienteAskpass(temp, passphrase, securityKeyPin) {
  const env = { ...process.env, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'codedb:0' };
  // Il segreto viaggia solo nell'ambiente del processo, mai negli argomenti o nei file.
  const helper = temp.write('askpass.cjs', `'use strict';\nconst rispostaAskpass = ${rispostaAskpass.toString()};\nconst risposta = rispostaAskpass(process.argv.slice(1).join(' '));\nif (risposta === null) process.exit(1);\nprocess.stdout.write(risposta);\nprocess.exit(0);\n`);
  env.SSH_ASKPASS = process.execPath;
  env.NODE_OPTIONS = `--require=${JSON.stringify(helper)}`;
  env.ELECTRON_RUN_AS_NODE = '1';
  env.CODEDB_SSH_KEY_PASSPHRASE = passphrase || '';
  env.CODEDB_SSH_KEY_PIN = securityKeyPin || '';
  return env;
}

function messaggioErrore(text, code) {
  const detail = String(text || '').trim().slice(-1800);
  if (/ENOENT/.test(String(code))) return new Error('Per utilizzare certificati SSH o chiavi FIDO installa il client OpenSSH sulla macchina che esegue CodeDB.');
  if (/incorrect passphrase|bad passphrase|decrypt|load key.*incorrect|passphrase.*failed/i.test(detail)) return new Error('Passphrase della chiave SSH mancante o errata.');
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(detail)) return new Error('La chiave del server SSH NON corrisponde a quella approvata. Connessione interrotta prima dell’autenticazione.');
  if (/device not found|device not connected|security key|sign_and_send_pubkey.*failed|signing failed/i.test(detail)) return new Error('Impossibile firmare con la chiave FIDO o con l’agente SSH. Collega e sblocca il dispositivo, conferma la presenza quando richiesta e riprova. ' + detail);
  return new Error('OpenSSH non ha completato la connessione' + (detail ? ': ' + detail : '.') );
}

async function validaIdentitaNativa(identity, passphrase) {
  const temp = temporary();
  try {
    const file = temp.write('identity', identity), env = ambienteAskpass(temp, passphrase);
    await new Promise((resolve, reject) => {
      const child = spawn('ssh-keygen', ['-y', '-f', file], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let detail = '', settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => { child.kill(); }, 15000);
      child.stderr.on('data', chunk => { detail = (detail + chunk.toString()).slice(-4000); });
      child.once('error', err => finish(messaggioErrore(detail, err.code)));
      child.once('close', code => finish(code === 0 ? null : messaggioErrore(detail || 'File chiave SSH non valido o passphrase errata.', code)));
    });
  } finally { temp.close(); }
}

function optionPath(value) {
  // OpenSSH interpreta questi valori come configurazione anche quando passati via argv.
  const normalized = process.platform === 'win32' ? value.replace(/\\/g, '/') : value;
  if (/[\r\n\0]/.test(normalized)) throw new Error('Percorso agente SSH non valido.');
  return '"' + normalized.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

async function portaLibera() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function ponteAgente(descriptor, temp) {
  const { richiestaAgente } = require('./SshAgent');
  const source = descriptor.agentSource;
  const str = value => { const buffer = Buffer.from(value), size = Buffer.alloc(4); size.writeUInt32BE(buffer.length); return Buffer.concat([size, buffer]); };
  const frame = value => str(value);
  const sockets = new Set();
  const agentPath = process.platform === 'win32' ? '\\\\.\\pipe\\codedb-agent-' + crypto.randomBytes(20).toString('hex') : path.join(temp.root, 'agent.sock');
  const server = net.createServer(socket => {
    sockets.add(socket); let pending = Buffer.alloc(0), queue = Promise.resolve(), upstream;
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); upstream?.destroy(); });
    // La stessa connessione mantiene session-bind e i vincoli di destinazione dell'agente.
    const connected = descriptor.agentPath === 'pageant' ? Promise.resolve() : new Promise((resolve, reject) => source.getStream((err, stream) => {
      if (err) return reject(err);
      upstream = stream;
      if (socket.destroyed) { stream.destroy(); return resolve(); }
      stream.on('data', data => socket.write(data));
      stream.on('error', () => socket.destroy());
      stream.on('close', () => socket.destroy());
      resolve();
    }));
    connected.catch(() => socket.destroy());
    socket.on('data', data => {
      if (pending.length + data.length > 1024 * 1024) return socket.destroy();
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 4) {
        const size = pending.readUInt32BE();
        if (size < 1 || size > 1024 * 1024) return socket.destroy();
        if (pending.length < size + 4) break;
        let request = pending.subarray(4, size + 4); pending = pending.subarray(size + 4);
        queue = queue.then(async () => {
          await connected;
          if (request[0] === 11) return socket.write(frame(Buffer.concat([Buffer.from([12, 0, 0, 0, 1]), str(descriptor.publicKey), str('CodeDB')])));
          if (request[0] === 13) {
            if (request.length < 5) return socket.destroy();
            const keySize = request.readUInt32BE(1);
            if (keySize > request.length - 5 || !request.subarray(5, 5 + keySize).equals(descriptor.publicKey)) return socket.write(frame(Buffer.from([5])));
            request = Buffer.concat([Buffer.from([13]), str(descriptor.agentKey || descriptor.publicKey), request.subarray(5 + keySize)]);
          } else if (request[0] !== 27) return socket.write(frame(Buffer.from([5])));
          if (descriptor.agentPath === 'pageant') socket.write(frame(await richiestaAgente(source, request, 15000)));
          else upstream.write(frame(request));
        }).catch(() => socket.destroy());
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(agentPath, resolve); });
  if (process.platform !== 'win32') fs.chmodSync(agentPath, 0o600);
  return { agentPath, close: () => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); } };
}

async function apriTunnelNativo(descriptor, options) {
  const { host, username, target, hostKey } = options;
  const port = Number(options.port || 22), localPort = Number(options.localPort || 0);
  if (typeof host !== 'string' || !host.length || host.startsWith('-') || /[\s\0]/.test(host)) throw new Error('Host SSH non valido.');
  if (typeof username !== 'string' || !username.length || /[\r\n\0]/.test(username)) throw new Error('Utente SSH non valido.');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(localPort) || localPort < 0 || localPort > 65535) throw new Error('Porta SSH non valida.');
  if (!target || typeof target.host !== 'string' || !target.host.length || /[\[\]\s\0]/.test(target.host) || !Number.isInteger(Number(target.port)) || Number(target.port) < 1 || Number(target.port) > 65535) throw new Error('Destinazione del tunnel SSH non valida.');
  const parsedHost = utils.parseKey(hostKey);
  if (parsedHost instanceof Error || !Buffer.isBuffer(hostKey)) throw new Error('Manca la chiave del server SSH verificata.');
  const temp = temporary(); let child, bridge, cleanupPromise, closePromise, childClosed = false, alive = false, lastError = null;
  const cleanup = () => cleanupPromise ||= (async () => { await bridge?.close(); temp.close(); })();
  try {
    const identityPath = temp.write('identity', descriptor.identity);
    const knownHosts = temp.write('known_hosts', `codedb-pinned ${parsedHost.type} ${hostKey.toString('base64')}\n`);
    const env = ambienteAskpass(temp, descriptor.passphrase, descriptor.securityKeyPin);
    const actualPort = localPort || await portaLibera();
    const hostAlgorithms = parsedHost.type === 'ssh-rsa' ? 'rsa-sha2-512,rsa-sha2-256,ssh-rsa' : parsedHost.type;
    const targetHost = net.isIP(target.host) === 6 ? `[${target.host}]` : target.host;
    const args = ['-F', 'none', '-N', '-T', '-v', '-p', String(port), '-l', username, '-i', identityPath,
      '-L', `127.0.0.1:${actualPort}:${targetHost}:${target.port}`,
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ForwardAgent=no', '-o', 'IdentitiesOnly=yes',
      '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'NumberOfPasswordPrompts=1', '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlias=codedb-pinned',
      '-o', 'CheckHostIP=no', '-o', 'VerifyHostKeyDNS=no', '-o', 'UpdateHostKeys=no',
      '-o', `UserKnownHostsFile=${optionPath(knownHosts)}`, '-o', `GlobalKnownHostsFile=${optionPath(knownHosts)}`,
      '-o', `HostKeyAlgorithms=${hostAlgorithms}`, '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      '-o', `ConnectTimeout=${Math.ceil((options.timeoutMs || 20000) / 1000)}`];
    if (descriptor.certificate) {
      const certificatePath = temp.write('identity-cert.pub', descriptor.certificate);
      args.push('-o', `CertificateFile=${optionPath(certificatePath)}`);
      // Un certificato selezionato non deve autenticare con la chiave semplice come ripiego.
      args.push('-o', 'PubkeyAcceptedAlgorithms=' + (descriptor.baseType === 'ssh-rsa'
        ? 'rsa-sha2-512-cert-v01@openssh.com,rsa-sha2-256-cert-v01@openssh.com,ssh-rsa-cert-v01@openssh.com' : descriptor.type));
    }
    let agentPath = descriptor.agentPath;
    if (agentPath === 'pageant' || descriptor.certificate) { bridge = await ponteAgente(descriptor, temp); agentPath = bridge.agentPath; }
    args.push('-o', `IdentityAgent=${agentPath ? optionPath(agentPath) : 'none'}`);
    args.push('--', host);
    await new Promise((resolve, reject) => {
      let detail = '', settled = false, listening = false, polling = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timeout); clearInterval(interval); error ? reject(error) : resolve(); };
      child = spawn('ssh', args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      const timeout = setTimeout(() => { lastError = new Error('Timeout della connessione OpenSSH: verifica agente, passphrase e conferma sul dispositivo FIDO.'); child.kill(); }, options.timeoutMs || 20000);
      const interval = setInterval(() => {
        if (!listening || polling || child.exitCode !== null) return;
        polling = true;
        const probe = net.connect({ host: '127.0.0.1', port: actualPort });
        probe.setTimeout(500, () => probe.destroy());
        probe.once('connect', () => { probe.destroy(); alive = true; finish(); });
        probe.once('error', () => {});
        probe.once('close', () => { polling = false; });
      }, 50);
      child.stderr.on('data', chunk => {
        detail = (detail + chunk.toString()).slice(-8000);
        if (/Local forwarding listening on 127\.0\.0\.1 port/.test(detail)) listening = true;
      });
      child.once('error', error => { lastError = messaggioErrore(detail, error.code); finish(lastError); });
      child.once('close', code => {
        childClosed = true; alive = false;
        if (!closePromise) lastError ||= messaggioErrore(detail, code);
        finish(lastError || new Error('La connessione OpenSSH è stata chiusa.'));
        cleanup().catch(() => {});
      });
    });
    return {
      host: '127.0.0.1', port: actualPort,
      get alive() { return alive; }, get lastError() { return lastError?.message || null; },
      close() {
        if (closePromise) return closePromise;
        closePromise = new Promise(resolve => {
          if (!child || childClosed) return cleanup().then(resolve);
          child.once('close', () => cleanup().then(resolve)); child.kill();
        });
        return closePromise;
      },
    };
  } catch (error) {
    if (child && child.exitCode === null) child.kill();
    await cleanup();
    throw error;
  }
}

module.exports = { apriTunnelNativo, validaIdentitaNativa, rispostaAskpass };

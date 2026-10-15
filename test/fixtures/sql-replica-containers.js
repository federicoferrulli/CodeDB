'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { MongoClient } = require('mongodb');
const ports = [27039, 27040, 27041], label = 'codedb.test=sql-replica';
const name = port => `codedb-sql-node-${port}`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, windowsHide: true }).trim();
const action = process.argv[2];
(async () => {
  assert.ok(['start', 'stop'].includes(action), 'Usare start oppure stop.');
  if (action === 'stop') {
    for (const port of ports) {
      const info = JSON.parse(docker(['inspect', name(port)]))[0];
      assert.equal(info.Config.Labels['codedb.test'], 'sql-replica');
      docker(['rm', '-f', '-v', name(port)]);
    }
    return;
  }
  for (const port of ports) docker(['run', '-d', '--name', name(port), '--label', label,
    '-p', `127.0.0.1:${port}:${port}`, 'mongo:8.0', 'mongod', '--replSet', 'codedbtest', '--bind_ip_all', '--port', String(port), '--oplogSize', '128']);
  for (const port of ports) {
    const node = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 1000 });
    try {
      for (let attempt = 0; ; attempt++) {
        try { await node.db('admin').command({ ping: 1 }); break; }
        catch (error) { if (attempt === 30) throw error; await delay(500); }
      }
    } finally { await node.close(); }
  }
  const client = new MongoClient('mongodb://127.0.0.1:27039/?directConnection=true', { serverSelectionTimeoutMS: 3000 });
  try {
    for (let attempt = 0; ; attempt++) {
      try { await client.connect(); break; } catch (error) { if (attempt === 15) throw error; await delay(500); }
    }
    await client.db('admin').command({ replSetInitiate: { _id: 'codedbtest', members: ports.map((port, _id) => ({ _id, host: `host.docker.internal:${port}` })), settings: { electionTimeoutMillis: 1500 } } });
    for (let attempt = 0; ; attempt++) {
      const status = await client.db('admin').command({ replSetGetStatus: 1 });
      if (status.members.length === 3 && status.members.every(m => m.health === 1 && [1, 2].includes(m.state))) break;
      if (attempt === 90) throw new Error('Replica set non pronto.');
      await delay(500);
    }
    console.log('Replica set pronto: tre container, processi e volumi distinti; porte solo sul loopback.');
  } finally { await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
// Diagnostica locale: non scrive né stampa mai il valore di un segreto.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const git = (args, input) => execFileSync('git', args, { input, maxBuffer: 128 * 1024 * 1024 });
const regole = [
  ['chiave-privata', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]{40,}?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['token-github', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/g],
  ['access-key-aws', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['api-key-google', /\bAIza[\w-]{35}\b/g],
  ['token-slack', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['api-key-openai', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/g],
  ['token-npm', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['webhook-slack', /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]{8,}\/[A-Z0-9]{8,}\/[A-Za-z0-9]{20,}/g],
];
const risultati = [];
function analizza(buf, file, ambito, blob) {
  if (buf.includes(0)) return;
  const testo = buf.toString('utf8');
  for (const [regola, re] of regole) {
    re.lastIndex = 0;
    for (const m of testo.matchAll(re)) risultati.push({ ambito, file, blob, regola, riga: testo.slice(0, m.index).split('\n').length });
  }
}
const nomi = git(['rev-list', '--objects', '--all']).toString().split('\n').flatMap(line => {
  const space = line.indexOf(' ');
  if (space < 0) return [];
  const file = line.slice(space + 1);
  if (!/(?:\.(?:js|cjs|mjs|ts|tsx|json|jsonl|yml|yaml|md|txt|ini|conf|toml|xml|properties|pem|key|env|sh|ps1)|(?:^|\/)\.env[^/]*)$/i.test(file)) return [];
  return [{ id: line.slice(0, space), file }];
});
const perId = new Map(nomi.map(n => [n.id, n.file]));
const metadata = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], [...perId.keys()].join('\n') + '\n').toString().trim().split('\n');
const blobs = metadata.map(l => l.split(' ')).filter(([, type, size]) => type === 'blob' && Number(size) < 12 * 1024 * 1024);
let bytes = 0;
for (let start = 0; start < blobs.length; start += 30) {
  const ids = blobs.slice(start, start + 30).map(b => b[0]);
  const data = git(['cat-file', '--batch'], ids.join('\n') + '\n');
  let offset = 0;
  for (const id of ids) {
    const end = data.indexOf(10, offset);
    const size = Number(data.subarray(offset, end).toString().split(' ')[2]);
    const content = data.subarray(end + 1, end + 1 + size);
    analizza(content, perId.get(id), 'cronologia', id);
    bytes += size; offset = end + size + 2;
  }
}
const current = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean);
let letti = 0;
for (const file of [...new Set([...current, '.env'])]) {
  if (!/\.(js|cjs|mjs|ts|tsx|json|jsonl|yml|yaml|md|txt|ini|conf|toml|xml|properties|pem|key|env|sh|ps1)$/i.test(file) && file !== '.env') continue;
  if (/^(test-reports|\.scratch)\//.test(file)) continue;
  if (!fs.existsSync(file) || fs.statSync(file).size > 12 * 1024 * 1024) continue;
  analizza(fs.readFileSync(file), file, 'checkout'); letti++;
}
const report = { commitLocali: Number(git(['rev-list', '--all', '--count']).toString()), blobTestuali: blobs.length, byteAnalizzati: bytes, fileCheckout: letti, risultati };
fs.writeFileSync('test-reports/preproduzione-2026-10-12/segreti-scan.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, risultati: risultati.slice(0, 30), totaleCorrispondenze: risultati.length }));

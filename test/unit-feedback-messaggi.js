'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('@babel/parser');

module.exports = (async () => {
  const file = path.join(__dirname, '../public/js/avvisi.js');
  let source = fs.readFileSync(file, 'utf8');
  if (process.argv.includes('--mutant')) source = source.replace('if (isError) return notifica(msg);', 'if (false) return notifica(msg);');
  const saved = Object.fromEntries(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    const received = [];
    const parentEvents = [];
    const document = { querySelector: () => ({}), dispatchEvent: event => received.push(event) };
    globalThis.document = document;
    globalThis.window = { document };
    const { toast, notifica, chiudiNotifica } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    toast('Salvato');
    assert.equal(received.pop().type, 'codedb:toast');
    toast('Errore recuperabile', true);
    const error = received.pop();
    assert.equal(error.type, 'codedb:feedback', 'Gli errori non devono tornare al toast temporizzato');
    assert.equal(error.detail.message, 'Errore recuperabile');
    assert.equal(error.detail.duration, undefined);
    notifica('Campo non valido', { tipo: 'inline', target: '#nome' });
    assert.equal(received.pop().detail.target, '#nome');
    window.frameElement = { codedbPanel: true };
    window.parent = { document: { dispatchEvent: event => parentEvents.push(event) } };
    notifica('Errore nel pannello', { id: 'operazione' });
    assert.equal(parentEvents[0].detail.document, document, 'Il feedback conserva il documento d’origine');
    chiudiNotifica('operazione');
    assert.equal(parentEvents[1].detail.id, 'operazione');
    window.frameElement.hidden = true;
    notifica('Pannello nascosto');
    assert.equal(parentEvents.length, 2, 'Un pannello nascosto non interrompe quello attivo');
    delete globalThis.window;
    delete globalThis.document;
    notifica('Senza DOM'); chiudiNotifica('operazione');
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
  // Impedisce di reintrodurre il vecchio canale nei flussi già migrati.
  for (const file of fs.readdirSync(path.join(__dirname, '../public/js')).filter(name => name.endsWith('.js') && name !== 'avvisi.js')) {
    const ast = parse(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), { sourceType: 'module' });
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && ['toast', 'showToast'].includes(node.callee.name)) {
        const severity = node.arguments[1];
        assert(!severity || severity.type === 'BooleanLiteral' && severity.value === false || severity.type === 'StringLiteral' && ['info', 'success'].includes(severity.value), `${file}:${node.loc.start.line}: errore o avviso ancora affidato a un toast`);
      }
      for (const [key, value] of Object.entries(node)) {
        if (['loc', 'comments', 'tokens'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
      }
    }
    visit(ast);
  }
  console.log('OK feedback: canali distinti, pannelli isolati, assenza DOM e nessun toast di errore nei chiamanti');
})();
if (require.main === module) module.exports.catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const TAG_DATI = '<script type="application/json" id="graph-data">';

function richiedi(condizione, messaggio) {
  if (!condizione) throw new Error(messaggio);
}

function oggetto(valore) {
  return valore !== null && typeof valore === 'object' && !Array.isArray(valore);
}

function testo(valore) {
  return typeof valore === 'string' && valore.trim().length > 0;
}

// JSON.parse accetta due chiavi identiche e conserva solo l'ultima. Rilevale
// anche nel dizionario dei nodi prima che un ID sovrascritto venga pubblicato.
function leggiGrafo(json) {
  const grafo = JSON.parse(json);
  const oggetti = [];
  for (const token of json.matchAll(/"(?:\\.|[^"\\])*"(\s*:)?|[{}]/g)) {
    if (token[0] === '{') oggetti.push(new Set());
    else if (token[0] === '}') oggetti.pop();
    else if (token[1]) {
      const chiave = JSON.parse(token[0].slice(0, -token[1].length));
      const chiavi = oggetti.at(-1);
      richiedi(!chiavi.has(chiave), `Chiave JSON duplicata: ${chiave}`);
      chiavi.add(chiave);
    }
  }
  return grafo;
}

function capitoliGuida(markdown) {
  const capitoli = new Set();
  const usati = new Set();
  let recinzione;
  for (const riga of markdown.split(/\r?\n/)) {
    const blocco = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(riga);
    if (blocco) {
      if (!recinzione) recinzione = blocco[1];
      else if (blocco[1].startsWith(recinzione) && !blocco[2].trim()) recinzione = null;
      continue;
    }
    if (recinzione) continue;
    const titolo = /^ {0,3}(#{1,6})\s+(.+)$/.exec(riga);
    if (!titolo) continue;
    const nome = titolo[2].replace(/\s+#+\s*$/, '').trim();
    const base = nome.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_ -]/gu, '').replace(/ /g, '-');
    let anchor = base;
    for (let i = 1; usati.has(anchor); i++) anchor = `${base}-${i}`;
    usati.add(anchor);
    if (titolo[1] === '##' && nome !== 'Indice') capitoli.add(anchor);
  }
  return capitoli;
}

function nelRepository(radice, destinazione) {
  const relativo = path.relative(radice, destinazione);
  return !path.isAbsolute(relativo) && relativo !== '..' && !relativo.startsWith('..' + path.sep);
}

function verificaPercorso(radice, riferimento) {
  richiedi(!riferimento.includes('\\') && !path.isAbsolute(riferimento) &&
    !/^[a-z][\w+.-]*:/i.test(riferimento), `Percorso non relativo al repository: ${riferimento}`);
  const destinazione = path.resolve(radice, riferimento);
  richiedi(nelRepository(radice, destinazione), `Percorso fuori dal repository: ${riferimento}`);
  richiedi(fs.existsSync(destinazione), `Riferimento inesistente: ${riferimento}`);
  richiedi(nelRepository(radice, fs.realpathSync(destinazione)), `Collegamento fuori dal repository: ${riferimento}`);
  const info = fs.statSync(destinazione);
  richiedi(info.isFile() || info.isDirectory(), `Riferimento non valido: ${riferimento}`);
}

function validaGrafo(grafo, radiceRepo = ROOT) {
  const radice = fs.realpathSync(radiceRepo);
  richiedi(oggetto(grafo) && grafo.schemaVersion === 1, 'Versione del grafo non supportata.');
  richiedi(grafo.guide === 'ELEPHANT.md' && grafo.root === 'codedb', 'Guida o radice del grafo non valida.');
  richiedi(oggetto(grafo.agent) && oggetto(grafo.nodes) && oggetto(grafo.entrypoints) &&
    oggetto(grafo.relations) && Array.isArray(grafo.edges), 'Struttura del grafo incompleta.');
  const nodi = grafo.nodes;
  const haNodo = id => testo(id) && Object.hasOwn(nodi, id);
  richiedi(haNodo(grafo.root) && nodi[grafo.root]?.kind === 'root', 'Nodo radice mancante.');
  richiedi(Object.hasOwn(grafo.relations, 'contains') && Object.values(grafo.relations).every(testo),
    'Vocabolario delle relazioni incompleto.');

  verificaPercorso(radice, grafo.guide);
  const capitoli = capitoliGuida(fs.readFileSync(path.join(radice, grafo.guide), 'utf8'));
  const percorsi = new Set();
  const ancore = new Set();
  const tipiGenitore = { area: 'root', section: 'area', concept: 'section' };
  for (const [id, nodo] of Object.entries(nodi)) {
    richiedi(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && oggetto(nodo), `Nodo non valido: ${id}`);
    richiedi(id === grafo.root || Object.hasOwn(tipiGenitore, nodo.kind), `Tipo di nodo non valido: ${id}`);
    richiedi(testo(nodo.title) && testo(nodo.summary), `Titolo o sintesi mancante: ${id}`);
    for (const campo of ['rules', 'sources', 'tests']) {
      richiedi(Array.isArray(nodo[campo]) && nodo[campo].every(testo), `Campo ${campo} non valido: ${id}`);
    }
    for (const voce of [...nodo.sources, ...nodo.tests]) percorsi.add(voce);
    if (nodo.kind === 'section') {
      const anchor = String(nodo.anchor || '').replace(/^#/, '');
      richiedi(capitoli.has(anchor), `Capitolo della guida inesistente: ${id} (${anchor})`);
      richiedi(!ancore.has(anchor), `Capitolo duplicato: ${anchor}`);
      ancore.add(anchor);
    }
  }
  for (const voce of percorsi) verificaPercorso(radice, voce);
  for (const anchor of capitoli) richiedi(ancore.has(anchor), `Capitolo privo di sezione nel grafo: ${anchor}`);

  const archi = new Set();
  const genitori = new Map();
  for (const arco of grafo.edges) {
    richiedi(oggetto(arco) && haNodo(arco.from) && haNodo(arco.to), `Estremo di arco inesistente: ${JSON.stringify(arco)}`);
    const { from, rel, to } = arco;
    richiedi(Object.hasOwn(grafo.relations, rel), `Relazione sconosciuta: ${rel}`);
    const chiave = JSON.stringify([from, rel, to]);
    richiedi(!archi.has(chiave), `Arco duplicato: ${chiave}`);
    archi.add(chiave);
    if (rel !== 'contains') continue;
    richiedi(nodi[from].kind === tipiGenitore[nodi[to].kind], `Gerarchia contains non valida: ${from} → ${to}`);
    richiedi(!genitori.has(to), `Più genitori per il nodo: ${to}`);
    genitori.set(to, from);
  }

  // I soli salti ammessi sono root→area→section→concept. Un genitore per
  // ogni nodo diverso dalla radice garantisce anche raggiungibilità e assenza di cicli.
  for (const [id, nodo] of Object.entries(nodi)) {
    if (id === grafo.root) continue;
    const genitore = genitori.get(id);
    richiedi(genitore, `Nodo irraggiungibile dalla radice: ${id}`);
    if (nodo.kind === 'concept') {
      richiedi(nodo.section === genitore, `Sezione incoerente con contains: ${id}`);
      richiedi(nodo.area === undefined || nodo.area === genitori.get(genitore), `Area incoerente con contains: ${id}`);
    } else if (nodo.kind === 'section') {
      richiedi(nodo.area === genitore, `Area incoerente con contains: ${id}`);
    }
  }

  richiedi(Object.keys(grafo.entrypoints).length > 0, 'Nessun percorso di lettura.');
  for (const [id, percorso] of Object.entries(grafo.entrypoints)) {
    richiedi(oggetto(percorso) && testo(percorso.title) && Array.isArray(percorso.steps) &&
      percorso.steps.length > 0 && percorso.steps.every(haNodo), `Percorso di lettura non valido: ${id}`);
  }
}

function paginaSincronizzata(html, grafo) {
  const inizioTag = html.indexOf(TAG_DATI);
  richiedi(inizioTag >= 0 && inizioTag === html.lastIndexOf(TAG_DATI), 'Il tag graph-data deve essere presente una sola volta.');
  const inizioDati = inizioTag + TAG_DATI.length;
  const fineDati = html.indexOf('</script>', inizioDati);
  richiedi(fineDati >= 0, 'Tag graph-data privo di chiusura.');
  const dati = JSON.stringify(grafo).replace(/</g, '\\u003c');
  return html.slice(0, inizioDati) + dati + html.slice(fineDati);
}

function main(args) {
  const verifica = args.length === 1 && args[0] === '--check';
  richiedi(!args.length || verifica, 'Uso: node tools/sincronizza-elephant.cjs [--check]');
  const grafo = leggiGrafo(fs.readFileSync(path.join(ROOT, 'ELEPHANT.json'), 'utf8'));
  validaGrafo(grafo);
  const pagina = path.join(ROOT, 'ELEPHANT.html');
  const originale = fs.readFileSync(pagina, 'utf8');
  const aggiornata = paginaSincronizzata(originale, grafo);
  if (aggiornata !== originale) {
    richiedi(!verifica, 'Pagina non allineata. Esegui node tools/sincronizza-elephant.cjs');
    const temporaneo = `${pagina}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaneo, aggiornata, { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporaneo, pagina);
    } finally {
      fs.rmSync(temporaneo, { force: true });
    }
  }
  console.log(`Grafo e pagina allineati (${Object.keys(grafo.nodes).length} nodi, ${grafo.edges.length} relazioni).`);
}

module.exports = { leggiGrafo, validaGrafo, paginaSincronizzata };

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (errore) {
    console.error(errore.message);
    process.exitCode = 1;
  }
}

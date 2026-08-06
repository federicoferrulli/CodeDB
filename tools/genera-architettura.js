#!/usr/bin/env node
/**
 * Genera docs/architettura/architettura.html inlinando docs/architettura/architettura.json
 * dentro il template. La sorgente unica e il JSON: due copie scritte a mano dello stesso
 * modello divergerebbero alla prima correzione, ed e il difetto peggiore possibile qui
 * perche il diagramma resterebbe plausibile mentre descrive un'architettura che non c'e.
 *
 * Prima di generare, il modello viene VALIDATO: un arco verso un nodo inesistente o un
 * passo di flusso che non corrisponde ad alcun arco produrrebbero un percorso illuminato
 * a meta, che si nota solo cliccando quel flusso.
 *
 *   node tools/genera-architettura.js            genera
 *   node tools/genera-architettura.js --check    verifica soltanto (uso in npm test)
 */

const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..', 'docs', 'architettura');
const SORGENTE = path.join(BASE, 'architettura.json');
const TEMPLATE = path.join(BASE, 'architettura.template.html');
const USCITA = path.join(BASE, 'architettura.html');
const SEGNAPOSTO = '/*__DATI__*/ null';

function valida(m) {
  const errori = [];
  const nodi = new Set(m.nodes.map((n) => n.id));
  const gruppi = new Set(m.groups.map((g) => g.id));
  const archi = new Set(m.edges.map((e) => `${e.from}>${e.to}`));

  const visti = new Set();
  for (const n of m.nodes) {
    if (visti.has(n.id)) errori.push(`Nodo duplicato: ${n.id}`);
    visti.add(n.id);
    if (!gruppi.has(n.group)) errori.push(`Nodo "${n.id}": gruppo sconosciuto "${n.group}"`);
    for (const campo of ['label', 'file', 'sommario']) {
      if (!n[campo]) errori.push(`Nodo "${n.id}": campo "${campo}" mancante`);
    }
    if (typeof n.x !== 'number' || typeof n.y !== 'number') {
      errori.push(`Nodo "${n.id}": coordinate mancanti`);
    }
  }

  const idArchi = new Set();
  for (const e of m.edges) {
    if (idArchi.has(e.id)) errori.push(`Arco duplicato: ${e.id}`);
    idArchi.add(e.id);
    if (!nodi.has(e.from)) errori.push(`Arco "${e.id}": origine inesistente "${e.from}"`);
    if (!nodi.has(e.to)) errori.push(`Arco "${e.id}": destinazione inesistente "${e.to}"`);
  }

  for (const f of m.flows) {
    if (!f.steps || !f.steps.length) errori.push(`Flusso "${f.id}": nessun passo`);
    (f.steps || []).forEach((s, i) => {
      if (!nodi.has(s.from)) errori.push(`Flusso "${f.id}" passo ${i + 1}: nodo "${s.from}" inesistente`);
      if (!nodi.has(s.to)) errori.push(`Flusso "${f.id}" passo ${i + 1}: nodo "${s.to}" inesistente`);
      // Un passo senza arco corrispondente si illuminerebbe a meta: i nodi si
      // accenderebbero ma la linea fra loro no.
      if (!archi.has(`${s.from}>${s.to}`)) {
        errori.push(`Flusso "${f.id}" passo ${i + 1}: nessun arco ${s.from} -> ${s.to}`);
      }
    });
  }

  // Nodi isolati: non sono un errore, ma quasi sempre sono una dimenticanza.
  const collegati = new Set(m.edges.flatMap((e) => [e.from, e.to]));
  const isolati = [...nodi].filter((id) => !collegati.has(id));
  return { errori, isolati };
}

function main() {
  const soloVerifica = process.argv.includes('--check');
  const modello = JSON.parse(fs.readFileSync(SORGENTE, 'utf8'));
  const { errori, isolati } = valida(modello);

  if (isolati.length) console.warn(`Nodi isolati (nessun arco): ${isolati.join(', ')}`);
  if (errori.length) {
    console.error(`Modello non valido (${errori.length} problemi):`);
    for (const e of errori) console.error(`  - ${e}`);
    process.exit(1);
  }

  const template = fs.readFileSync(TEMPLATE, 'utf8');
  if (!template.includes(SEGNAPOSTO)) {
    console.error(`Segnaposto "${SEGNAPOSTO}" non trovato nel template.`);
    process.exit(1);
  }

  // </script> dentro una stringa JSON chiuderebbe il tag che la contiene.
  const json = JSON.stringify(modello, null, 2).replace(/<\//g, '<\\/');
  const html = template.replace(SEGNAPOSTO, json);

  if (soloVerifica) {
    const attuale = fs.existsSync(USCITA) ? fs.readFileSync(USCITA, 'utf8') : '';
    if (attuale.replace(/\r\n/g, '\n') !== html.replace(/\r\n/g, '\n')) {
      console.error('architettura.html non e allineato: esegui "node tools/genera-architettura.js".');
      process.exit(1);
    }
    console.log(`OK: modello valido (${modello.nodes.length} nodi, ${modello.edges.length} archi, ${modello.flows.length} flussi) e HTML allineato.`);
    return;
  }

  fs.writeFileSync(USCITA, html);
  console.log(`Scritto ${path.relative(process.cwd(), USCITA)} — ${modello.nodes.length} nodi, ${modello.edges.length} archi, ${modello.flows.length} flussi.`);
}

main();

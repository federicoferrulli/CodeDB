'use strict';

/**
 * CodeDB — La ricerca della palette (Ctrl+P), senza DOM.
 *
 * Qui c'è la sola decisione che conta quando si scrive nella casella: **quali
 * voci restano e in che ordine**. Stava dentro il disegno della lista, cioè in
 * mezzo a `innerHTML`, e per questo non era provabile senza un browser proprio
 * mentre diventava la parte che decide se un utente trova la sua tabella fra
 * migliaia.
 *
 * Nessun tetto sul numero di risultati: la lista è virtualizzata, quindi
 * troncare a trenta significherebbe soltanto nascondere la tabella cercata.
 *
 * Modulo puro, senza import: si carica in un test Node.
 */

/**
 * Il punteggio di un termine su un testo: 0 = comincia per, 1 = contiene,
 * 2 = sottosequenza (v-s-c-o-d-e trova VSCode), null = non corrisponde.
 * Senza termine tutto vale 3, cioè resta l'ordine di arrivo.
 */
export function punteggio(termine, testo) {
  if (!termine) return 3;
  const t = String(testo || '').toLowerCase();
  const q = String(termine).toLowerCase();
  if (t.startsWith(q)) return 0;
  if (t.includes(q)) return 1;
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return 2;
  }
  return null;
}

/**
 * Il testo su cui una voce viene cercata: nome e nota (per una tabella, il suo
 * database), più il TIPO — così «tabella users» e «users dropchecker» trovano
 * entrambi la stessa riga.
 *
 * Con un richiamo attivo il tipo si esclude: il tipo l'ha già detto il richiamo,
 * e lasciarlo dentro farebbe corrispondere `#base` a OGNI database (tutti
 * contengono «database» nel tipo), cioè un filtro che non filtra.
 */
export function testoDiVoce(voce, conTipo = true) {
  return `${voce.etichetta || ''} ${voce.nota || ''}${conTipo ? ` ${voce.tipo || ''}` : ''}`;
}

/**
 * I richiami: un carattere in testa dice CHE COSA si sta cercando, e la ricerca
 * si restringe a quel tipo di voce.
 *
 * Sono la stessa idea del `>` di VS Code, estesa ai due tipi che qui contano di
 * più: con le tabelle di tutti i database in elenco, cercare «users» senza poter
 * dire «una tabella» significa scorrere in mezzo a comandi e connessioni.
 */
export const RICHIAMI = Object.freeze({
  '>': 'Comando',
  '#': 'Database',
  '@': 'Tabella',
});

/**
 * Che cosa chiede il testo scritto: il tipo a cui restringersi (null = tutto) e
 * il termine da cercare, senza il richiamo.
 *
 * Un carattere che non è un richiamo resta parte del termine: un nome di
 * tabella può contenere qualunque cosa, e mangiarsi il primo carattere di una
 * ricerca legittima sarebbe peggio del richiamo mancato.
 */
export function interpreta(testo) {
  const scritto = String(testo || '').trimStart();
  const primo = scritto.charAt(0);
  const tipo = Object.prototype.hasOwnProperty.call(RICHIAMI, primo) ? RICHIAMI[primo] : null;
  if (!tipo) return { richiamo: '', tipo: null, termine: scritto.trim() };
  return { richiamo: primo, tipo, termine: scritto.slice(1).trim() };
}

/**
 * Le voci che sopravvivono a ciò che è stato scritto — richiamo compreso —
 * ordinate per merito e, a parità, per ordine di arrivo (i comandi prima dei
 * dati perché arrivano prima, non perché ci sia un ramo che li privilegia).
 *
 * L'ordinamento è stabile per costruzione: `ordine` è la posizione originale e
 * fa da secondo criterio, quindi non dipende dalla `sort` del motore.
 */
export function filtra(voci, testo) {
  const { tipo, termine } = interpreta(testo);
  const out = [];
  for (let i = 0; i < voci.length; i++) {
    const voce = voci[i];
    if (tipo && voce.tipo !== tipo) continue;
    const p = punteggio(termine, testoDiVoce(voce, !tipo));
    if (p !== null) out.push({ voce, ordine: i, p });
  }
  out.sort((a, b) => (a.p - b.p) || (a.ordine - b.ordine));
  return out.map((x) => x.voce);
}

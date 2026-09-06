/* ---------------------------------------------------------------------------
 * IL GESTO DI TRASCINARE UNA MANIGLIA, IN UN POSTO SOLO
 *
 * PERCHÉ ESISTE
 * L'applicazione aveva TRE ridimensionatori scritti tre volte: le maniglie
 * orizzontali (`main.js`, che serve barra connessioni, albero dei database e
 * Schema Browser della tab ⚡), quella verticale fra editor e risultati
 * (`query-tab.js`), e quella della Split-View (`splitview.js`). Solo la terza
 * era stata portata a Pointer Events; le altre due ascoltavano `mousedown` e
 * `mousemove`, e un evento di mouse **non arriva da un dito né da una penna**.
 * Su un dispositivo tattile — che questa applicazione dichiara di supportare,
 * con tanto di regole `pointer: coarse` e di test con eventi touch nativi — la
 * barra laterale e il pannello dell'editor semplicemente non si potevano
 * ridimensionare. Non c'era alcun messaggio: la maniglia si vedeva, mostrava il
 * cursore giusto, e non rispondeva.
 *
 * Le due copie avevano anche un secondo difetto in comune: senza
 * `setPointerCapture`, un trascinamento veloce che esce dalla maniglia perde gli
 * eventi, perché arrivano all'elemento sotto il puntatore.
 *
 * COSA STA QUI E COSA NO
 * Qui c'è il GESTO: quale pulsante conta, la cattura del puntatore, la classe
 * `dragging`, la fine anche per annullamento. Non c'è che cosa il gesto
 * SIGNIFICHI — una larghezza, un'altezza, delle quote — perché è lì che i tre
 * chiamanti divergono davvero, e assorbirlo qui vorrebbe dire un'interfaccia
 * piena di rami. Il chiamante riceve lo spostamento e decide.
 * ------------------------------------------------------------------------- */

/**
 * Rende `maniglia` trascinabile con mouse, dito o penna.
 *
 * @param {HTMLElement} maniglia
 * @param {object} opzioni
 * @param {'x'|'y'} [opzioni.asse]   asse dello spostamento riportato
 * @param {() => any} opzioni.inizio  fotografa lo stato di partenza; il valore
 *                                    tornato viene ripassato a `sposta`
 * @param {(delta: number, partenza: any, ev: PointerEvent) => void} opzioni.sposta
 * @param {(partenza: any) => void} [opzioni.fine]
 */
export function rendiTrascinabile(maniglia, { asse = 'x', inizio, sposta, fine }) {
  if (!maniglia) return;
  // Senza questo il browser interpreta il trascinamento come uno scorrimento
  // della pagina e annulla il puntatore a metà gesto. È l'equivalente, per il
  // dito, di `preventDefault` sul mousedown.
  maniglia.style.touchAction = 'none';

  const coord = (e) => (asse === 'x' ? e.clientX : e.clientY);
  let partenza = null;
  let origine = 0;

  maniglia.addEventListener('pointerdown', (e) => {
    // `e.button` vale 0 anche per il tocco; si escludono solo destro e centrale.
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    origine = coord(e);
    partenza = inizio ? inizio(e) : null;
    // La cattura è ciò che tiene gli eventi sulla maniglia anche quando il
    // puntatore ne esce: senza, un trascinamento veloce si interrompe.
    try { maniglia.setPointerCapture(e.pointerId); } catch { /* puntatore già sparito */ }
    maniglia.classList.add('dragging');
  });

  maniglia.addEventListener('pointermove', (e) => {
    if (partenza === undefined) return;
    if (!maniglia.classList.contains('dragging')) return;
    sposta(coord(e) - origine, partenza, e);
  });

  const termina = (e) => {
    if (!maniglia.classList.contains('dragging')) return;
    maniglia.classList.remove('dragging');
    if (fine) fine(partenza);
    partenza = null;
    try { maniglia.releasePointerCapture(e.pointerId); } catch { /* già rilasciato */ }
  };
  maniglia.addEventListener('pointerup', termina);
  // `pointercancel` arriva quando il sistema si riprende il puntatore (una
  // gesture del sistema operativo, una chiamata in arrivo): senza, la maniglia
  // resterebbe in stato `dragging` per sempre.
  maniglia.addEventListener('pointercancel', termina);
}

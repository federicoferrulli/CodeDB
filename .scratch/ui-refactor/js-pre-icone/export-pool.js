'use strict';

/**
 * Esegue un lavoro asincrono su una lista con concorrenza limitata e restituisce
 * i risultati nello stesso ordine degli elementi. Al primo errore non assegna
 * altro lavoro, ma attende quello gia' partito prima di rigettare: il chiamante
 * non resta cosi' con richieste asincrone orfane ancora in volo.
 */
export async function eseguiInParalleloOrdinato(elementi, lavoro, limite = 3) {
  const lista = Array.from(elementi || []);
  const risultati = new Array(lista.length);
  if (!lista.length) return risultati;

  const concorrenza = Math.max(1, Math.min(lista.length, Math.floor(Number(limite)) || 1));
  let prossimo = 0;
  let fallito = false;
  let primoErrore;

  async function esegui() {
    for (;;) {
      if (fallito) return;
      const indice = prossimo++;
      if (indice >= lista.length) return;
      try {
        risultati[indice] = await lavoro(lista[indice], indice);
      } catch (err) {
        if (!fallito) primoErrore = err;
        fallito = true;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: concorrenza }, () => esegui()));
  if (fallito) throw primoErrore;
  return risultati;
}

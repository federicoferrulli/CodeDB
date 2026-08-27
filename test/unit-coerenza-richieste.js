'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

module.exports = (async () => {
  const {
    CacheGenerazionale, RegistroGenerazioni, chiudiCaricamento, congelaContesto, contestoCorrente,
  } = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'coerenza-richieste.js')).href
  );

  console.log('--- Test unitari coerenza temporale delle richieste ---');

  const originale = { tabId: 't1', db: 'db1', coll: 'ordini', filtro: { stato: 'aperto' }, pagina: 0 };
  const congelato = congelaContesto(originale);
  originale.coll = 'clienti';
  originale.filtro.stato = 'chiuso';
  assert.deepStrictEqual(congelato, {
    tabId: 't1', db: 'db1', coll: 'ordini', filtro: { stato: 'aperto' }, pagina: 0,
  });
  assert.ok(Object.isFrozen(congelato) && Object.isFrozen(congelato.filtro));
  assert.strictEqual(contestoCorrente(
    { generazioneRichiesta: 2, db: 'nuovo', coll: 'clienti' },
    { generazioneRichiesta: 1, db: 'vecchio' },
  ), false, 'una risposta del vecchio database non può ritargettare il riquadro');
  const caricamento = { loading: true, gridLoadingRunId: 'pagina-vecchia' };
  assert.strictEqual(chiudiCaricamento(caricamento, 'altra-pagina'), false);
  assert.strictEqual(caricamento.loading, true, 'una risposta diversa non spegne il caricamento corrente');
  assert.strictEqual(chiudiCaricamento(caricamento, 'pagina-vecchia'), true);
  assert.strictEqual(caricamento.loading, false, 'la pagina obsoleta chiude soltanto il proprio indicatore');

  const registro = new RegistroGenerazioni();
  const prima = registro.nuova('griglia:t1', congelato);
  assert.strictEqual(registro.corrente(prima), true);
  const seconda = registro.nuova('griglia:t1', { ...congelato, coll: 'clienti' });
  assert.strictEqual(registro.corrente(prima), false, 'la nuova lettura invalida quella in volo');
  assert.strictEqual(registro.corrente(seconda), true);
  registro.invalida('griglia:t1');
  assert.strictEqual(registro.corrente(seconda), false, 'l\'invalidazione rende obsoleta anche l\'ultima risposta');

  const schemaA = registro.nuova('schema:t1:db1', { tabId: 't1', db: 'db1' });
  const schemaB = registro.nuova('schema:t2:db1', { tabId: 't2', db: 'db1' });
  registro.invalidaSe((chiave) => chiave.endsWith(':db1'));
  assert.strictEqual(registro.corrente(schemaA), false);
  assert.strictEqual(registro.corrente(schemaB), false);

  let risolviPrima;
  let caricamenti = 0;
  const cache = new CacheGenerazionale(async () => {
    caricamenti++;
    if (caricamenti === 1) return new Promise((resolve) => { risolviPrima = resolve; });
    return { versione: 2 };
  });
  const vecchia = cache.ottieni('t1::db1');
  assert.strictEqual(cache.ottieni('t1::db1'), vecchia, 'single-flight per la stessa generazione');
  await Promise.resolve();
  cache.invalida('t1::db1');
  const nuova = cache.ottieni('t1::db1');
  risolviPrima({ versione: 1 });
  assert.deepStrictEqual(await nuova, { versione: 2 });
  assert.deepStrictEqual(await vecchia, { versione: 1 }, 'chi attende riceve comunque la propria risposta');
  assert.deepStrictEqual(cache.leggi('t1::db1'), { versione: 2 },
    'la risposta vecchia non ripopola la cache dopo l\'invalidazione');

  console.log('  OK   contesto immutabile e generazioni monotone');
})();

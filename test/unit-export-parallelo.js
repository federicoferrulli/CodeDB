'use strict';

/* ---------------------------------------------------------------------------
 * Export di database: le collezioni vengono elaborate con concorrenza limitata
 * ma il loro testo resta nello stesso ordine restituito da db:collections.
 * Se un lavoro fallisce, quelli gia' partiti vengono attesi e non ne partono
 * altri: cosi' exportDatabase puo' mostrare un solo errore senza lasciare
 * richieste Socket.IO orfane in volo.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const modulo = (nome) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', nome)).href;
const prossimoTurno = () => new Promise((resolve) => setImmediate(resolve));

function differita() {
  let resolve;
  let reject;
  const promise = new Promise((ok, ko) => { resolve = ok; reject = ko; });
  return { promise, resolve, reject };
}

module.exports = (async () => {
  const { eseguiInParalleloOrdinato } = await import(modulo('export-pool.js'));

  {
    const nomi = ['clienti', 'ordini', 'prodotti', 'fatture', 'spedizioni'];
    const attese = new Map(nomi.map((nome) => [nome, differita()]));
    const partite = [];
    let attive = 0;
    let massimo = 0;

    const esecuzione = eseguiInParalleloOrdinato(nomi, async (nome) => {
      partite.push(nome);
      attive++;
      massimo = Math.max(massimo, attive);
      await attese.get(nome).promise;
      attive--;
      return nome.toUpperCase();
    }, 3);

    await prossimoTurno();
    assert.deepStrictEqual(partite, nomi.slice(0, 3),
      'devono partire subito tre collezioni, ma non la quarta');
    assert.strictEqual(massimo, 3, 'il pool deve sfruttare tutti e tre i posti');

    attese.get('prodotti').resolve();
    await prossimoTurno();
    assert.deepStrictEqual(partite, nomi.slice(0, 4),
      'liberato un posto deve partire la collezione successiva');

    attese.get('clienti').resolve();
    await prossimoTurno();
    assert.deepStrictEqual(partite, nomi,
      'il secondo posto liberato deve far partire l\'ultima collezione');

    attese.get('spedizioni').resolve();
    attese.get('fatture').resolve();
    attese.get('ordini').resolve();
    assert.deepStrictEqual(await esecuzione, nomi.map((nome) => nome.toUpperCase()),
      'il risultato deve seguire l\'ordine delle collezioni, non quello di completamento');
    assert.strictEqual(massimo, 3, 'non devono esserci piu\' di tre lavori attivi');
  }

  {
    const attese = new Map([
      ['prima', differita()],
      ['seconda', differita()],
    ]);
    const partite = [];
    let terminata = false;

    const esecuzione = eseguiInParalleloOrdinato(
      ['prima', 'seconda', 'terza', 'quarta'],
      async (nome) => {
        partite.push(nome);
        await attese.get(nome).promise;
        return nome;
      },
      2,
    );
    esecuzione.then(() => { terminata = true; }, () => { terminata = true; });

    await prossimoTurno();
    attese.get('prima').reject(new Error('rete interrotta'));
    await prossimoTurno();
    assert.strictEqual(terminata, false,
      'l\'errore non deve chiudere il pool mentre una richiesta gia\' partita e\' in volo');
    assert.deepStrictEqual(partite, ['prima', 'seconda'],
      'dopo il primo errore non devono partire altre collezioni');

    attese.get('seconda').resolve();
    await assert.rejects(esecuzione, /rete interrotta/);
    assert.deepStrictEqual(partite, ['prima', 'seconda'],
      'il drenaggio delle richieste attive non deve avviare nuovo lavoro');
  }

  console.log('  OK   export database: massimo tre collezioni, ordine stabile e errori drenati');
})();

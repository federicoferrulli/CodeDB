'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { prepareValue } = require('pg/lib/utils');
const confini = require('../backup/lib/confine-sql');

// Gli istanti attesi sono espliciti: il test non deriva il risultato usando
// le stesse conversioni locali che hanno causato il difetto nell'incrementale.
const istanti = [
  ['inizio ora legale Roma, prima', '2026-03-29T00:59:59.750Z', '2026-03-29T00:59:57.750Z'],
  ['inizio ora legale Roma, dopo', '2026-03-29T01:00:00.250Z', '2026-03-29T00:59:58.250Z'],
  ['fine ora legale Roma, prima', '2026-10-25T00:59:59.750Z', '2026-10-25T00:59:57.750Z'],
  ['fine ora legale Roma, dopo', '2026-10-25T01:00:00.250Z', '2026-10-25T00:59:58.250Z'],
  ['inizio ora legale New York, prima', '2026-03-08T06:59:59.750Z', '2026-03-08T06:59:57.750Z'],
  ['inizio ora legale New York, dopo', '2026-03-08T07:00:00.250Z', '2026-03-08T06:59:58.250Z'],
  ['fine ora legale New York, prima', '2026-11-01T05:59:59.750Z', '2026-11-01T05:59:57.750Z'],
  ['fine ora legale New York, dopo', '2026-11-01T06:00:00.250Z', '2026-11-01T05:59:58.250Z'],
  ['margine che attraversa la mezzanotte UTC', '2026-10-22T00:00:00.250Z', '2026-10-21T23:59:58.250Z'],
];
const pgSenzaFuso = "($1::timestamptz AT TIME ZONE 'UTC')";
const tipiPostgres = [
  ['timestamp without time zone', '>', pgSenzaFuso],
  ['timestamp(0) without time zone', '>', pgSenzaFuso],
  ['timestamp(6) without time zone', '>', pgSenzaFuso],
  ['timestamp', '>', pgSenzaFuso],
  ['timestamp(0)', '>', pgSenzaFuso],
  ['timestamp(6)', '>', pgSenzaFuso],
  ['timestamp with time zone', '>', '$1::timestamptz'],
  ['timestamp(0) with time zone', '>', '$1::timestamptz'],
  ['timestamp(6) with time zone', '>', '$1::timestamptz'],
  ['timestamptz', '>', '$1::timestamptz'],
  ['timestamptz(0)', '>', '$1::timestamptz'],
  ['timestamptz(6)', '>', '$1::timestamptz'],
  ['  TIMESTAMP(6)   WITHOUT TIME ZONE  ', '>', pgSenzaFuso],
  ['date', '>=', `${pgSenzaFuso}::date`],
];
const tipiMySql = [
  ['datetime', '>', 'FROM_UNIXTIME(?)'], ['datetime(0)', '>', 'FROM_UNIXTIME(?)'],
  ['datetime(6)', '>', 'FROM_UNIXTIME(?)'], ['timestamp', '>', 'FROM_UNIXTIME(?)'],
  ['timestamp(0)', '>', 'FROM_UNIXTIME(?)'], ['timestamp(6)', '>', 'FROM_UNIXTIME(?)'],
  [' DATE ', '>=', 'DATE(FROM_UNIXTIME(?))'],
];

function eseguiNelFuso() {
  const originale = confini.confinePostgres;
  const mysqlOriginale = confini.confineMySql;
  // Il vecchio confronto lasciava al driver la Date e al server il cast
  // implicito: riattivarlo soltanto in memoria deve produrre un rosso preciso.
  if (process.argv.includes('--mutant')) confini.confinePostgres = (type, boundary) => ({
    ...originale(type, boundary), expression: '$1', parameter: new Date(boundary),
  });
  if (process.argv.includes('--mutant-date')) {
    const esclusivo = fn => (type, boundary) => {
      const result = fn(type, boundary);
      return String(type).trim().toLowerCase() === 'date' ? { ...result, operator: '>' } : result;
    };
    confini.confinePostgres = esclusivo(originale);
    confini.confineMySql = esclusivo(mysqlOriginale);
  }
  const risultati = [];
  try {
    const zona = process.env.TZ;
    const offsetAttesi = { UTC: [0, 0], 'Europe/Rome': [-60, -120], 'America/New_York': [300, 240] };
    const offsets = ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z'].map(value => new Date(value).getTimezoneOffset());
    assert.deepEqual(offsets, offsetAttesi[zona], `Il processo figlio deve usare davvero il fuso ${zona}`);
    for (const [nome, since, arretrato] of istanti) {
      for (const margine of [0, 2000]) {
        // L'engine applica già il margine prima di chiamare l'helper. Qui si
        // verifica che il confine ricevuto non venga arretrato o troncato ancora.
        const atteso = margine ? arretrato : since;
        const boundary = new Date(Date.parse(since) - margine);
        assert.equal(boundary.toISOString(), atteso, 'Fixture del margine coerente');
        for (const ingresso of [boundary, boundary.toISOString()]) {
          const prima = boundary.getTime();
          for (const [type, operator, expression] of tipiPostgres) {
            const result = confini.confinePostgres(type, ingresso);
            const contesto = `${zona}, ${nome}, margine ${margine}, ${type}`;
            assert.equal(typeof result.parameter, 'string', `[PG-CONFINE-ISO] ${contesto}: il parametro deve essere ISO UTC, mai una Date del driver`);
            assert.equal(result.parameter, atteso, `${contesto}: conservare istante e millisecondi anche su precisione 0/6`);
            assert.equal(result.expression, expression, `[PG-CONFINE-CAST] ${contesto}: confronto esplicito guidato dal tipo`);
            assert.equal(result.operator, operator, `[SQL-CONFINE-DATE] ${contesto}: DATE include l'intera giornata, timestamp resta stretto`);
            assert.equal(prepareValue(result.parameter), atteso, `${contesto}: il driver non deve convertire nel fuso del processo`);
            risultati.push(['postgresql', type, result]);
          }
          for (const [type, operator, expression] of tipiMySql) {
            const result = confini.confineMySql(type, ingresso);
            const contesto = `${zona}, ${nome}, margine ${margine}, ${type}`;
            assert.equal(result.parameter, Date.parse(atteso) / 1000, `${contesto}: secondi assoluti con frazione, senza conversione locale`);
            assert.equal(result.expression, expression, `${contesto}: espressione temporale MySQL esplicita`);
            assert.equal(result.operator, operator, `[SQL-CONFINE-DATE] ${contesto}: inclusività della giornata DATE`);
            risultati.push(['mysql', type, result]);
          }
          assert.equal(boundary.getTime(), prima, 'Gli helper non modificano la Date ricevuta');
        }
      }
    }

    for (const [source, expected] of [
      ['2026-10-25T02:30:00.123+02:00', '2026-10-25T00:30:00.123Z'],
      ['2026-10-25T02:30:00.123+01:00', '2026-10-25T01:30:00.123Z'],
    ]) {
      assert.equal(confini.confinePostgres('timestamp(6)', source).parameter, expected,
        'L’ora ripetuta al cambio DST conserva il proprio offset esplicito');
      assert.equal(confini.confineMySql('datetime(6)', source).parameter, Date.parse(expected) / 1000);
    }
    for (const boundary of ['non è una data', '2026-13-44T99:99:99Z', new Date(NaN), null, undefined, 0]) {
      assert.throws(() => confini.confinePostgres('timestamp', boundary), /confine|data|temporale/i);
      assert.throws(() => confini.confineMySql('datetime', boundary), /confine|data|temporale/i);
    }
    for (const type of ['text', 'time without time zone', 'timestamp(7)', 'date; DROP TABLE dati']) {
      assert.throws(() => confini.confinePostgres(type, new Date(0)), /tipo|temporale/i);
    }
    for (const type of ['text', 'time', 'datetime(7)', 'date; DROP TABLE dati']) {
      assert.throws(() => confini.confineMySql(type, new Date(0)), /tipo|temporale/i);
    }
    return { zona, offsets, casi: risultati.length,
      impronta: createHash('sha256').update(JSON.stringify(risultati)).digest('hex'),
      dateImplicitaDriver: prepareValue(new Date('2026-07-15T12:34:56.789Z')) };
  } finally {
    confini.confinePostgres = originale;
    confini.confineMySql = mysqlOriginale;
  }
}

if (process.argv.includes('--child')) {
  const result = eseguiNelFuso();
  console.log(JSON.stringify(result));
  module.exports = result;
} else {
  const risultati = [];
  for (const zona of ['UTC', 'Europe/Rome', 'America/New_York']) {
    const flags = process.argv.filter(value => value === '--mutant' || value === '--mutant-date');
    const child = spawnSync(process.execPath, [__filename, '--child', ...flags], {
      env: { ...process.env, TZ: zona }, encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    assert.equal(child.status, 0, `Prova temporale nel processo ${zona} fallita:\n${child.stderr || child.error || child.stdout}`);
    risultati.push(JSON.parse(child.stdout.trim()));
  }
  assert.equal(new Set(risultati.map(row => row.impronta)).size, 1, 'Tutti i confini sono identici fra UTC, Roma e New York');
  assert.equal(new Set(risultati.map(row => row.dateImplicitaDriver)).size, 3, 'La controprova del driver Date varia davvero con il fuso');
  console.log(`  OK   confini temporali SQL: ${risultati[0].casi} combinazioni per fuso, UTC/Roma/New York identici`);
  console.log('  OK   DST, margini 0/2000 ms, precisione 0/6, DATE inclusiva, validazione e input immutato');
  module.exports = { risultati };
}

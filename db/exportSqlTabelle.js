'use strict';

// Le CREATE e le DDL differite devono concordare su quali tabelle esistevano
// PRIMA dello script. Un indice o una FK di una tabella riusata non si ricrea.
function preparaTabelle({ plan, tables, objects, q, literal, statement }) {
  const mysql = plan.dbType === 'mysql';
  const politica = plan.opzioniSql?.tabelle || 'crea';
  const nuove = new Map();
  const daEliminare = [];
  const preambolo = [];
  const nomeCompleto = nome => q(plan.sourceDb) + '.' + q(nome);
  if (politica !== 'crea' || (plan.opzioniSql?.righe && plan.opzioniSql.righe !== 'insert')) {
    const nomi = tables.map(t => literal(t.nome));
    if (nomi.length && mysql) {
      const condizione = `EXISTS (SELECT 1 FROM information_schema.TABLES WHERE ${nomeMySql('TABLE_SCHEMA', ['DATABASE()'])} AND ${nomeMySql('TABLE_NAME', nomi)} AND TABLE_TYPE <> 'BASE TABLE')`;
      // MySQL non ammette SIGNAL negli statement preparati. Questo SELECT
      // senza FROM produce l'errore col messaggio in chiaro senza scritture.
      const errore = 'SELECT ' + q('CodeDB richiede una tabella di base: trovata una vista');
      preambolo.push(seRichiesto(errore, condizione, { mysql, literal, statement }));
    } else if (nomi.length) {
      preambolo.push(bloccoPg(`IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(plan.sourceDb)} AND c.relname IN (${nomi.join(', ')}) AND c.relkind NOT IN ('r','p')) THEN RAISE EXCEPTION 'CodeDB richiede una tabella ordinaria o partizionata come destinazione'; END IF;`));
    }
  }
  for (const t of tables) {
    if (!t.struttura || politica === 'crea') continue;
    if (politica === 'ricrea' && !t.aggiuntoPerDipendenza) {
      daEliminare.push(t.nome);
      continue;
    }
    const indice = nuove.size;
    if (mysql) {
      const flag = '@codedb_nuova_' + indice;
      nuove.set(t.nome, flag);
      preambolo.push(`SET ${flag} = NOT EXISTS (SELECT 1 FROM information_schema.TABLES WHERE ${nomeMySql('TABLE_SCHEMA', ['DATABASE()'])} AND ${nomeMySql('TABLE_NAME', [literal(t.nome)])});\n`);
    } else {
      const flag = `codedb.nuova_${indice}`;
      nuove.set(t.nome, `pg_catalog.current_setting('${flag}')::boolean`);
      preambolo.push(`SELECT pg_catalog.set_config('${flag}', (pg_catalog.to_regclass(${literal(nomeCompleto(t.nome))}) IS NULL)::text, true);\n`);
    }
  }
  if (daEliminare.length) {
    // Una DROP senza CASCADE protegge le FK e le viste fuori perimetro. Le
    // partizioni PostgreSQL, invece, seguono implicitamente la DROP del padre.
    if (!mysql) {
      const nomi = daEliminare.map(literal).join(', ');
      // ATTACH PARTITION deve attendere fino al COMMIT: fra controllo e DROP
      // non deve poter comparire una nuova figlia fuori perimetro.
      const controllo = `DECLARE padre text; BEGIN
        FOR padre IN SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=${literal(plan.sourceDb)} AND c.relname IN (${nomi}) AND c.relkind='p' ORDER BY c.oid LOOP
          EXECUTE pg_catalog.format('LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE', ${literal(plan.sourceDb)}, padre);
        END LOOP;
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i
        JOIN pg_catalog.pg_class p ON p.oid=i.inhparent JOIN pg_catalog.pg_namespace n ON n.oid=p.relnamespace
        JOIN pg_catalog.pg_class f ON f.oid=i.inhrelid
        WHERE n.nspname=${literal(plan.sourceDb)} AND p.relname IN (${nomi}) AND f.relispartition
          AND (f.relnamespace<>p.relnamespace OR f.relname NOT IN (${nomi}))) THEN
        RAISE EXCEPTION 'La DROP eliminerebbe una partizione esclusa dal piano'; END IF; END;`;
      preambolo.push(bloccoPg(controllo));
    }
    // PostgreSQL protegge le viste dipendenti: le ricreiamo nella stessa
    // transazione. MySQL conserva le viste attraverso una DROP della tabella.
    if (!mysql) {
      const viste = new Map(objects.views.map(v => ['vista:' + v.name, v]));
      for (const id of [...plan.ordine.creazione].reverse()) {
        const v = viste.get(id);
        if (v) preambolo.push(`DROP ${v.materialized ? 'MATERIALIZED ' : ''}VIEW IF EXISTS ${nomeCompleto(v.name)};\n`);
      }
    }
    // Una sola DROP lascia al motore i cicli di FK fra tabelle comprese nel piano.
    preambolo.push(`DROP TABLE IF EXISTS ${daEliminare.map(nomeCompleto).join(', ')};\n`);
  }
  return { nuove, preambolo };
}

function bloccoPg(corpo) {
  let tag = 'codedb';
  while (corpo.includes('$' + tag + '$')) tag += '_';
  return `DO $${tag}$ BEGIN ${corpo} END $${tag}$;\n`;
}

function nomeMySql(campo, valori) {
  const minuscoli = valori.map(v => 'LOWER(' + v + ')').join(', ');
  return `IF(@@lower_case_table_names=0, BINARY ${campo} IN (${valori.join(', ')}), BINARY LOWER(${campo}) IN (${minuscoli}))`;
}

// Creando una foglia sotto un padre già indicizzato, PostgreSQL crea subito
// l'indice figlio, anche quando quello di origine aveva un nome personalizzato.
function indicePartizione(ddl, tabella, padre, { schema, q, literal }) {
  const completa = (db, nome) => literal(q(db) + '.' + q(nome));
  const corpo = `DECLARE figlio text; BEGIN
    SELECT f.relname INTO figlio FROM pg_catalog.pg_inherits h
      JOIN pg_catalog.pg_class f ON f.oid=h.inhrelid JOIN pg_catalog.pg_index i ON i.indexrelid=f.oid
      WHERE h.inhparent=pg_catalog.to_regclass(${completa(padre.schema, padre.nome)}) AND i.indrelid=pg_catalog.to_regclass(${completa(schema, tabella)});
    IF figlio IS NULL THEN EXECUTE ${literal(ddl.trim().replace(/;+$/, ''))};
    ELSIF figlio <> ${literal(padre.figlio)} THEN EXECUTE pg_catalog.format('ALTER INDEX %I.%I RENAME TO %I', ${literal(schema)}, figlio, ${literal(padre.figlio)}); END IF;
    END;`;
  return bloccoPg(corpo);
}

function seRichiesto(ddl, condizione, { mysql, literal, statement }) {
  if (!condizione) return statement(ddl, mysql ? 'mysql' : 'postgresql');
  const sql = ddl.trim().replace(/;+$/, '');
  if (!mysql) return bloccoPg(`IF ${condizione} THEN EXECUTE ${literal(sql)}; END IF;`);
  return `SET @codedb_ddl = IF(${condizione}, ${literal(sql)}, 'DO 0');\n`
    + 'PREPARE codedb_ddl FROM @codedb_ddl;\nEXECUTE codedb_ddl;\nDEALLOCATE PREPARE codedb_ddl;\n';
}

// SHOW CREATE restituisce la clausola DEFINER prima della parola chiave. Il
// prefisso ancorato esclude le occorrenze nel nome del definer o nel corpo.
function seAssenteMySql(ddl) {
  return ddl.replace(/^(CREATE\s+(?:DEFINER\s*=\s*`(?:[^`]|\`\`)*`@`(?:[^`]|\`\`)*`\s+)?(?:FUNCTION|PROCEDURE|TRIGGER|EVENT))\b/i,
    '$1 IF NOT EXISTS');
}

module.exports = { preparaTabelle, seRichiesto, seAssenteMySql, nomeMySql, indicePartizione };

# -*- coding: utf-8 -*-
"""
Passo 2: bottoni, titoli e badge costruiti in JavaScript.

Regola: dove il glifo finisce dentro `innerHTML` diventa `<i data-lucide>`;
dove finisce in `textContent` o in un attributo si TOGLIE, perche' li' un
elemento non ci puo' stare. Ogni chiamante che inserisce un <i> deve poi
chiamare `refreshLucideIcons` sul proprio contenitore, altrimenti l'icona
resta un elemento vuoto.
"""
import io
import sys

I = lambda n: '<i data-lucide="%s"></i>' % n

SOST = {
 'public/js/admin-rbac.js': [
  ('>\U0001f50c ${esc(c.name)}</button>', '>' + I('plug') + ' ${esc(c.name)}</button>'),
  ('>\U0001f310 Tutte le connessioni concesse</button>', '>' + I('globe') + ' Tutte le connessioni concesse</button>'),
  ('>\U0001f310 Tutti i DB</button>', '>' + I('globe') + ' Tutti i DB</button>'),
  ('<div class="apikey-new-head">\U0001f511 Nuova API key generata',
   '<div class="apikey-new-head">' + I('key') + ' Nuova API key generata'),
  ('id="apikey-copy-raw">\U0001f4cb Copia Chiave</button>',
   'id="apikey-copy-raw">' + I('copy') + ' Copia Chiave</button>'),
  ('id="apikey-copy-json">\U0001f4cb Copia Configurazione JSON</button>',
   'id="apikey-copy-json">' + I('copy') + ' Copia Configurazione JSON</button>'),
 ],
 'public/js/auditlog.js': [
  ("bits.push(`⚠ ${e.error}`);", "bits.push(`${e.error}`);"),
  ("""'<span class="audit-status audit-status-ok">✅ OK</span>'""",
   """'<span class="audit-status audit-status-ok">' + ICO('circle-check') + ' OK</span>'"""),
  ("""'<span class="audit-status audit-status-err">❌ Errore</span>';""",
   """'<span class="audit-status audit-status-err">' + ICO('circle-x') + ' Errore</span>';"""),
  ("""'<span class="audit-cat audit-cat-read">\U0001f441 Lettura</span>'""",
   """'<span class="audit-cat audit-cat-read">' + ICO('eye') + ' Lettura</span>'"""),
  ("""'<span class="audit-cat audit-cat-write">✏️ Scrittura</span>';""",
   """'<span class="audit-cat audit-cat-write">' + ICO('pencil') + ' Scrittura</span>';"""),
 ],
 'public/js/backupmanager.js': [
  ("toast(`✅ Backup completato con successo: ${res.summary.id}`);",
   "toast(`Backup completato con successo: ${res.summary.id}`);"),
  ("statusEl.textContent = `✅ Backup completato:", "statusEl.textContent = `Backup completato:"),
  ("toast(`❌ Backup fallito: ${err.message}`, true);", "toast(`Backup fallito: ${err.message}`, true);"),
  ("\U0001f4c2 <strong>${esc(gName)}</strong>", I('folder-open') + ' <strong>${esc(gName)}</strong>'),
  ('data-id="${esc(ultimo.id)}">\U0001f50d Verifica', 'data-id="${esc(ultimo.id)}">' + I('file-search') + ' Verifica'),
  ('data-id="${esc(b.id)}">\U0001f50d Verifica</button>', 'data-id="${esc(b.id)}">' + I('file-search') + ' Verifica</button>'),
  ('>⚠ catena incompleta</span>', '>' + I('triangle-alert') + ' catena incompleta</span>'),
  ('disabled title="${esc(catena.motivo)}">⚡ Ripristina</button>',
   'disabled title="${esc(catena.motivo)}">' + I('rotate-ccw') + ' Ripristina</button>'),
  ('btn-restore-backup" ${attr}>⚡ Ripristina</button>',
   'btn-restore-backup" ${attr}>' + I('rotate-ccw') + ' Ripristina</button>'),
  ('<div class="status-pass">✅ Verifica SHA-256 SUPERATA',
   '<div class="status-pass">' + I('circle-check') + ' Verifica SHA-256 SUPERATA'),
  ('<div class="status-fail">❌ Verifica FALLITA',
   '<div class="status-fail">' + I('circle-x') + ' Verifica FALLITA'),
  ('? `⚠️ Questo backup viene dal gruppo', '? `' + I('triangle-alert') + ' Questo backup viene dal gruppo'),
  ("apriProgresso(`⏳ Ripristino di ${backupId}", "apriProgresso(`Ripristino di ${backupId}"),
  ("const msg = `✅ Ripristino completato su", "const msg = `Ripristino completato su"),
  ("toast(`❌ Ripristino fallito: ${err.message}`, true);", "toast(`Ripristino fallito: ${err.message}`, true);"),
  ("chiudiProgresso(`❌ Ripristino fallito: ${err.message}`, false);", "chiudiProgresso(`Ripristino fallito: ${err.message}`, false);"),
 ],
 'public/js/cella-geometria.js': [
  ("cella.title = `${testo}\\n\U0001f5fa Doppio clic per visualizzare sulla mappa`;",
   "cella.title = `${testo}\\nDoppio clic per visualizzare sulla mappa`;"),
 ],
 'public/js/cellgrafico.js': [
  ("`\U0001f4c8 Grafico della selezione — ${titolo}` : '\U0001f4c8 Grafico della selezione'",
   "`Grafico della selezione — ${titolo}` : 'Grafico della selezione'"),
  ('<h2 id="cellchart-title">\U0001f4c8 Grafico della selezione</h2>',
   '<h2 id="cellchart-title">' + I('line-chart') + ' Grafico della selezione</h2>'),
 ],
 'public/js/cellselect.js': [
  ('<h2>\U0001f4ca Statistiche selezione</h2>', '<h2>' + I('sigma') + ' Statistiche selezione</h2>'),
  ('<button id="cellstats-chart" class="ghost">\U0001f4c8 Grafico</button>',
   '<button id="cellstats-chart" class="ghost">' + I('line-chart') + ' Grafico</button>'),
 ],
 'public/js/charts.js': [
  ("btnPannello.textContent = chiuso ? '⚙ Personalizza' : '⚙ Chiudi pannello';",
   "btnPannello.textContent = chiuso ? 'Personalizza' : 'Chiudi pannello';"),
 ],
 'public/js/colltabs.js': [
  ("name.textContent = ct.isDbTab ? `⚡ ${ct.db}` : ct.coll;",
   "name.textContent = ct.isDbTab ? ct.db : ct.coll;"),
 ],
 'public/js/dbtree.js': [
  ("query.textContent = `⚡ Apri Query & Aggregate`;", "query.textContent = 'Apri Query & Aggregate';"),
 ],
 'public/js/geo-stats.js': [
  ("const parti = [`\U0001f5fa ${st.totale} geometrie`];", "const parti = [`${st.totale} geometrie`];"),
  ("parti[0] = `\U0001f5fa ${st.totale} ${st.perTipo[0][0]}`;", "parti[0] = `${st.totale} ${st.perTipo[0][0]}`;"),
 ],
 'public/js/grid.js': [
  ("td.title = `${text}\\n\U0001f517 ${rel.tabella}.${rel.colonna}`;",
   "td.title = `${text}\\nCollegata a ${rel.tabella}.${rel.colonna}`;"),
 ],
 'public/js/splitview.js': [
  ("td.title = `${disp.text}\\n\U0001f517 ${relazione.tabella}.${relazione.colonna}`;",
   "td.title = `${disp.text}\\nCollegata a ${relazione.tabella}.${relazione.colonna}`;"),
  ('<button type="button" class="pane-run-btn primary">▶ Esegui</button>',
   '<button type="button" class="pane-run-btn primary">' + I('play') + ' Esegui</button>'),
  ('title="Elimina elementi selezionati">\U0001f5d1 Elimina (0)</button>',
   'title="Elimina elementi selezionati">' + I('trash-2') + ' Elimina (0)</button>'),
  ("bulkDelBtn.textContent = `\U0001f5d1 Elimina (${selCount})`;",
   "bulkDelBtn.innerHTML = `${ICO('trash-2')} Elimina (${selCount})`;"),
  ('<h2>\U0001f50d Confronto Schema Tabelle</h2>', '<h2>' + I('git-compare') + ' Confronto Schema Tabelle</h2>'),
  ("if (!colls.length) return '\U0001f532 Affiancati';", "if (!colls.length) return 'Affiancati';"),
  ("return `\U0001f532 ${testa}${resto > 0 ? ` +${resto}` : ''}`;", "return `${testa}${resto > 0 ? ` +${resto}` : ''}`;"),
  ("coll: '\U0001f532 Affiancati',", "coll: 'Affiancati',"),
  ("if (label) label.textContent = 'Affianca sotto ⬇';", "if (label) label.textContent = 'Affianca sotto';"),
  ("if (label) label.textContent = '⬆ Affianca sopra';", "if (label) label.textContent = 'Affianca sopra';"),
 ],
 'public/js/session-restore.js': [
  ("coll: c.coll || '\U0001f532 Affiancati',", "coll: c.coll || 'Affiancati',"),
 ],
 'public/js/snippet-manager.js': [
  ('<h2>\U0001f4da Libreria Snippet & Template Query</h2>',
   '<h2>' + I('library') + ' Libreria Snippet & Template Query</h2>'),
 ],
 'public/js/theme.js': [
  ("""data-id="${esc(t.id)}" title="Elimina">\U0001f5d1</button>""",
   'data-id="${esc(t.id)}" title="Elimina">' + I('trash-2') + '</button>'),
 ],
 'public/js/inlineEdit.js': [
  ("btn.textContent = '\U0001f517';",
   "btn.innerHTML = ICO('link');"),
 ],
 'public/js/insert.js': [
  ("btn.textContent = isGeometry(geo) ? `\U0001f5fa ${geometryLabel(geo).replace(/^▦ /, '')}` : '\U0001f5fa Disegna sulla mappa…';",
   "btn.innerHTML = isGeometry(geo)\n    ? `${ICO('map')} ${esc(geometryLabel(geo).replace(/^▦ /, ''))}`\n    : `${ICO('map')} Disegna sulla mappa…`;"),
 ],
 'public/js/connection.js': [
  ("const dbIcon = { mongodb: '\U0001f343', mysql: '\U0001f42c', postgresql: '\U0001f418', postgres: '\U0001f418' }[cfg.dbType] || '\U0001f5c4';",
   "// L'icona del tipo di database ha gia' un posto solo: `dbTypeIcon` in\n  // utils.js, che usa le icone dell'applicazione. Questa era una seconda\n  // tabella, con glifi diversi, che nessuno teneva allineata alla prima.\n  const dbIcon = dbTypeIcon(cfg.dbType);"),
  ("html += `<br>\U0001f512 <strong>Tunnel SSH attivo</strong>",
   "html += `<br>${ICO('lock')} <strong>Tunnel SSH attivo</strong>"),
 ],
}

mancanti = 0
for percorso, coppie in SOST.items():
    s = io.open(percorso, encoding='utf-8').read()
    for a, b in coppie:
        n = s.count(a)
        if n != 1:
            print('!! %s conta=%d : %r' % (percorso, n, a[:78]))
            mancanti += 1
            continue
        s = s.replace(a, b, 1)
    io.open(percorso, 'w', encoding='utf-8').write(s)

print('non applicate:', mancanti)
sys.exit(1 if mancanti else 0)

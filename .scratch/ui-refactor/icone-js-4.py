# -*- coding: utf-8 -*-
"""Passo 4: badge di stato, alberi, dropdown, e la prosa che li descrive."""
import io
import sys

I = lambda n: '<i data-lucide="%s"></i>' % n
errori = []


def applica(percorso, coppie):
    s = io.open(percorso, encoding='utf-8').read()
    for a, b in coppie:
        n = s.count(a)
        if n != 1:
            errori.append('%s conta=%d : %r' % (percorso, n, a[:75]))
            continue
        s = s.replace(a, b, 1)
    io.open(percorso, 'w', encoding='utf-8').write(s)


# --- health.js: i pallini di stato ---------------------------------------
applica('public/js/health.js', [
 ("""return `<span class="health-ok">\U0001f7e2 Attivo</span>""",
  """return `<span class="health-ok">${ICO('circle-check')} Attivo</span>"""),
 ("""return `<span class="health-err">\U0001f534 Caduto</span>${err}`;""",
  """return `<span class="health-err">${ICO('circle-x')} Caduto</span>${err}`;"""),
 ("""? '<span class="health-ok">\U0001f7e2 Attiva</span>'""",
  """? `<span class="health-ok">${ICO('circle-check')} Attiva</span>`"""),
 ("""`<span class="health-err">\U0001f534 Errore</span><div class="sub-text">${esc(c.error || '')}</div>`;""",
  """`<span class="health-err">${ICO('circle-x')} Errore</span><div class="sub-text">${esc(c.error || '')}</div>`;"""),
])

# --- pending-queries.js ---------------------------------------------------
applica('public/js/pending-queries.js', [
 ("""return `<span class="badge-status status-running">⏳ In esecuzione</span>`;""",
  """return `<span class="badge-status status-running">${ICO('hourglass')} In esecuzione</span>`;"""),
 ("""return `<span class="badge-status status-error">❌ Errore</span>`;""",
  """return `<span class="badge-status status-error">${ICO('circle-x')} Errore</span>`;"""),
 ("""return `<span class="badge-status status-paused">\U0001f6d1 In pausa / Annullata</span>`;""",
  """return `<span class="badge-status status-paused">${ICO('pause')} In pausa / Annullata</span>`;"""),
 ("""return `<span class="badge-status status-disconnected">\U0001f50c Disconnessa</span>`;""",
  """return `<span class="badge-status status-disconnected">${ICO('unplug')} Disconnessa</span>`;"""),
 ("""return `<span class="badge-status status-abandoned">\U0001f6aa Abbandonata</span>`;""",
  """return `<span class="badge-status status-abandoned">${ICO('log-out')} Abbandonata</span>`;"""),
 ("""<span class="pending-progress-text">\U0001f4dc ${eseguiti}""",
  """<span class="pending-progress-text">${ICO('scroll-text')} ${eseguiti}"""),
 ("""fermata">\U0001f4cd DA QUI CI SIÈ FERMATI""",
  """fermata">${ICO('map-pin')} DA QUI CI SIÈ FERMATI"""),
 ("""<span class="pending-time">⏱ ${dateStr}""",
  """<span class="pending-time">${ICO('clock')} ${dateStr}"""),
 ("""title="${esc(item.error)}">⚠️ ${esc(item.error)}</div>""",
  """title="${esc(item.error)}">${ICO('triangle-alert')} ${esc(item.error)}</div>"""),
 ("""btn-copy-pending" data-id="${esc(item.id)}">\U0001f4cb Copia</button>""",
  """btn-copy-pending" data-id="${esc(item.id)}">${ICO('copy')} Copia</button>"""),
 ("""btn-resolve-pending" data-id="${esc(item.id)}">✔ Segna risolta</button>""",
  """btn-resolve-pending" data-id="${esc(item.id)}">${ICO('check')} Segna risolta</button>"""),
 ("""btn-remove-pending" data-id="${esc(item.id)}">\U0001f5d1 Rimuovi</button>""",
  """btn-remove-pending" data-id="${esc(item.id)}">${ICO('trash-2')} Rimuovi</button>"""),
])

# --- sessions.js ----------------------------------------------------------
applica('public/js/sessions.js', [
 ("""box.innerHTML = note.map((n) => `<div>⚠ ${esc(n)}</div>`).join('');""",
  """box.innerHTML = note.map((n) => `<div>${ICO('triangle-alert')} ${esc(n)}</div>`).join('');"""),
 ("""'in attesa': '<span class="health-err">⛔ In attesa</span>',""",
  """'in attesa': `<span class="health-err">${ICO('circle-slash')} In attesa</span>`,"""),
 ("""attiva: '<span class="health-ok">▶ Attiva</span>',""",
  """attiva: `<span class="health-ok">${ICO('play')} Attiva</span>`,"""),
 ("""inattiva: '<span class="sub-text">⏸ Inattiva</span>',""",
  """inattiva: `<span class="sub-text">${ICO('pause')} Inattiva</span>`,"""),
 ("""const ETICHETTA = { query: '✖ Annulla query', connessione: '⏻ Termina connessione' };""",
  """const ETICHETTA = { query: 'Annulla query', connessione: 'Termina connessione' };"""),
 ("""const icona = { allarme: '⛔', attenzione: '⚠', ok: '✓' }[d.livello] || '•';""",
  """const icona = ICO({ allarme: 'circle-slash', attenzione: 'triangle-alert', ok: 'circle-check' }[d.livello] || 'circle');"""),
])

# --- script-run.js: lo stato e il registro --------------------------------
applica('public/js/script-run.js', [
 ("""const ETICHETTA_STATO = {
  running: { cls: 'status-running', testo: '⏳ In esecuzione' },
  paused: { cls: 'status-paused', testo: '⏸ In pausa' },
  done: { cls: 'status-completed', testo: '✓ Completato' },
  aborted: { cls: 'status-abandoned', testo: '\U0001f6d1 Interrotto' },
  idle: { cls: '', testo: '● In attesa' },
};""",
  """// L'icona e' un CAMPO dello stato, non un carattere in testa all'etichetta:
// e' cio' che permette di disegnarla come icona dell'applicazione invece che
// come pittogramma, e di leggere l'etichetta senza il nome del glifo davanti.
const ETICHETTA_STATO = {
  running: { cls: 'status-running', icona: 'hourglass', testo: 'In esecuzione' },
  paused: { cls: 'status-paused', icona: 'pause', testo: 'In pausa' },
  done: { cls: 'status-completed', icona: 'circle-check', testo: 'Completato' },
  aborted: { cls: 'status-abandoned', icona: 'circle-stop', testo: 'Interrotto' },
  idle: { cls: '', icona: 'circle-dashed', testo: 'In attesa' },
};"""),
 ("""    statusEl.className = `badge-status ${et.cls}`;
    statusEl.textContent = et.testo;""",
  """    statusEl.className = `badge-status ${et.cls}`;
    statusEl.innerHTML = `${ICO(et.icona)} ${esc(et.testo)}`;
    refreshLucideIcons(statusEl);"""),
 ("""    const icona = v.interrupted ? '⏸' : (v.ok ? '✓' : '✖');""",
  """    const icona = ICO(v.interrupted ? 'pause' : (v.ok ? 'check' : 'x'));"""),
])

# --- query-tab.js: badge e albero dello schema ----------------------------
applica('public/js/query-tab.js', [
 ("""if (progressText) progressText.textContent = `⏸ Sequenza fermata al Chunk ${i + 1}/${totalChunks}`;""",
  """if (progressText) progressText.textContent = `Sequenza fermata al Chunk ${i + 1}/${totalChunks}`;"""),
 ("""progressText.textContent = `✖ Interrotto per errore al Chunk ${i + 1}/${totalChunks}`;""",
  """progressText.textContent = `Interrotto per errore al Chunk ${i + 1}/${totalChunks}`;"""),
 ("""statusBadge.textContent = '⏳ Esecuzione...';""",
  """statusBadge.textContent = 'Esecuzione...';"""),
 ("""else if (status === 'error') statusBadge.textContent = '✖ Errore';""",
  """else if (status === 'error') statusBadge.textContent = 'Errore';"""),
 ("""dbLabel.innerHTML = `<span>\U0001f5c4 <strong>${escapeHtml(dbName)}</strong></span>`;""",
  """dbLabel.innerHTML = `<span>${ICO('database')} <strong>${escapeHtml(dbName)}</strong></span>`;"""),
 ("""const icon = isSqlType(state.dbType) ? '\U0001f4cb' : '\U0001f4c1';""",
  """const icon = ICO(isSqlType(state.dbType) ? 'table-2' : 'folder');"""),
 ("""fieldLabel.innerHTML = `<span>\U0001f539 ${escapeHtml(fieldName)}</span>""",
  """fieldLabel.innerHTML = `<span>${ICO('dot')} ${escapeHtml(fieldName)}</span>"""),
 ("""nodo.textContent = `\U0001f517 ${rel.nome || 'Chiave esterna'}:""",
  """nodo.textContent = `${rel.nome || 'Chiave esterna'}:"""),
])

# --- qe-history.js / queryhistory.js -------------------------------------
applica('public/js/qe-history.js', [
 ("""? `Query ripristinata (veniva da "${voce.conn}"): premi ▶ Esegui per lanciarla qui`""",
  """? `Query ripristinata (veniva da "${voce.conn}"): premi «Esegui» per lanciarla qui`"""),
 ("""      : 'Query ripristinata: premi ▶ Esegui per lanciarla');""",
  """      : 'Query ripristinata: premi «Esegui» per lanciarla');"""),
 ("""return { testo: voce.ms !== null && voce.ms !== undefined ? `✖ ${voce.ms} ms` : '✖', cls: 'qe-history-esito-err' };""",
  """return { testo: voce.ms !== null && voce.ms !== undefined ? `${voce.ms} ms` : 'errore', cls: 'qe-history-esito-err' };"""),
 ("""play.textContent = '▶';""",
  """play.innerHTML = ICO('play');
    refreshLucideIcons(play);"""),
 ("""<span>Cronologia query ⚡</span>""",
  """<span>Cronologia query</span>"""),
])
applica('public/js/queryhistory.js', [
 ("""toast('Query ripristinata: premi ▶ Esegui per lanciarla');""",
  """toast('Query ripristinata: premi «Esegui» per lanciarla');"""),
])

# --- connmanager.js: la cartella dell'albero ------------------------------
applica('public/js/connmanager.js', [
 ("""head.textContent = `${isCollapsed ? '▸' : '▾'} \U0001f4c1 ${folder}`;""",
  """head.innerHTML = `${ICO(isCollapsed ? 'chevron-right' : 'chevron-down')}${ICO(isCollapsed ? 'folder' : 'folder-open')}<span>${esc(folder)}</span>`;
    refreshLucideIcons(head);"""),
])

# --- graph3d.js -----------------------------------------------------------
applica('public/js/graph3d.js', [
 ("""style="color:var(--danger);">⚠ Ciclo di chiavi esterne""",
  """style="color:var(--danger);">${ICO('triangle-alert')} Ciclo di chiavi esterne"""),
])

# --- autocomplete.js: il tipo della voce ----------------------------------
applica('public/js/autocomplete.js', [
 ("""const ICONE = {
  campo: '\U0001f539', tabella: '\U0001f4cb', parola: '⌨', funzione: 'ƒ',
  operatore: '$', metodo: '▸',
};""",
  """// Icone dell'applicazione, non pittogrammi: nel dropdown stanno in colonna,
// e un'emoji cambia larghezza da un sistema all'altro — cioe' i nomi dei
// candidati non si allineavano fra una riga e l'altra.
const ICONE = {
  campo: 'dot', tabella: 'table-2', parola: 'type', funzione: 'function-square',
  operatore: 'dollar-sign', metodo: 'chevron-right',
};"""),
 ("""    icona.textContent = ICONE[voce.tipo] || '•';""",
  """    icona.dataset.lucide = ICONE[voce.tipo] || 'circle';
    icona.setAttribute('aria-hidden', 'true');"""),
 ("""    const icona = document.createElement('span');
    icona.className = 'ac-icona';""",
  """    const icona = document.createElement('i');
    icona.className = 'ac-icona';"""),
])

# --- snippet-manager.js: il motore e' gia' scritto nel nome ---------------
applica('public/js/snippet-manager.js', [
 ("name: '\U0001f42c MySQL: Multi-table JOIN',", "name: 'MySQL: Multi-table JOIN',"),
 ("name: '\U0001f42c MySQL: Temporal GROUP BY',", "name: 'MySQL: Temporal GROUP BY',"),
 ("name: '\U0001f42c MySQL: Window Functions',", "name: 'MySQL: Window Functions',"),
 ("name: '\U0001f343 MongoDB: Pipeline $lookup (JOIN)',", "name: 'MongoDB: Pipeline $lookup (JOIN)',"),
 ("name: '\U0001f343 MongoDB: $unwind & $group',", "name: 'MongoDB: $unwind & $group',"),
 ("name: '\U0001f343 MongoDB: $facet Multi-Pipeline',", "name: 'MongoDB: $facet Multi-Pipeline',"),
 ("name: '\U0001f500 Cross-DB: Virtual JOIN (MySQL ➔ MongoDB)',", "name: 'Cross-DB: Virtual JOIN (MySQL → MongoDB)',"),
 ("name: '\U0001f418 PostgreSQL: Ricerca Semantica Vector (pgvector)',", "name: 'PostgreSQL: Ricerca Semantica Vector (pgvector)',"),
 ("name: '\U0001f418 PostgreSQL: Full-Text Search (tsvector & tsquery)',", "name: 'PostgreSQL: Full-Text Search (tsvector & tsquery)',"),
 ("name: '\U0001f418 PostgreSQL: Operazioni JSONB',", "name: 'PostgreSQL: Operazioni JSONB',"),
])

# --- La prosa che DESCRIVE l'interfaccia deve descrivere quella di ADESSO -
applica('public/js/onboarding-stato.js', [
 ("aiuto: 'Vista ⚡ Query & Aggregate:", "aiuto: 'Vista Query & Aggregate:"),
 ("oppure parti da \U0001f4a1 Suggeriti.'", "oppure parti dai grafici suggeriti.'"),
 ("'Chiavi esterne visibili in griglia: \U0001f517 dove il vincolo è dichiarato",
  "'Chiavi esterne visibili in griglia: un anello dove il vincolo è dichiarato"),
 ("minifica nell\\'editor ⚡ e nelle modali", "minifica nell\\'editor delle query e nelle modali"),
 ("'Cronologia dedicata della tab ⚡:", "'Cronologia dedicata della tab Query & Aggregate:"),
 ("'Scheda \U0001f5fa Mappa nei risultati della query,", "'Scheda Mappa nei risultati della query,"),
 ("'Grafico della selezione: \U0001f4c8 nel menu contestuale",
  "'Grafico della selezione: la voce «Grafico della selezione» nel menu contestuale"),
])
applica('public/js/onboarding.js', [
 ("e ⚡ Query & Aggregate. UML e Grafo 3D", "e Query & Aggregate. UML e Grafo 3D"),
])

for e in errori:
    print('!!', e)
print('non applicate:', len(errori))
sys.exit(1 if errori else 0)

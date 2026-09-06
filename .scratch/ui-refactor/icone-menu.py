# -*- coding: utf-8 -*-
"""Porta le voci dei menu contestuali dalle emoji alle icone Lucide."""
import io

SOST = {
 'public/js/cellselect.js': [
  ("{ label: '✎ Modifica riga…', action: () => A.modificaRiga(righe[0]) }",
   "{ icona: 'square-pen', label: 'Modifica riga…', action: () => A.modificaRiga(righe[0]) }"),
  ("        label: righe.length === 1 ? '\U0001f5d1 Elimina riga' : `\U0001f5d1 Elimina le ${righe.length} righe selezionate`,",
   "        icona: 'trash-2',\n        label: righe.length === 1 ? 'Elimina riga' : `Elimina le ${righe.length} righe selezionate`,"),
  ("{ label: '\U0001f4ca Statistiche selezione…', action: () => showCellStats(A) },",
   "{ icona: 'sigma', label: 'Statistiche selezione…', action: () => showCellStats(A) },"),
  ("{ label: '\U0001f4c8 Grafico della selezione…', action: () => mostraGraficoSelezione(A) },",
   "{ icona: 'line-chart', label: 'Grafico della selezione…', action: () => mostraGraficoSelezione(A) },"),
  ("        label: `\U0001f5fa Mostra ${geometrie === 1 ? 'la geometria' : `le ${geometrie} geometrie`} su mappa…`,",
   "        icona: 'map',\n        label: `Mostra ${geometrie === 1 ? 'la geometria' : `le ${geometrie} geometrie`} su mappa…`,"),
 ],
 'public/js/colltabs.js': [
  ("{ label: '✏️ Rinomina area…', action: () => chiediNomeAreaSplit(ct.id) },",
   "{ icona: 'pencil', label: 'Rinomina area…', action: () => chiediNomeAreaSplit(ct.id) },"),
  ("{ label: '✕ Chiudi Split-View', action: () => closeCollTab(ct.id) },",
   "{ icona: 'x', label: 'Chiudi Split-View', action: () => closeCollTab(ct.id) },"),
  ("{ label: '\U0001f532 Apri in Split-View (Affianca)', action: () => addOrSplitPane(null, 'right', { db: ct.db, coll: ct.coll, tabId: t.id }) },",
   "{ icona: 'columns-2', label: 'Apri in Split-View (Affianca)', action: () => addOrSplitPane(null, 'right', { db: ct.db, coll: ct.coll, tabId: t.id }) },"),
  ("{ label: '\U0001f532 Affianca in una NUOVA area', action: () => addOrSplitPane(null, 'right', { db: ct.db, coll: ct.coll, tabId: t.id }, { nuovaArea: true }) },",
   "{ icona: 'square-split-horizontal', label: 'Affianca in una NUOVA area', action: () => addOrSplitPane(null, 'right', { db: ct.db, coll: ct.coll, tabId: t.id }, { nuovaArea: true }) },"),
 ],
 'public/js/connmanager.js': [
  ("{ label: '▶ Apri in nuovo tab', action: () => openConn(conn) },",
   "{ icona: 'play', label: 'Apri in nuovo tab', action: () => openConn(conn) },"),
  ("{ label: '⚡ Testa connessione', action: () => testConn(conn) },",
   "{ icona: 'zap', label: 'Testa connessione', action: () => testConn(conn) },"),
  ("{ label: '✎ Modifica…', action: () => startEditConn(conn.name) },",
   "{ icona: 'square-pen', label: 'Modifica…', action: () => startEditConn(conn.name) },"),
  ("{ label: '\U0001f5d1 Elimina…', danger: true, action: () => deleteConn(conn) },",
   "{ icona: 'trash-2', label: 'Elimina…', danger: true, action: () => deleteConn(conn) },"),
 ],
 'public/js/dbtree.js': [
  ("{ label: `⚡ Query & Aggregate su questo ${dbWord()}`, action: () => openDbTab(db.name) },",
   "{ icona: 'zap', label: `Query & Aggregate su questo ${dbWord()}`, action: () => openDbTab(db.name) },"),
  ("{ label: `✎ Rinomina ${dbWord()}…`, action: () => renameDb(db.name) },",
   "{ icona: 'square-pen', label: `Rinomina ${dbWord()}…`, action: () => renameDb(db.name) },"),
  ("{ label: `\U0001f5d1 Elimina ${dbWord()}…`, danger: true, action: () => dropDb(db.name) },",
   "{ icona: 'trash-2', label: `Elimina ${dbWord()}…`, danger: true, action: () => dropDb(db.name) },"),
  ("{ label: '\U0001f532 Affianca in Split-View', action: () => addOrSplitPane(null, 'right', { db: dbName, coll: coll.name, tabId: activeTab()?.id }) },",
   "{ icona: 'columns-2', label: 'Affianca in Split-View', action: () => addOrSplitPane(null, 'right', { db: dbName, coll: coll.name, tabId: activeTab()?.id }) },"),
  ("{ label: '\U0001f532 Affianca in una NUOVA area', action: () => addOrSplitPane(null, 'right', { db: dbName, coll: coll.name, tabId: activeTab()?.id }, { nuovaArea: true }) },",
   "{ icona: 'square-split-horizontal', label: 'Affianca in una NUOVA area', action: () => addOrSplitPane(null, 'right', { db: dbName, coll: coll.name, tabId: activeTab()?.id }, { nuovaArea: true }) },"),
  ("{ label: `ℹ Dettagli ${collWord()}`,",
   "{ icona: 'info', label: `Dettagli ${collWord()}`,"),
  ("{ label: `✎ Rinomina ${collWord()}…`, action: () => renameColl(dbName, coll.name) },",
   "{ icona: 'square-pen', label: `Rinomina ${collWord()}…`, action: () => renameColl(dbName, coll.name) },"),
  ("{ label: `\U0001f5d1 Elimina ${collWord()}…`, danger: true, action: () => dropColl(dbName, coll.name) },",
   "{ icona: 'trash-2', label: `Elimina ${collWord()}…`, danger: true, action: () => dropColl(dbName, coll.name) },"),
 ],
 'public/js/splitview.js': [
  ("{ label: massimizzato ? '\U0001f5d7 Ripristina il layout' : '\U0001f5d6 Massimizza questo pannello (doppio clic sul titolo)', action: () => massimizzaPane(paneId) },",
   "{ icona: massimizzato ? 'minimize-2' : 'maximize-2', label: massimizzato ? 'Ripristina il layout' : 'Massimizza questo pannello (doppio clic sul titolo)', action: () => massimizzaPane(paneId) },"),
  ("{ label: '↔ Scambia con il precedente', action: () => scambiaConVicino(paneId, 'prev') },",
   "{ icona: 'arrow-left-right', label: 'Scambia con il precedente', action: () => scambiaConVicino(paneId, 'prev') },"),
  ("{ label: '↔ Scambia con il successivo', action: () => scambiaConVicino(paneId, 'next') },",
   "{ icona: 'arrow-left-right', label: 'Scambia con il successivo', action: () => scambiaConVicino(paneId, 'next') },"),
  ("voci.push({ label: `✕ Chiudi gli altri ${altri} ${altri === 1 ? 'pannello' : 'pannelli'}`, action: () => chiudiAltriPane(paneId), danger: true });",
   "voci.push({ icona: 'x', label: `Chiudi gli altri ${altri} ${altri === 1 ? 'pannello' : 'pannelli'}`, action: () => chiudiAltriPane(paneId), danger: true });"),
  ("voci.push({ label: '✕ Chiudi questo pannello', action: () => closePane(paneId), danger: true });",
   "voci.push({ icona: 'x', label: 'Chiudi questo pannello', action: () => closePane(paneId), danger: true });"),
  ("voci.push({ label: `✏️ Rinomina l'area…`, action: () => chiediNomeAreaSplit(a.collTabId) });",
   "voci.push({ icona: 'pencil', label: `Rinomina l'area…`, action: () => chiediNomeAreaSplit(a.collTabId) });"),
  ("voci.push({ label: '\U0001f50d Confronta gli schemi dei primi due', action: () => comparePaneSchemas() });",
   "voci.push({ icona: 'git-compare', label: 'Confronta gli schemi dei primi due', action: () => comparePaneSchemas() });"),
  ("voci.push({ label: '✕ Chiudi l\\'area affiancata', action: () => closeSplitView({ riapri: true, collTabId: a.collTabId }), danger: true });",
   "voci.push({ icona: 'x', label: 'Chiudi l\\'area affiancata', action: () => closeSplitView({ riapri: true, collTabId: a.collTabId }), danger: true });"),
 ],
}

mancanti = 0
for percorso, coppie in SOST.items():
    s = io.open(percorso, encoding='utf-8').read()
    for a, b in coppie:
        n = s.count(a)
        if n != 1:
            print('!! %s -> conta=%d : %s' % (percorso, n, a[:80]))
            mancanti += 1
            continue
        s = s.replace(a, b, 1)
    io.open(percorso, 'w', encoding='utf-8').write(s)

print('voci non applicate:', mancanti)

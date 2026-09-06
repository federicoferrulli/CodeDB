# -*- coding: utf-8 -*-
"""
Passo 3: collega `ICO` all'helper che l'applicazione ha gia'
(`lucideIconHtml` in utils.js) e assicura il `refreshLucideIcons` dove il
markup viene inserito, altrimenti l'<i> resta un elemento vuoto.
"""
import io
import re
import sys

IMPORT = {
 'public/js/auditlog.js': (
   "import { $, emit, esc, iniziaCaricamento } from './utils.js';",
   "import { $, emit, esc, iniziaCaricamento, lucideIconHtml as ICO, refreshLucideIcons } from './utils.js';"),
 'public/js/connection.js': (
   "import { $, emit, toast, safeUUID, openModal, closeModal, showError, conCaricamento, esc } from './utils.js';",
   "import { $, emit, toast, safeUUID, openModal, closeModal, showError, conCaricamento, esc, dbTypeIcon, lucideIconHtml as ICO, refreshLucideIcons } from './utils.js';"),
 'public/js/inlineEdit.js': (
   "import { $, emit, isPlainObject, valueType, displayValue, editValue, parseEdited, idOf, toast, openModal, closeModal, isForActiveTab, captureContext, marcaDatiSporchi, conCaricamento } from './utils.js';",
   "import { $, emit, isPlainObject, valueType, displayValue, editValue, parseEdited, idOf, toast, openModal, closeModal, isForActiveTab, captureContext, marcaDatiSporchi, conCaricamento, lucideIconHtml as ICO, refreshLucideIcons } from './utils.js';"),
 'public/js/insert.js': (
   "import { $, emit, esc, toast, openModal, closeModal, isSqlType, showError, conCaricamento, captureContext, marcaDatiSporchi } from './utils.js';",
   "import { $, emit, esc, toast, openModal, closeModal, isSqlType, showError, conCaricamento, captureContext, marcaDatiSporchi, lucideIconHtml as ICO, refreshLucideIcons } from './utils.js';"),
 'public/js/splitview.js': (
   "import { $, emit, displayValue, displayValueBreve, esc, isSqlType, dbTypeIcon, idOf, toast, safeUUID, refreshLucideIcons, eseguiAOndate, showContextMenu, conCaricamento, openModal, closeModal, chiediTesto } from './utils.js';",
   "import { $, emit, displayValue, displayValueBreve, esc, isSqlType, dbTypeIcon, idOf, toast, safeUUID, refreshLucideIcons, eseguiAOndate, showContextMenu, conCaricamento, openModal, closeModal, chiediTesto, lucideIconHtml as ICO } from './utils.js';"),
}

errori = 0
for p, (a, b) in IMPORT.items():
    s = io.open(p, encoding='utf-8').read()
    if s.count(a) != 1:
        print('!! import non trovato in', p)
        errori += 1
        continue
    io.open(p, 'w', encoding='utf-8').write(s.replace(a, b, 1))

# --- refreshLucideIcons nei punti che inseriscono markup ------------------
DISEGNA = [
 ('public/js/inlineEdit.js',
  "  btn.innerHTML = ICO('link');",
  "  btn.innerHTML = ICO('link');\n  refreshLucideIcons(btn);"),
 ('public/js/insert.js',
  "    : `${ICO('map')} Disegna sulla mappa…`;",
  "    : `${ICO('map')} Disegna sulla mappa…`;\n  refreshLucideIcons(btn);"),
 ('public/js/splitview.js',
  "    bulkDelBtn.innerHTML = `${ICO('trash-2')} Elimina (${selCount})`;",
  "    bulkDelBtn.innerHTML = `${ICO('trash-2')} Elimina (${selCount})`;\n    refreshLucideIcons(bulkDelBtn);"),
]
for p, a, b in DISEGNA:
    s = io.open(p, encoding='utf-8').read()
    if s.count(a) != 1:
        print('!! punto di disegno non trovato in %s: %r' % (p, a[:60]))
        errori += 1
        continue
    io.open(p, 'w', encoding='utf-8').write(s.replace(a, b, 1))

print('errori:', errori)
sys.exit(1 if errori else 0)

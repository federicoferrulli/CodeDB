# -*- coding: utf-8 -*-
"""Passo 8: gli ultimi contenitori senza disegno delle icone."""
import io
import re
import sys

errori = []


def aggiungi_import(percorso, nomi):
    s = io.open(percorso, encoding='utf-8').read()
    m = re.search(r"^import \{([^}]*)\} from '\./utils\.js';", s, re.M)
    if not m:
        errori.append('%s: nessun import da utils.js' % percorso)
        return
    dentro = m.group(1)
    presenti = [x.strip().split(' as ')[0] for x in dentro.split(',')]
    da_agg = [n for n in nomi if n.split(' as ')[0].strip() not in presenti]
    if not da_agg:
        return
    nuovo = "import {%s, %s } from './utils.js';" % (dentro.rstrip().rstrip(','), ', '.join(da_agg))
    io.open(percorso, 'w', encoding='utf-8').write(s[:m.start()] + nuovo + s[m.end():])


def applica(percorso, coppie):
    s = io.open(percorso, encoding='utf-8').read()
    for a, b in coppie:
        n = s.count(a)
        if n != 1:
            errori.append('%s conta=%d : %r' % (percorso, n, a[:78]))
            continue
        s = s.replace(a, b, 1)
    io.open(percorso, 'w', encoding='utf-8').write(s)


for f in ['admin-rbac', 'autocomplete', 'backupmanager', 'cellgrafico',
          'cellselect', 'connection', 'scorciatoie-ui', 'snippet-manager', 'theme']:
    aggiungi_import('public/js/%s.js' % f, ('refreshLucideIcons',))

applica('public/js/admin-rbac.js', [
 ("""    grantDbPills.innerHTML = `<button type="button" class="pill-option active" data-value=""><i data-lucide="globe"></i> Tutti i DB</button>`;""",
  """    grantDbPills.innerHTML = `<button type="button" class="pill-option active" data-value=""><i data-lucide="globe"></i> Tutti i DB</button>`;
    refreshLucideIcons(grantDbPills);"""),
 ("""    apikeyPills.innerHTML = `<button type="button" class="pill-option active" data-value=""><i data-lucide="globe"></i> Tutte le connessioni concesse</button>${connItems}`;""",
  """    apikeyPills.innerHTML = `<button type="button" class="pill-option active" data-value=""><i data-lucide="globe"></i> Tutte le connessioni concesse</button>${connItems}`;
    refreshLucideIcons(apikeyPills);"""),
])

applica('public/js/autocomplete.js', [
 ("""    li.append(icona, testo);""",
  """    li.append(icona, testo);
    refreshLucideIcons(li);"""),
])

print('passo 8 — import e disegni base')
for e in errori:
    print('!!', e)
sys.exit(1 if errori else 0)

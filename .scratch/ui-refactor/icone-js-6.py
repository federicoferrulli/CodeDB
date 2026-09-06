# -*- coding: utf-8 -*-
"""
Passo 6: import di `ICO` e chiamata a `refreshLucideIcons` dove il markup con
le icone viene inserito. Senza la seconda, l'<i data-lucide> resta un elemento
vuoto: un buco al posto dell'icona, senza alcun errore.
"""
import io
import re
import sys

errori = []


def aggiungi_import(percorso, nomi=('lucideIconHtml as ICO',)):
    """Aggiunge i nomi all'import da './utils.js' gia' presente nel file."""
    s = io.open(percorso, encoding='utf-8').read()
    m = re.search(r"^import \{([^}]*)\} from '\./utils\.js';", s, re.M)
    if not m:
        errori.append('%s: nessun import da utils.js' % percorso)
        return
    dentro = m.group(1)
    da_aggiungere = [n for n in nomi if n.split(' as ')[0].strip() not in
                     [x.strip().split(' as ')[0] for x in dentro.split(',')]]
    if not da_aggiungere:
        return
    nuovo = "import {%s, %s } from './utils.js';" % (dentro.rstrip().rstrip(','), ', '.join(da_aggiungere))
    s = s[:m.start()] + nuovo + s[m.end():]
    io.open(percorso, 'w', encoding='utf-8').write(s)


def applica(percorso, coppie):
    s = io.open(percorso, encoding='utf-8').read()
    for a, b in coppie:
        n = s.count(a)
        if n != 1:
            errori.append('%s conta=%d : %r' % (percorso, n, a[:78]))
            continue
        s = s.replace(a, b, 1)
    io.open(percorso, 'w', encoding='utf-8').write(s)


for f in ['connmanager', 'graph3d', 'health', 'pending-queries', 'qe-history',
          'query-tab', 'script-run', 'sessions']:
    aggiungi_import('public/js/%s.js' % f,
                    ('lucideIconHtml as ICO', 'refreshLucideIcons'))

print('import aggiunti')
for e in errori:
    print('!!', e)
sys.exit(1 if errori else 0)

# -*- coding: utf-8 -*-
"""Le due sostituzioni rimaste dal passo 4 (avevo sbagliato io il testo atteso)."""
import io
import sys

errori = []


def applica(percorso, coppie):
    s = io.open(percorso, encoding='utf-8').read()
    for a, b in coppie:
        n = s.count(a)
        if n != 1:
            errori.append('%s conta=%d : %r' % (percorso, n, a[:80]))
            continue
        s = s.replace(a, b, 1)
    io.open(percorso, 'w', encoding='utf-8').write(s)


applica('public/js/pending-queries.js', [
 ("fermata\">\U0001f4cd DA QUI CI SI È FERMATI</span>",
  "fermata\">${ICO('map-pin')} DA QUI CI SI È FERMATI</span>"),
])

applica('public/js/qe-history.js', [
 ("    : 'Query ripristinata: premi ▶ Esegui per lanciarla');",
  "    : 'Query ripristinata: premi «Esegui» per lanciarla');"),
])

for e in errori:
    print('!!', e)
print('non applicate:', len(errori))
sys.exit(1 if errori else 0)

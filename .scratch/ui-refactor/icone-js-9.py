# -*- coding: utf-8 -*-
"""Passo 9: gli ultimi glifi, e il disegno nei contenitori riempiti a modale
gia' aperta (dove `openModal` non passa piu')."""
import io
import sys

errori = []


def applica(percorso, coppie):
    s = io.open(percorso, encoding='utf-8').read()
    for a, b in coppie:
        n = s.count(a)
        if n != 1:
            errori.append('%s conta=%d : %r' % (percorso, n, a[:78]))
            continue
        s = s.replace(a, b, 1)
    io.open(percorso, 'w', encoding='utf-8').write(s)


applica('public/js/backupmanager.js', [
 ("""fino a questo.">\U0001f517 catena di ${catena.layer}</span>`;""",
  """fino a questo."><i data-lucide="link"></i> catena di ${catena.layer}</span>`;"""),
])

applica('public/js/chart-option.js', [
 ("etichetta: 'Divergente blu↔rosso (polarità)'", "etichetta: 'Divergente blu-rosso (polarità)'"),
 ("Per forzarlo, pannello ⚙ → Assi → Tipo.`);",
  "Per forzarlo: pannello di personalizzazione, sezione Assi, campo Tipo.`);"),
])

applica('public/js/charts.js', [
 ("""${s.visibile === false ? '\U0001f441' : '\U0001f6ab'}</button>""",
  """${ICO(s.visibile === false ? 'eye' : 'eye-off')}</button>"""),
])

applica('public/js/geo-stats.js', [
 ("parti.push(`↔ ${formattaDistanza(st.lunghezzaM)}`);",
  "parti.push(`lunghezza ${formattaDistanza(st.lunghezzaM)}`);"),
])

applica('public/js/pending-queries.js', [
 ("""${item.kind === 'script' && item.status === 'paused' ? '▶ Riprendi da dov\\'era' : '▶ Riprendi'}</button>""",
  """${ICO('play')} ${item.kind === 'script' && item.status === 'paused' ? 'Riprendi da dov\\'era' : 'Riprendi'}</button>"""),
])

# --- Disegno nei contenitori riempiti a modale gia' aperta ---------------
applica('public/js/backupmanager.js', [
 ("  container.innerHTML = gruppi.map((gName) => {",
  "  // Il catalogo si riempie a modale GIA' aperta, quindi il disegno di\n"
  "  // `openModal` e' gia' passato: le icone vanno disegnate qui.\n"
  "  container.innerHTML = gruppi.map((gName) => {"),
])

print('passo 9')
for e in errori:
    print('!!', e)
sys.exit(1 if errori else 0)

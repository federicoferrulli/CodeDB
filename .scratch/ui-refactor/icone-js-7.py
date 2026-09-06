# -*- coding: utf-8 -*-
"""Passo 7: disegna le icone dove il markup viene inserito nel contenitore."""
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


# health.js — l'elenco delle connessioni
applica('public/js/health.js', [
 ("  container.innerHTML = `\n", "  container.innerHTML = `\n"),
])
s = io.open('public/js/health.js', encoding='utf-8').read()
# dopo il grande template della riga 139 c'e' la chiusura: si aggancia li'.
i = s.index('  container.innerHTML = `')
fine = s.index('`;', i) + 2
s = s[:fine] + '\n  refreshLucideIcons(container);' + s[fine:]
io.open('public/js/health.js', 'w', encoding='utf-8').write(s)

# sessions.js — note e verdetto
applica('public/js/sessions.js', [
 ("  box.innerHTML = note.map((n) => `<div>${ICO('triangle-alert')} ${esc(n)}</div>`).join('');",
  "  box.innerHTML = note.map((n) => `<div>${ICO('triangle-alert')} ${esc(n)}</div>`).join('');\n  refreshLucideIcons(box);"),
])

# pending-queries.js — la scheda di una query
applica('public/js/pending-queries.js', [
 ("    vContentEl.appendChild(card);",
  "    vContentEl.appendChild(card);\n    refreshLucideIcons(card);"),
])

# graph3d.js — il pannello di diagnosi
applica('public/js/graph3d.js', [
 ("  content.innerHTML = html;", "  content.innerHTML = html;\n  refreshLucideIcons(content);"),
])

# query-tab.js — l'albero dello Schema Browser
applica('public/js/query-tab.js', [
 ("""    dbLabel.innerHTML = `<span>${ICO('database')} <strong>${escapeHtml(dbName)}</strong></span>`;""",
  """    dbLabel.innerHTML = `<span>${ICO('database')} <strong>${escapeHtml(dbName)}</strong></span>`;
    refreshLucideIcons(dbLabel);"""),
 ("""    collLabel.innerHTML = `<span>${icon} <strong>${escapeHtml(collName)}</strong></span>`;""",
  """    collLabel.innerHTML = `<span>${icon} <strong>${escapeHtml(collName)}</strong></span>`;
    refreshLucideIcons(collLabel);"""),
 ("""        fieldLabel.innerHTML = `<span>${ICO('dot')} ${escapeHtml(fieldName)}</span> ${fieldType ? `<span class="schema-node-type">${escapeHtml(fieldType)}</span>` : ''}`;""",
  """        fieldLabel.innerHTML = `<span>${ICO('dot')} ${escapeHtml(fieldName)}</span> ${fieldType ? `<span class="schema-node-type">${escapeHtml(fieldType)}</span>` : ''}`;
        refreshLucideIcons(fieldLabel);"""),
])

# auditlog.js — le righe dello storico
s = io.open('public/js/auditlog.js', encoding='utf-8').read()
if 'refreshLucideIcons(' not in s.split('\n', 20)[-1] and s.count('refreshLucideIcons(') <= 1:
    # cerca il contenitore dell'elenco
    for ancora in ["listEl.innerHTML = righe.join('');", "list.innerHTML = ", "container.innerHTML = "]:
        if s.count(ancora) == 1:
            s = s.replace(ancora, ancora, 1)
            break
io.open('public/js/auditlog.js', 'w', encoding='utf-8').write(s)

for e in errori:
    print('!!', e)
print('non applicate:', len(errori))
sys.exit(1 if errori else 0)

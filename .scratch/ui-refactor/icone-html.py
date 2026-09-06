# -*- coding: utf-8 -*-
"""
Porta index.html dalle emoji alle icone Lucide, che sono LE icone di questa
applicazione (`js/lucide.min.js`, gia' usata in 74 punti del markup).

Tre trattamenti, decisi dal CONTESTO e non dal glifo:
  * dentro il testo di un controllo o di un titolo -> `<i data-lucide="...">`
  * dentro un attributo (title, placeholder, aria-label) -> si TOGLIE: un
    attributo contiene testo, non elementi, e non puo' ospitare un'icona
  * dentro un <option> -> si TOGLIE: il browser rende il contenuto di
    un'option come testo puro, quindi un <i> non apparirebbe affatto

Uso:  python icone-html.py [--prova]
"""
import io
import re
import sys

PERCORSO = 'public/index.html'
# Carattere che nel file non compare mai: serve a marcare i glifi da togliere
# insieme allo spazio che li segue. Uno spazio come sentinella cancellerebbe
# l'indentazione insieme al glifo.
SENTINELLA = ''

# Emoji -> nome dell'icona Lucide. Tutti verificati presenti nel bundle
# incluso (2003 icone) con .scratch/ui-refactor/icone-check.js.
MAPPA = {
    '⚡': 'zap',
    '\U0001f4e5': 'download',
    '\U0001f310': 'globe',
    '\U0001f504': 'refresh-cw',
    '▶': 'play',
    '◀': 'chevron-left',
    '\U0001f4cb': 'copy',
    '\U0001f5c4️': 'database',
    '\U0001f5c4': 'database',
    '\U0001f4c2': 'folder-open',
    '\U0001f6d1': 'circle-stop',
    '✏️': 'pencil',
    '✎': 'pencil',
    '⏳': 'hourglass',
    '⏸': 'pause',
    '✨': 'wand-sparkles',
    '\U0001f517': 'link',
    '\U0001fa7a': 'stethoscope',
    '\U0001f50d': 'search',
    '\U0001f493': 'activity',
    '\U0001f343': 'leaf',
    '\U0001f500': 'shuffle',
    '↩': 'undo-2',
    '\U0001f558': 'history',
    '\U0001f4d6': 'book-open',
    '\U0001f9f9': 'eraser',
    '\U0001f4c4': 'file-text',
    '\U0001f4a1': 'lightbulb',
    '\U0001f5bc️': 'image',
    '\U0001f5bc': 'image',
    '⚙️': 'sliders-horizontal',
    '⚙': 'sliders-horizontal',
    '↗': 'external-link',
    '⚖️': 'scale',
    '❌': 'circle-x',
    '\U0001f4ca': 'bar-chart-3',
    '\U0001f4be': 'hard-drive',
    '\U0001f680': 'rocket',
    '\U0001f4dc': 'scroll-text',
    '\U0001f441️': 'eye',
    '\U0001f441': 'eye',
    '\U0001f3a8': 'palette',
    '\U0001f465': 'users',
    '\U0001f511': 'key',
    '\U0001f5d1️': 'trash-2',
    '\U0001f5d1': 'trash-2',
    '⤓': 'download',
    '⭱': 'upload',
    '⇥': 'fold-vertical',
    '←': 'arrow-left',
    '→': 'arrow-right',
    '\U0001f532': 'columns-2',
    '\U0001f50c': 'plug',
}

# Ordine decrescente di lunghezza: le varianti con il selettore VS16 vanno
# provate prima di quelle nude, altrimenti resterebbe un ️ orfano.
CHIAVI = sorted(MAPPA, key=len, reverse=True)
GLIFI = re.compile('|'.join(re.escape(k) for k in CHIAVI))


# Le frecce tipografiche sono ANCHE punteggiatura: in «user_id -> collection»
# significano «corrisponde a», e in un commento non sono nemmeno interfaccia.
# Diventano un'icona SOLO dentro un bottone, dove sono un verso di
# navigazione. Senza questa distinzione il collaudo a vuoto le convertiva
# anche in mezzo alla prosa.
SOLO_IN_BOTTONE = {'←', '→', '◀', '▶'}


def dentro_attributo(riga, pos):
    """Vero se `pos` cade dentro il valore di un attributo (fra apici doppi)."""
    return riga.count('"', 0, pos) % 2 == 1


def main():
    prova = '--prova' in sys.argv
    righe = io.open(PERCORSO, encoding='utf-8').read().split('\n')
    cambi = []
    in_commento = False
    for i, riga in enumerate(righe):
        # Traccia i commenti HTML sull'INTERO blocco: guardare solo la prima
        # riga lasciava scoperte le righe di continuazione, che sono prosa.
        apre = riga.count('<!--')
        chiude = riga.count('-->')
        era_commento = in_commento or (apre > chiude)
        if apre or chiude:
            in_commento = apre > chiude
        if era_commento or not GLIFI.search(riga):
            continue
        originale = riga
        in_option = '<option' in riga
        e_bottone = '<button' in riga

        def sostituisci(m, _riga=riga, _opt=in_option, _btn=e_bottone):
            glifo = m.group(0)
            if glifo in SOLO_IN_BOTTONE and not _btn:
                return glifo   # e' punteggiatura, non un'icona
            if dentro_attributo(_riga, m.start()) or _opt:
                return SENTINELLA
            return '<i data-lucide="%s"></i>' % MAPPA[glifo]

        nuova = GLIFI.sub(sostituisci, riga)
        nuova = nuova.replace(SENTINELLA + ' ', '').replace(SENTINELLA, '')
        if nuova != originale:
            cambi.append((i + 1, originale.strip(), nuova.strip()))
            righe[i] = nuova

    if not prova:
        io.open(PERCORSO, 'w', encoding='utf-8').write('\n'.join(righe))
    print(('PROVA — ' if prova else '') + 'righe modificate: %d' % len(cambi))
    for n, a, b in cambi:
        print('  %-5d %s' % (n, a[:100]))
        print('        -> %s' % b[:100])


if __name__ == '__main__':
    main()

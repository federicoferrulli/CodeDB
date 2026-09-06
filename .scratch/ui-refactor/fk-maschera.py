# -*- coding: utf-8 -*-
"""L'indicatore delle chiavi esterne passa dall'emoji a una maschera SVG."""
import io

p = 'public/css/style.css'
s = io.open(p, encoding='utf-8').read()

LINK = ('url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20'
        'viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20'
        'stroke-width%3D%222.4%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E'
        '%3Cpath%20d%3D%22M10%2013a5%205%200%200%200%207.54.54l3-3a5%205%200%200%200-7.07-7.07l-1.72%201.71%22%2F%3E'
        '%3Cpath%20d%3D%22M14%2011a5%205%200%200%200-7.54-.54l-3%203a5%205%200%200%200%207.07%207.07l1.71-1.71%22%2F%3E'
        '%3C%2Fsvg%3E")')

APPROX = ('url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20'
          'viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20'
          'stroke-width%3D%222.4%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E'
          '%3Cpath%20d%3D%22M5%2015a6.5%206.5%200%200%201%207%200%206.5%206.5%200%200%200%207%200%22%2F%3E'
          '%3Cpath%20d%3D%22M5%209a6.5%206.5%200%200%201%207%200%206.5%206.5%200%200%200%207%200%22%2F%3E'
          '%3C%2Fsvg%3E")')

vecchio = """td.fk-cella::after {
  content: '\U0001f517';
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.72em;
  opacity: 0.55;
  pointer-events: none;
}
/* Il collegamento solo ipotizzato (MongoDB) si distingue da quello dichiarato:
   presentare un'ipotesi come certezza fa fidare di un riferimento inesistente. */
td.fk-cella.fk-ipotesi::after { content: '≈'; opacity: 0.5; }"""

nuovo = """/* L'indicatore e' l'icona `link` dell'applicazione, applicata come MASCHERA e
   colorata con `currentColor`: cosi' segue il tema e il colore della cella,
   cosa che un'emoji nel `content` non fa — ha colori propri, cambia forma da un
   sistema all'altro, e in una colonna di celle non si allinea. La maschera
   conserva la ragione per cui questo indicatore e' uno pseudo-elemento: nessun
   nodo in piu' per cella. Un `background-image` non andrebbe bene, perche' li'
   `currentColor` non arriva. */
td.fk-cella::after {
  content: '';
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
  width: 11px;
  height: 11px;
  background-color: currentColor;
  -webkit-mask: __LINK__ center / contain no-repeat;
  mask: __LINK__ center / contain no-repeat;
  opacity: 0.55;
  pointer-events: none;
}
/* Il collegamento solo ipotizzato (MongoDB) si distingue da quello dichiarato:
   presentare un'ipotesi come certezza fa fidare di un riferimento inesistente.
   Il segno resta il «circa uguale», ma tracciato con la stessa matita delle
   altre icone invece che preso dal carattere tipografico. */
td.fk-cella.fk-ipotesi::after {
  -webkit-mask-image: __APPROX__;
  mask-image: __APPROX__;
  opacity: 0.5;
}"""

nuovo = nuovo.replace('__LINK__', LINK).replace('__APPROX__', APPROX)

assert s.count(vecchio) == 1, s.count(vecchio)
s = s.replace(vecchio, nuovo, 1)
s = s.replace("/* Pulsante \U0001f517 accanto all'editor inline della cella. */",
              "/* Pulsante di apertura del riferimento, accanto all'editor inline della cella. */", 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('indicatore FK convertito a maschera')

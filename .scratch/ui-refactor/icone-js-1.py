# -*- coding: utf-8 -*-
"""Passo 1: i punti CENTRALI — toast e albero JSON in utils.js."""
import io

p = 'public/js/utils.js'
s = io.open(p, encoding='utf-8').read()

# --- Toast -----------------------------------------------------------------
a = """  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️'
  };

  const iconSpan = document.createElement('span');
  iconSpan.textContent = icons[type] || 'ℹ️';
"""
b = """  // Icone dell'applicazione, non emoji: un pittogramma cambia forma e
  // larghezza da un sistema all'altro, e un lettore di schermo lo pronuncia
  // («segno di spunta bianco pesante Backup completato»). Qui e' `aria-hidden`
  // perche' il tipo del toast e' gia' detto dal testo e dal colore.
  const ICONE = {
    success: 'circle-check',
    error: 'circle-x',
    info: 'info',
    warning: 'triangle-alert',
  };

  const iconSpan = document.createElement('i');
  iconSpan.dataset.lucide = ICONE[type] || ICONE.info;
  iconSpan.className = 'toast-icona';
  iconSpan.setAttribute('aria-hidden', 'true');
"""
assert s.count(a) == 1, s.count(a)
s = s.replace(a, b, 1)

# Il toast va disegnato dopo l'inserimento, altrimenti l'<i> resta vuoto.
a2 = """  toast.appendChild(iconSpan);
  toast.appendChild(textSpan);
"""
b2 = """  toast.appendChild(iconSpan);
  toast.appendChild(textSpan);
"""
assert s.count(a2) == 1

# --- Albero JSON: gli espansori ---------------------------------------------
a3 = """    const toggle = document.createElement('span');
    toggle.className = 'json-toggle';
    toggle.textContent = isRoot ? '▼ ' : '▶ ';
"""
b3 = """    // Il verso dell'espansore e' un'icona dell'applicazione: `▶`/`▼` sono
    // caratteri tipografici, e la loro larghezza cambia col carattere in uso,
    // quindi le chiavi dell'albero non si allineavano fra un livello e l'altro.
    const toggle = document.createElement('i');
    toggle.className = 'json-toggle';
    toggle.dataset.lucide = isRoot ? 'chevron-down' : 'chevron-right';
    toggle.setAttribute('aria-hidden', 'true');
"""
assert s.count(a3) == 1
s = s.replace(a3, b3, 1)

a4 = """      const isHidden = childrenWrap.classList.toggle('hidden');
      toggle.textContent = isHidden ? '▶ ' : '▼ ';
"""
b4 = """      const isHidden = childrenWrap.classList.toggle('hidden');
      // `createIcons` ha sostituito l'<i> con un <svg>: si riscrive l'attributo
      // sul nodo che c'e' ADESSO e lo si ridisegna, invece di cercare l'<i>
      // originale, che non e' piu' nel documento.
      const segno = header.querySelector('.json-toggle');
      if (segno) {
        segno.outerHTML = `<i class="json-toggle" data-lucide="${isHidden ? 'chevron-right' : 'chevron-down'}" aria-hidden="true"></i>`;
        refreshLucideIcons(header);
      }
"""
assert s.count(a4) == 1
s = s.replace(a4, b4, 1)

# `header.prepend(toggle)` inserisce l'<i>: va disegnato.
a5 = """    header.innerHTML = `${keySpan}${bracketOpen} ${countText}`;
    header.prepend(toggle);
"""
b5 = """    header.innerHTML = `${keySpan}${bracketOpen} ${countText}`;
    header.prepend(toggle);
    refreshLucideIcons(header);
"""
assert s.count(a5) == 1
s = s.replace(a5, b5, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('utils.js fatto')

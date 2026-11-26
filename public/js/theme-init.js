'use strict';

// Applicazione sincrona del tema PRIMA del primo paint (evita il lampo FOUC)
// in file esterno per consentire una Content-Security-Policy senza 'unsafe-inline'
// su script-src. Le chiavi coincidono con `theme.js` (`chiaveStorage`).
(function () {
  try {
    var scelto = localStorage.getItem('codedb:tema') || 'auto';
    var base;
    if (scelto === 'light' || scelto === 'dark') {
      base = scelto;
    } else if (scelto === 'auto') {
      base = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light' : 'dark';
    } else {
      var temi = JSON.parse(localStorage.getItem('codedb:temi') || '{}');
      base = temi[scelto] && temi[scelto].base === 'light' ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', base);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

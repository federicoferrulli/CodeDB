// Un solo rettangolo utile per layout, modali e menu. Il pinch zoom resta al
// browser: non ridimensioniamo l'app mentre l'utente la sta ingrandendo.
export function initViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const aggiorna = () => {
    if (vv && Math.abs(vv.scale - 1) > 0.01) return;
    root.style.setProperty('--pagina-altezza', `${window.innerHeight}px`);
    root.style.setProperty('--vista-top', `${vv?.offsetTop || 0}px`);
    root.style.setProperty('--vista-bottom', `${Math.max(0, window.innerHeight - (vv?.height || window.innerHeight) - (vv?.offsetTop || 0))}px`);
  };
  aggiorna();
  window.addEventListener('resize', aggiorna);
  vv?.addEventListener('resize', aggiorna);
  vv?.addEventListener('scroll', aggiorna);
}

export function limitiViewport() {
  const css = getComputedStyle(document.documentElement);
  const px = name => parseFloat(css.getPropertyValue(name)) || 0;
  const vv = window.visualViewport;
  return {
    left: (vv?.offsetLeft || 0) + px('--sal'),
    right: (vv?.offsetLeft || 0) + (vv?.width || window.innerWidth) - px('--sar'),
    top: (vv?.offsetTop || 0) + px('--sat'),
    bottom: Math.min((vv?.offsetTop || 0) + (vv?.height || window.innerHeight), window.innerHeight - px('--sab')),
  };
}

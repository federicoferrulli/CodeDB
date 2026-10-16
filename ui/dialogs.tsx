import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import { Dialog, DialogContent } from './components/arc/dialog/dialog';
import { BottomSheet } from './components/arc/bottom-sheet/bottom-sheet';
import { useReducedMotion } from 'motion/react';
import { motionTokens } from './components/arc/motion-tokens';

// I pannelli contengono editor, mappe e form imperativi. Si sposta lo STESSO
// nodo nel portal Arc: listener, valori, selezioni e riferimenti restano validi.
function Pannello({ panel, overlay }: { panel: HTMLElement; overlay: HTMLElement }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    const scroll = panel.scrollTop;
    slot.current!.append(panel);
    panel.scrollTop = scroll;
    // I popup degli editor fanno parte della finestra attiva: restando nel
    // body sarebbero fuori dal focus trap Radix e non più utilizzabili.
    const auxiliary = (overlay.id === 'palette-overlay' ? [] : [...document.querySelectorAll<HTMLElement>('#fk-pannello, .ac-flottante, #context-menu')])
      .map(node => ({ node, parent: node.parentNode!, next: node.nextSibling }));
    for (const { node } of auxiliary) slot.current!.append(node);
    if (focused && panel.contains(focused)) focused.focus({ preventScroll: true });
    return () => {
      for (const { node, parent, next } of auxiliary) {
        if (node.parentNode === slot.current) (parent.isConnected ? parent : document.body).insertBefore(node, next?.parentNode === parent && parent.isConnected ? next : null);
      }
      overlay.prepend(panel);
    };
  }, [panel, overlay]);
  return <div ref={slot} className="arc-panel-slot" />;
}

const barriers = ['login-overlay', 'vault-overlay', 'conn-error-overlay'];

export function removeDialog(overlay: HTMLElement) {
  if (!overlay.dataset.arcDialog) { overlay.remove(); return; }
  overlay.addEventListener('codedb:dialog-closed', () => overlay.remove(), { once: true });
  overlay.classList.add('hidden');
}

function Finestra({ open, panel, overlay, dismiss, restoreFocus, onExitComplete }: {
  open: boolean; panel: HTMLElement; overlay: HTMLElement; dismiss: () => void; restoreFocus: () => void; onExitComplete: () => void;
}) {
  const [mobile, setMobile] = useState(() => !document.documentElement.classList.contains('embedded-panel') && window.matchMedia('(max-width: 900px)').matches);
  const reduced = useReducedMotion();
  const format = useRef(mobile);
  const animations = useRef<Animation[]>([]);
  const complete = useRef(onExitComplete);
  complete.current = onExitComplete;
  useLayoutEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const update = () => setMobile(!document.documentElement.classList.contains('embedded-panel') && media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    const changedFormat = format.current !== mobile;
    format.current = mobile;
    // Un nuovo contenitore già chiuso non emette un evento di fine uscita.
    if (!open && changedFormat) { complete.current(); return; }
    if (mobile) return;
    const running = animations.current.length > 0;
    const opacity = running ? getComputedStyle(overlay).opacity : open ? '0' : '1';
    const transform = running ? getComputedStyle(panel).transform : open ? 'translateY(8px) scale(.99)' : 'none';
    animations.current.forEach(animation => animation.cancel());
    const duration = (reduced ? motionTokens.surface.reduced : open ? motionTokens.surface.dialogEnter : motionTokens.surface.dialogExit) * 1000;
    const options: KeyframeAnimationOptions = { duration, easing: open ? 'cubic-bezier(.16, 1, .3, 1)' : 'cubic-bezier(.4, 0, 1, 1)', fill: 'both' };
    const layers = [overlay.animate([{ opacity }, { opacity: open ? 1 : 0 }], options)];
    if (!reduced) layers.push(panel.animate([{ transform }, { transform: open ? 'none' : 'translateY(6px) scale(.995)' }], options));
    animations.current = layers;
    Promise.all(layers.map(animation => animation.finished)).then(() => {
      if (!open) complete.current();
      layers.forEach(animation => animation.cancel());
      if (animations.current === layers) animations.current = [];
    }).catch(() => { /* Una riapertura riparte dal fotogramma corrente. */ });
  }, [open, mobile, reduced, overlay, panel]);
  useLayoutEffect(() => () => {
    animations.current.forEach(animation => animation.cancel());
    animations.current = [];
  }, [mobile]);
  const heading = panel.querySelector<HTMLElement>('h1, h2, h3');
  if (heading) heading.dataset.arcSheetHeading = '';
  const title = heading?.textContent?.trim() || (overlay.id === 'palette-overlay' ? 'Cerca database, tabelle e comandi' : 'CodeDB');
  const events = {
    onOpenAutoFocus: (event: Event) => {
      if (overlay.contains(document.activeElement) && document.activeElement !== document.body) event.preventDefault();
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      // Il cambio di formato conserva il focus nel form, la chiusura lo restituisce.
      if (overlay.classList.contains('hidden') || !overlay.isConnected) restoreFocus();
    },
    onPointerDownOutside: (event: Event) => { if (overlay.id !== 'palette-overlay') event.preventDefault(); },
    onEscapeKeyDown: (event: KeyboardEvent) => event.preventDefault(),
  };
  const children = <Pannello panel={panel} overlay={overlay} />;
  const onOpenChange = (value: boolean) => { if (!value) dismiss(); };
  return mobile
    ? <BottomSheet open={open} onOpenChange={onOpenChange} onExitComplete={onExitComplete} container={overlay} title={title}
        fitContent={overlay.id === 'modal-health' || (overlay.id === 'onboarding-overlay' && !!panel.querySelector('.onb-hub, .onb-benvenuto'))}
        dismissible={!barriers.includes(overlay.id)} detents={[.7, .94]}
        initialDetent={['geomap-overlay', 'geomulti-overlay', 'modal-theme', 'modal-backup-manager', 'modal-sessions', 'modal-pending', 'session-query-overlay'].includes(overlay.id) || (window.visualViewport?.height ?? window.innerHeight) < 600 ? 1 : 0}
        className="arc-dialog-sheet" closeLabel="Chiudi finestra" {...events}>{children}</BottomSheet>
    : <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent embedded container={overlay} className="arc-dialog-shell" title={title}
          aria-labelledby={heading?.id} {...events}>{children}</DialogContent>
      </Dialog>;
}

export function initDialogs() {
  const registry = new Map<HTMLElement, { sync: () => void; dispose: () => void }>();
  const opened: HTMLElement[] = [];
  const focusedByOverlay = new WeakMap<HTMLElement, HTMLElement>();
  let titleSequence = 0;
  const restack = () => opened.forEach((overlay, index) => {
    overlay.style.zIndex = `calc(var(--z-modal) + ${(index + 1) * 2})`;
    // I contenitori esistono già quando Radix apre il dialogo precedente e
    // nasconde i suoi fratelli. Quello che diventa attivo non può ereditare
    // aria-hidden da allora; gli altri restano schermati dal dialogo in cima.
    if (index === opened.length - 1) {
      overlay.removeAttribute('aria-hidden');
      overlay.removeAttribute('data-aria-hidden');
    } else overlay.setAttribute('aria-hidden', 'true');
  });
  let outsideFocus: HTMLElement | null = document.activeElement as HTMLElement;
  document.addEventListener('focusin', e => {
    const el = e.target as HTMLElement;
    if (!el.closest('.overlay, .palette-overlay')) outsideFocus = el;
    for (const overlay of opened) if (overlay.contains(el)) focusedByOverlay.set(overlay, el);
  });

  function dismiss(overlay: HTMLElement) {
    // Login e vault sono barriere reali, non finestre annullabili.
    if (barriers.includes(overlay.id)) return;
    if (overlay.id === 'palette-overlay') { overlay.dispatchEvent(new Event('codedb:close-dialog')); return; }
    const close = overlay.querySelector<HTMLButtonElement>(
      'button[id$="-cancel"]:not(#conn-edit-cancel), button[id$="-cancel-btn"], button[id$="-close"], button[id$="-close-btn"], button[id$="-chiudi"], button[id^="btn-close-"], .close-compare-btn, [data-azione="chiudi"]'
    );
    if (close) { if (!close.disabled) close.click(); }
    else overlay.classList.add('hidden');
  }

  function register(overlay: HTMLElement) {
    if (registry.has(overlay) || overlay.dataset.arcOwned) return;
    const panel = overlay.querySelector<HTMLElement>(':scope > .modal, :scope > .palette');
    if (!panel) return;
    const host = document.createElement('span');
    host.className = 'arc-dialog-root';
    overlay.append(host);
    const root = createRoot(host);
    const originalZIndex = overlay.style.zIndex;
    let isOpen = false;
    let returnFocus: HTMLElement | null = null;
    const finish = () => queueMicrotask(() => {
      if (isOpen) return;
      flushSync(() => root.render(null));
      const index = opened.indexOf(overlay);
      if (index >= 0) opened.splice(index, 1);
      delete overlay.dataset.arcDialog;
      overlay.style.zIndex = originalZIndex;
      restack();
      overlay.dispatchEvent(new Event('codedb:dialog-closed'));
    });
    const sync = () => {
      const next = !overlay.classList.contains('hidden');
      if (next === isOpen) return;
      isOpen = next;
      if (next) {
        const active = document.activeElement as HTMLElement | null;
        if (!opened.includes(overlay)) {
          const parent = opened.filter(item => !item.classList.contains('hidden')).at(-1);
          returnFocus = active && !overlay.contains(active) && active !== document.body
            ? active : (parent && focusedByOverlay.get(parent)) || outsideFocus;
          opened.push(overlay);
        }
        restack();
        overlay.dataset.arcDialog = 'open';
      } else {
        overlay.dataset.arcDialog = 'closing';
      }
      // Il portal ha il ruolo e il titolo; il contenitore conserva ID e classi pubblici.
      overlay.removeAttribute('role');
      overlay.removeAttribute('aria-modal');
      const heading = panel.querySelector<HTMLElement>('h2, h3');
      if (heading && !heading.id) heading.id = `arc-dialog-title-${++titleSequence}`;
      flushSync(() => root.render(
        <Finestra open={next} panel={panel} overlay={overlay} dismiss={() => dismiss(overlay)} onExitComplete={finish}
          restoreFocus={() => {
            const top = opened.filter(item => !item.classList.contains('hidden')).at(-1);
            if (returnFocus?.isConnected && (!top || top.contains(returnFocus))) returnFocus.focus({ preventScroll: true });
          }} />
      ));
      restack();
    };
    const observer = new MutationObserver(sync);
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    registry.set(overlay, { sync, dispose: () => { observer.disconnect(); root.unmount(); host.remove(); } });
    sync();
  }

  document.querySelectorAll<HTMLElement>('.overlay, .palette-overlay').forEach(register);
  // Solo i nodi aggiunti/rimossi: nessuna scansione delle righe durante gli aggiornamenti.
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches('.overlay, .palette-overlay')) register(node);
      node.querySelectorAll<HTMLElement>('.overlay, .palette-overlay').forEach(register);
    }
    for (const [overlay, entry] of registry) if (!overlay.isConnected) {
      entry.dispose(); registry.delete(overlay);
      const index = opened.indexOf(overlay);
      if (index >= 0) { opened.splice(index, 1); restack(); }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Un Escape chiude solo la finestra superiore, passando dal vero annullamento
  // (che risolve anche le Promise di conferma), mai dai vecchi handler globali.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !opened.length) return;
    // Escape appartiene prima al menu del campo, poi alla finestra che lo contiene.
    if (document.querySelector('[data-arc-select-popup], [data-arc-calendar-popup]:popover-open, [data-arc-color-popup]:popover-open')) return;
    if (document.querySelector('.scorciatoie-riga.attiva, .ac-list:not(.hidden)')) return;
    if ((e.target as Element).closest('details[data-escape-close][open]')) return;
    const fk = document.querySelector<HTMLElement>('#fk-pannello[aria-hidden="false"]');
    if (fk) { e.preventDefault(); e.stopImmediatePropagation(); document.getElementById('fk-close')?.click(); return; }
    const context = document.querySelector<HTMLElement>('#context-menu:not(.hidden)');
    if (context) return; // Il menu ripristina il focus al proprio comando di apertura.
    e.preventDefault(); e.stopImmediatePropagation();
    const top = opened.filter(overlay => !overlay.classList.contains('hidden')).at(-1);
    if (top) dismiss(top);
  }, true);
}

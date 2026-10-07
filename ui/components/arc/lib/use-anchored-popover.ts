import { useLayoutEffect, useRef, type RefObject } from 'react';

// CodeDB: il top layer evita il ritaglio nei pannelli scorrevoli e resta nel
// sottoalbero del dialogo, quindi Radix conserva correttamente il focus.
export function useAnchoredPopover(open: boolean, anchor: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, onDismiss: () => void) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    const target = panel.current, trigger = anchor.current;
    if (!target || !trigger || !open) return;
    target.showPopover?.();
    const position = () => {
      if (!trigger.getClientRects().length) { dismiss.current(); return; }
      const box = trigger.getBoundingClientRect();
      target.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - target.offsetWidth - 8))}px`;
      target.style.top = `${Math.max(8, Math.min(box.bottom + 4, window.innerHeight - target.offsetHeight - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(target);
    observer.observe(trigger);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      if (target.hidePopover && target.matches(':popover-open')) target.hidePopover();
    };
  }, [open, anchor, panel]);
}

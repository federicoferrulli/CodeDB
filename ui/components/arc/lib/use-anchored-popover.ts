import { useLayoutEffect, useRef, type RefObject } from 'react';
import { limitiViewport } from '../../../../public/js/viewport.js';

// CodeDB: il top layer evita il ritaglio nei pannelli scorrevoli e resta nel
// sottoalbero del dialogo, quindi Radix conserva correttamente il focus.
export function useAnchoredPopover(open: boolean, anchor: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, onDismiss: () => void) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    const target = panel.current, trigger = anchor.current;
    if (!target || !trigger || !open) return;
    const position = () => {
      if (!trigger.getClientRects().length) {
        if (target.matches(':popover-open')) target.hidePopover?.();
        dismiss.current(); return;
      }
      if (!target.matches(':popover-open')) target.showPopover?.();
      const box = trigger.getBoundingClientRect();
      const { left, top, right, bottom } = limitiViewport();
      const below = box.bottom + 4;
      const y = below + target.offsetHeight > bottom - 8 ? box.top - target.offsetHeight - 4 : below;
      target.style.left = `${Math.max(left + 8, Math.min(box.left, right - target.offsetWidth - 8))}px`;
      target.style.top = `${Math.max(top + 8, Math.min(y, bottom - target.offsetHeight - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(target);
    observer.observe(trigger);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      if (target.hidePopover && target.matches(':popover-open')) target.hidePopover();
    };
  }, [open, anchor, panel]);
}

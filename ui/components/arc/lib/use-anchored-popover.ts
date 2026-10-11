import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { limitiViewport } from '../../../../public/js/viewport.js';

function editorBottom(trigger: HTMLElement, bottom: number) {
  const navigation = document.getElementById('mobile-bottom-nav');
  return trigger.closest('td.editing') && navigation?.getClientRects().length
    ? Math.min(bottom, navigation.getBoundingClientRect().top) : bottom;
}

// CodeDB: il top layer evita il ritaglio nei pannelli scorrevoli e resta nel
// sottoalbero del dialogo, quindi Radix conserva correttamente il focus.
export function useAnchoredPopover(open: boolean, anchor: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, onDismiss: () => void, gap = 4) {
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
      const box = trigger.getBoundingClientRect();
      const bounds = limitiViewport();
      const { left, top, right } = bounds, bottom = editorBottom(trigger, bounds.bottom);
      if (box.bottom <= top || box.top >= bottom || box.right <= left || box.left >= right) {
        if (target.matches(':popover-open')) target.hidePopover?.();
        return;
      }
      if (!target.matches(':popover-open')) target.showPopover?.();
      const below = bottom - 8 - box.bottom - gap, above = box.top - gap - top - 8;
      const fullHeight = target.scrollHeight + target.offsetHeight - target.clientHeight;
      const placeBelow = fullHeight <= below || below >= above;
      target.style.maxHeight = `${Math.max(0, Math.floor(placeBelow ? below : above))}px`;
      const y = placeBelow ? box.bottom + gap : box.top - target.offsetHeight - gap;
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
  }, [open, anchor, panel, gap]);
}

// I menu della cella lasciano libera la fascia di Applica/Annulla su entrambi i lati.
export function useInlineEditOffset(open: boolean, anchor: RefObject<HTMLElement | null>) {
  const [gap, setGap] = useState(4);
  const [bottomPadding, setBottomPadding] = useState(12);
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = anchor.current, cell = trigger?.closest('td.editing');
    const actions = cell?.querySelector<HTMLElement>('.inline-edit-actions');
    if (!trigger || !cell || !actions) { setGap(4); setBottomPadding(12); return; }
    const update = () => {
      const field = trigger.getBoundingClientRect(), box = cell.getBoundingClientRect();
      setGap(Math.ceil(actions.offsetHeight + Math.max(box.bottom - field.bottom, field.top - box.top, 0) + 8));
      setBottomPadding(Math.max(12, window.innerHeight - editorBottom(trigger, limitiViewport().bottom) + 8));
    };
    update();
    const observer = new ResizeObserver(update);
    [trigger, cell, actions].forEach(element => observer.observe(element));
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [open, anchor]);
  return { gap, bottomPadding };
}

import { createRoot, type Root } from 'react-dom/client';
import { createPortal, flushSync } from 'react-dom';
import type { InputHTMLAttributes, ButtonHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { Button, type ButtonVariant } from './components/arc/button/button';
import { Input } from './components/arc/input/input';
import { Textarea } from './components/arc/textarea/textarea';

const mounts = new Set<{ root: Root; host: HTMLElement; nodes: { node: HTMLElement; parent: HTMLElement }[] }>();
new MutationObserver(records => {
  if (!records.some(record => record.removedNodes.length)) return;
  for (const entry of mounts) if (entry.nodes.every(({ node }) => !node.isConnected)) {
    mounts.delete(entry);
    // I controller possono svuotare un template: ricomponiamo i soli nodi
    // staccati prima dell'unmount, perché React possa ripulire i propri effetti.
    for (const { node, parent } of entry.nodes) if (node.parentElement !== parent) parent.append(node);
    entry.root.unmount(); entry.host.remove();
  }
}).observe(document.body, { childList: true, subtree: true });

// Eseguito PRIMA degli import applicativi: nessun listener o riferimento ai
// controlli originali è stato registrato. I portal non aggiungono wrapper:
// parentElement, selettori diretti e form.elements conservano il loro contratto.
export function initControls(scope: ParentNode = document, fieldsOnly = false) {
  const host = document.createElement('span');
  host.hidden = true;
  document.body.append(host);
  const replacements: { old: HTMLElement; current: HTMLElement }[] = [];
  const excluded = '#welcome, #placeholder, #settings-menu, #askinput-overlay';
  const controls = [...scope.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>(fieldsOnly ? 'input, textarea' : 'button, input, textarea')]
    .filter(node => !node.closest(excluded) && !node.closest('[data-arc-owned]') && !node.dataset.arcComponent && node.id !== 'conn-settings-btn'
      && (!(node instanceof HTMLInputElement) || !['hidden', 'checkbox', 'radio', 'range', 'color'].includes(node.type)));
  if (!controls.length) { host.remove(); return; }
  const aliases: Record<string, string> = { class: 'className', tabindex: 'tabIndex', readonly: 'readOnly', autofocus: 'autoFocus', autocomplete: 'autoComplete', maxlength: 'maxLength', minlength: 'minLength', spellcheck: 'spellCheck', inputmode: 'inputMode' };
  const booleans = new Set(['disabled', 'required', 'readonly', 'autofocus', 'hidden', 'multiple']);
  const portals = controls.map((old, index) => {
    const props: Record<string, unknown> = {};
    for (const attr of old.attributes) {
      if (['value', 'style', 'checked'].includes(attr.name) || attr.name.startsWith('on')) continue;
      props[aliases[attr.name] || attr.name] = booleans.has(attr.name) ? true : attr.value;
    }
    const ref = (current: HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | null) => {
      if (!current) return;
      // Gli stili inline appartengono al layout della piattaforma.
      if (old.hasAttribute('style')) current.style.cssText = old.style.cssText;
      replacements.push({ old, current });
    };
    let component;
    if (old instanceof HTMLButtonElement) {
      if (!props['aria-label'] && old.title && !/[\p{L}\p{N}]/u.test(old.textContent || '')) props['aria-label'] = old.title;
      const variant: ButtonVariant = old.matches('.danger, .btn-danger') ? 'danger'
        : old.matches('.primary, .btn-primary') ? 'primary'
          : old.matches('.ghost, .view-tab, .tab, .menu-item, .icon-btn') ? 'ghost' : 'secondary';
      component = <Button {...props as ButtonHTMLAttributes<HTMLButtonElement>} ref={ref}
        variant={variant} size="sm" data-arc-component="button" domContent={old.innerHTML} />;
    } else if (old instanceof HTMLTextAreaElement) {
      component = <Textarea {...props as TextareaHTMLAttributes<HTMLTextAreaElement>} ref={ref}
        label="" bare defaultValue={old.value} aria-label={old.getAttribute('aria-label') || old.labels?.[0]?.textContent?.trim() || old.title || old.placeholder || 'Testo'} data-arc-component="textarea" />;
    } else {
      component = <Input {...props as InputHTMLAttributes<HTMLInputElement>} ref={ref}
        aria-label={old.getAttribute('aria-label') || (old.labels?.length ? undefined : old.title || old.placeholder || 'Valore')}
        label="" bare defaultValue={old.type === 'file' ? undefined : old.value} data-arc-component="input" />;
    }
    return createPortal(component, old.parentElement!, String(index));
  });
  const root = createRoot(host);
  flushSync(() => root.render(portals));
  const nodes = replacements.map(({ old, current }) => ({ node: current, parent: old.parentElement! }));
  for (const { old, current } of replacements) old.replaceWith(current);
  mounts.add({ root, host, nodes });
}

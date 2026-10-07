import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Select } from './components/arc/select/select';
import { Checkbox } from './components/arc/checkbox/checkbox';
import { ColorPicker } from './components/arc/color-picker/color-picker';
import { DateField } from './date-field';

type Model = HTMLInputElement | HTMLSelectElement;
const entries = new Map<Model, { host: HTMLElement; root: Root; sync: () => void; dispose: () => void }>();
const selector = 'select, input[type="checkbox"], input[type="color"], input[type="date"], input[type="datetime-local"]';

function labelOf(model: Model) {
  const label = model.labels?.[0]?.cloneNode(true) as HTMLElement | undefined;
  label?.querySelectorAll('input, select, button, .arc-field-host').forEach(node => node.remove());
  return model.getAttribute('aria-label') || label?.querySelector('.tema-campo-nome')?.textContent?.trim() || label?.textContent?.trim() || model.title
    || model.closest('td')?.parentElement?.querySelector('td')?.textContent?.trim() || 'Valore';
}

function watchProperty(model: Model, property: string, sync: () => void) {
  const own = Object.getOwnPropertyDescriptor(model, property);
  const descriptor = own || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(model), property);
  if (!descriptor?.get || !descriptor.set) return () => {};
  Object.defineProperty(model, property, { configurable: true, get: () => descriptor.get!.call(model),
    set: value => { descriptor.set!.call(model, value); sync(); } });
  return () => { if (own) Object.defineProperty(model, property, own); else delete (model as unknown as Record<string, unknown>)[property]; };
}

/** Il nodo nativo resta il modello dei controller, non un secondo controllo UI.
 * Conserva form.elements, options, checked, validazione e listener già collegati.
 * Arc è l'unica superficie interattiva; gli eventi utente passano dal modello.
 */
function mountField(model: Model) {
  const calendar = model instanceof HTMLInputElement && ['date', 'datetime-local'].includes(model.type);
  if (entries.has(model) || (model.closest('[data-arc-owned]') && !(calendar && model.dataset.arcComponent === 'input')) || model.dataset.arcModel !== undefined) return;
  const host = document.createElement('span');
  host.className = calendar ? 'arc-field-host arc-date-field' : 'arc-field-host';
  host.dataset.arcOwned = '';
  host.dataset.arcFor = model.id;
  model.after(host);
  model.dataset.arcModel = '';
  const root = createRoot(host);
  let disposed = false;
  let queued = false;
  let open = false;
  const sync = () => {
    if (disposed || queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (!disposed) render(); });
  };
  const change = (value: string) => {
    model.value = value;
    model.dispatchEvent(new Event('input', { bubbles: true }));
    model.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
  };
  const hidden = () => model.hidden || model.classList.contains('hidden') || model.classList.contains('visually-hidden') || model.style.display === 'none';
  const fieldProps = () => ({ className: model.className, title: model.title, 'aria-label': labelOf(model),
    'aria-invalid': model.getAttribute('aria-invalid') === 'true' || undefined });
  function render() {
    host.hidden = hidden();
    const label = labelOf(model);
    if (model instanceof HTMLSelectElement) {
      const options = [...model.options].map((option, i) => ({ value: `option-${i}`, label: option.label,
        disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled) }));
      root.render(<Select bare {...fieldProps()} label={label} options={options} value={model.selectedIndex < 0 ? '' : `option-${model.selectedIndex}`}
        disabled={model.disabled} open={open} onOpenChange={next => { open = next; sync(); }}
        portalContainer={model.closest<HTMLElement>('[role="dialog"]') || undefined}
        onValueChange={value => {
          model.selectedIndex = Number(value.slice(7));
          model.dispatchEvent(new Event('input', { bubbles: true }));
          model.dispatchEvent(new Event('change', { bubbles: true }));
          sync();
        }} />);
    } else if (model.type === 'checkbox') {
      root.render(<Checkbox {...fieldProps()} data-arc-component="checkbox" checked={model.indeterminate ? 'indeterminate' : model.checked}
        disabled={model.disabled} onCheckedChange={() => { model.click(); sync(); }} />);
    } else if (model.type === 'color') {
      root.render(<ColorPicker label={label} compact value={model.value} onValueChange={change} disabled={model.disabled} allowAlpha={false}
        background={getComputedStyle(document.body).backgroundColor} />);
    } else {
      root.render(<DateField model={model} label={label} />);
    }
  }
  const restore = ['value', 'selectedIndex', 'checked', 'indeterminate', 'disabled', 'readOnly'].map(key => watchProperty(model, key, sync));
  const observer = new MutationObserver(sync);
  observer.observe(model, { attributes: true, childList: true, subtree: true, characterData: true });
  model.addEventListener('input', sync);
  model.addEventListener('change', sync);
  const reset = (event: Event) => {
    if (event.target !== model.form) return;
    queueMicrotask(() => { model.setCustomValidity(''); model.dispatchEvent(new Event('arc:reset')); sync(); });
  };
  const calendarKey = (event: Event) => {
    if (calendar && event instanceof KeyboardEvent && event.altKey && event.key === 'ArrowDown') { event.preventDefault(); host.querySelector<HTMLButtonElement>('button')?.click(); }
  };
  model.addEventListener('keydown', calendarKey);
  document.addEventListener('reset', reset, true);
  const focus = model.focus;
  model.focus = options => host.querySelector<HTMLElement>('button, input, [tabindex="0"]')?.focus(options);
  const onLabel = (event: MouseEvent) => {
    if (event.target === model || host.contains(event.target as Node) || (event.target as HTMLElement).closest('button, a, input, select')) return;
    event.preventDefault(); host.querySelector<HTMLButtonElement>('button')?.click();
  };
  const labels = [...model.labels || []];
  labels.forEach(label => label.addEventListener('click', onLabel));
  const invalid = (event: Event) => {
    event.preventDefault(); model.focus();
    host.querySelector('button')?.setAttribute('aria-invalid', 'true');
    host.title = model.validationMessage;
  };
  model.addEventListener('invalid', invalid);
  entries.set(model, { host, root, sync, dispose: () => {
    disposed = true; observer.disconnect(); restore.forEach(fn => fn());
    model.removeEventListener('input', sync); model.removeEventListener('change', sync);
    model.removeEventListener('keydown', calendarKey);
    model.removeEventListener('invalid', invalid); document.removeEventListener('reset', reset, true);
    labels.forEach(label => label.removeEventListener('click', onLabel));
    model.focus = focus;
    root.unmount(); host.remove(); delete model.dataset.arcModel; delete model.dataset.arcCalendar;
  } });
  flushSync(render);
}

export function mountFields(scope: ParentNode = document) {
  if (scope instanceof HTMLElement && scope.matches(selector)) mountField(scope as Model);
  scope.querySelectorAll<Model>(selector).forEach(mountField);
}

export function observeFields() {
  mountFields();
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const model = record.target as Model;
        const entry = entries.get(model);
        if (entry && !model.matches(selector)) { entry.dispose(); entries.delete(model); }
        if (model.matches(selector)) mountField(model);
      }
      for (const node of record.addedNodes) if (node instanceof HTMLElement && (!node.closest('[data-arc-owned]') || node.classList.contains('arc-editor-control'))) mountFields(node);
    }
    for (const [model, entry] of entries) {
      if (!model.isConnected) { entry.dispose(); entries.delete(model); }
      else if (!entry.host.isConnected) { model.after(entry.host); entry.sync(); }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['type'] });
}

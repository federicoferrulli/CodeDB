import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ReactNode } from 'react';
import { Button, type ButtonProps } from './components/arc/button/button';
import { Input, type InputProps } from './components/arc/input/input';
import { Select, type SelectProps } from './components/arc/select/select';
import { Checkbox } from './components/arc/checkbox/checkbox';
import { mountFields } from './fields';

// Gli editor vengono creati prima di collegare i listener applicativi. Ogni
// controllo possiede un piccolo host: la griglia può rimuoverlo senza spostare
// nodi gestiti da React e senza perdere gli eventi delegati dei menu Radix.
const hosts = new WeakMap<HTMLElement, HTMLElement>();
const roots = new WeakMap<HTMLElement, Root>();
type SelectConfig = Pick<SelectProps, 'options'> & { value: string; disabled: boolean };
const selectUpdates = new WeakMap<HTMLElement, (next: Partial<SelectConfig>) => void>();
function mount<T extends HTMLElement>(render: (ref: (node: T | null) => void) => ReactNode) {
  const host = document.createElement('span');
  host.className = 'arc-editor-control';
  host.dataset.arcOwned = '';
  const root = createRoot(host);
  let control!: T;
  flushSync(() => root.render(render(node => { if (node) control = node; })));
  hosts.set(control, host);
  roots.set(host, root);
  return { control, root };
}

export function controlElement(control: HTMLElement): HTMLElement {
  return hosts.get(control) || control;
}

new MutationObserver(records => {
  for (const record of records) for (const node of record.removedNodes) {
    if (!(node instanceof HTMLElement)) continue;
    const removed = node.matches('.arc-editor-control') ? [node] : [...node.querySelectorAll<HTMLElement>('.arc-editor-control')];
    for (const host of removed) if (!host.isConnected) {
      const root = roots.get(host);
      roots.delete(host);
      root?.unmount();
    }
  }
}).observe(document.body, { childList: true, subtree: true });

export function createArcInput(props: Omit<InputProps, 'label'> = {}) {
  const control = mount<HTMLInputElement>(ref => <Input label="" bare data-arc-component="input" {...props} ref={ref} />).control;
  if (props.type === 'date' || props.type === 'datetime-local') mountFields(control);
  return control;
}

export function createArcButton(props: ButtonProps = {}) {
  return mount<HTMLButtonElement>(ref => <Button type="button" variant="ghost" size="sm" domContent=""
    data-arc-component="button" {...props} ref={ref} />).control;
}

export function createArcSelect({ options, value = options[0]?.value || '', label }: Pick<SelectProps, 'options' | 'label'> & { value?: string }) {
  // Radix riserva la stringa vuota al placeholder; il form distingue invece
  // «campo omesso» da false. La codifica resta interna al solo controllo.
  let encoded = options.map((option, index) => ({ ...option, value: `option-${index}` }));
  let current = value;
  let disabled = false;
  let open = false;
  let control: HTMLButtonElement;
  let root: Root;
  const component = (ref: (node: HTMLButtonElement | null) => void) => <Select bare ref={ref}
    label={label} options={encoded} value={encoded[options.findIndex(option => option.value === current)]?.value || ''}
    open={open} disabled={disabled} portalContainer={control?.closest<HTMLElement>('[role="dialog"]') || undefined}
    onOpenChange={next => { open = next; render(); }}
    onValueChange={next => {
      current = options[encoded.findIndex(option => option.value === next)].value;
      render();
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
    }} />;
  const mounted = mount<HTMLButtonElement>(component);
  control = mounted.control;
  root = mounted.root;
  function render() { flushSync(() => root.render(component(() => {}))); }
  // Adattatore esplicito per .value: FK, parser e cambio tipo continuano a
  // leggere/scrivere il valore logico. Assegnarlo non simula un evento utente.
  Object.defineProperty(control, 'value', {
    configurable: true,
    get: () => current,
    set: (next: string) => { current = String(next); render(); },
  });
  selectUpdates.set(control, next => {
    if (next.options) { options = next.options; encoded = options.map((option, index) => ({ ...option, value: `option-${index}` })); }
    if (next.value !== undefined) current = next.value;
    if (next.disabled !== undefined) disabled = next.disabled;
    render();
  });
  return control;
}

export function updateArcSelect(control: HTMLElement, next: Partial<SelectConfig>) {
  selectUpdates.get(control)!(next);
}

export function createArcCheckbox({ id, label, checked = false }: { id: string; label: string; checked?: boolean }) {
  const component = (ref: (node: HTMLButtonElement | null) => void) => <Checkbox ref={ref} id={id}
    aria-label={label} data-arc-component="checkbox" checked={checked} onCheckedChange={next => {
      checked = next === true;
      render();
      control.dispatchEvent(new Event('change', { bubbles: true }));
    }} />;
  const { control, root } = mount<HTMLButtonElement>(component);
  function render() { flushSync(() => root.render(component(() => {}))); }
  Object.defineProperty(control, 'checked', { get: () => checked, set: (next: boolean) => { checked = !!next; render(); } });
  return control;
}

export function initGridFields() {
  for (const id of ['coledit-bsontype', 'geomap-type']) {
    const old = document.getElementById(id) as HTMLSelectElement;
    const control = createArcSelect({ label: id === 'geomap-type' ? 'Tipo di geometria' : 'Converti in', value: old.value,
      options: [...old.options].map(option => ({ value: option.value, label: option.textContent || '', disabled: option.disabled })) });
    control.id = id;
    old.replaceWith(controlElement(control));
  }
  const old = document.getElementById('coledit-null') as HTMLInputElement;
  old.replaceWith(controlElement(createArcCheckbox({ id: old.id, label: 'Ammetti NULL', checked: old.checked })));
}

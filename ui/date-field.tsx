import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { DatePicker } from './components/arc/date-picker/date-picker';
import { Input } from './components/arc/input/input';
import { Button } from './components/arc/button/button';

// L'input originale è il modello del controller. La data visibile è interamente
// Arc DatePicker; l'ora rimane testuale per non perdere secondi e millisecondi.
export function DateField({ model, label }: { model: HTMLInputElement; label: string }) {
  const lastApplied = useRef(model.value);
  const errorId = useId();
  const [parts, setParts] = useState(() => model.value.split('T'));
  const [editingIso, setEditingIso] = useState(false);
  const [iso, setIso] = useState(model.value);
  useEffect(() => {
    const reset = () => { lastApplied.current = model.value; setParts(model.value.split('T')); setIso(model.value); };
    model.addEventListener('arc:reset', reset);
    return () => model.removeEventListener('arc:reset', reset);
  }, [model]);
  if (lastApplied.current !== model.value) {
    model.setCustomValidity('');
    lastApplied.current = model.value;
    setParts(model.value.split('T'));
    setIso(model.value);
  }
  const dateTime = model.type === 'datetime-local';
  const inline = model.classList.contains('arc-inline-date-model');
  const date = (text = '') => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
    const value = new Date(`${text}T12:00:00`);
    return Number.isFinite(value.getTime()) && value.getFullYear() === Number(text.slice(0, 4))
      && value.getMonth() + 1 === Number(text.slice(5, 7)) && value.getDate() === Number(text.slice(8)) ? value : undefined;
  };
  const apply = (next: string[]) => {
    const candidate = next.some(Boolean) ? next.join('T') : '';
    setParts(next); setIso(candidate);
    model.value = candidate;
    lastApplied.current = model.value;
    model.setCustomValidity(candidate && !model.value ? 'Inserisci una data e un’ora valide.' : '');
    model.dispatchEvent(new Event('input', { bubbles: true }));
    model.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const blur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node)) return;
    // Stessa semantica dell'editor precedente: salvataggio solo uscendo
    // dall'intero campo, mai passando dal calendario all'ora.
    model.dispatchEvent(new FocusEvent('blur', { relatedTarget: event.relatedTarget }));
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || !['Enter', 'Escape'].includes(event.key)) return;
    if (event.key === 'Enter' && !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault(); event.stopPropagation();
    model.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, bubbles: true }));
  };
  return <div className={`arc-date-control${inline ? ' arc-date-inline' : ''}`} data-arc-component="date-field" onBlur={blur} onKeyDown={key}>
    <DatePicker label={label} locale="it-IT" showToday value={date(parts[0])} minDate={date(model.min.slice(0, 10))}
      className={inline ? 'arc-date-cell' : undefined}
      aria-invalid={!model.validity.valid || undefined} aria-describedby={model.validationMessage ? errorId : undefined}
      maxDate={date(model.max.slice(0, 10))} disabled={model.disabled || model.readOnly}
      onChange={value => {
        const day = value ? `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : '';
        apply(dateTime && day ? [day, parts[1] || '00:00'] : [day]);
      }} />
    {dateTime && <Input bare={inline} label="Ora UTC" aria-label="Ora UTC (ore, minuti, secondi e millisecondi)" data-arc-component="input"
      className="arc-time-input" type="text" placeholder="HH:mm:ss.SSS" title="Ora UTC · HH:mm:ss.SSS" value={parts[1] || ''}
      disabled={model.disabled} readOnly={model.readOnly} aria-invalid={model.validationMessage ? true : undefined} aria-describedby={model.validationMessage ? errorId : undefined}
      onChange={event => apply([parts[0] || '', event.target.value])} />}
    {!inline && <>
      <Button variant="ghost" size="sm" type="button" className="arc-date-iso-toggle" disabled={model.disabled || model.readOnly} aria-expanded={editingIso}
        aria-label="Modifica data e ora in formato ISO" onClick={() => setEditingIso(!editingIso)}>ISO</Button>
      {editingIso && <Input bare className="arc-date-iso" label="Data ISO" aria-label="Data ISO" data-arc-component="input" value={iso}
        disabled={model.disabled} readOnly={model.readOnly} aria-invalid={!model.validity.valid || undefined} aria-describedby={errorId}
        placeholder={dateTime ? 'AAAA-MM-GGTHH:mm:ss.SSS' : 'AAAA-MM-GG'} onChange={event => apply(event.target.value.split('T'))} />}
    </>}
    {model.validationMessage && <span id={errorId} className="arc-date-error" role="alert">{model.validationMessage}</span>}
  </div>;
}

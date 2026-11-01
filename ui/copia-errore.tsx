import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './components/arc/button/button';

async function copiaMessaggio(text: string, container: HTMLElement) {
  const owner = container.ownerDocument;
  try {
    if (owner.defaultView?.navigator.clipboard?.writeText) {
      await owner.defaultView.navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* Alcune WebView non concedono l'API: prova la copia dal documento attivo. */ }
  const focused = owner.activeElement as HTMLElement | null;
  const selection = owner.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const field = owner.createElement('textarea');
  field.value = text; field.readOnly = true; field.tabIndex = -1;
  field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
  container.append(field);
  try {
    field.focus({ preventScroll: true }); field.select(); field.setSelectionRange(0, text.length);
    if (!owner.execCommand('copy')) throw new Error('Copia non disponibile');
  } finally {
    field.remove(); focused?.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}

export function PulsanteCopiaErrore({ text, showLabel = false }: { text: string; showLabel?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  return <>
    <Button type="button" variant="secondary" className={showLabel ? undefined : 'feedback-copy-icon'} aria-label="Copia errore" title="Copia errore" disabled={busy} onClick={async event => {
      const container = event.currentTarget.closest<HTMLElement>('.feedback-message, .data-empty')!;
      window.clearTimeout(copyTimer.current);
      setCopied(false); setBusy(true); setStatus('');
      try {
        await copiaMessaggio(text, container);
        setStatus('Messaggio copiato.'); setCopied(true);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1000);
      } catch { setStatus('Copia non riuscita. Seleziona il messaggio e copialo manualmente.'); }
      finally { setBusy(false); }
    }}>{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{showLabel && (busy ? 'Copia…' : 'Copia errore')}</Button>
    {status && <span className={status === 'Messaggio copiato.' ? 'visually-hidden' : 'copy-error-status feedback-hint'} role="status">{status}</span>}
  </>;
}

import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Button } from './components/arc/button/button';
import { Input } from './components/arc/input/input';
import { Checkbox } from './components/arc/checkbox/checkbox';

type Result = string | { testo: string; spunta: boolean } | null;
type Request = {
  titolo?: string; sottotitolo?: string; etichetta?: string; valore?: unknown;
  password?: boolean; ok?: string; spunta?: { etichetta: string; valore?: boolean };
  resolve: (result: Result) => void;
};

function Prompt({ overlay }: { overlay: HTMLElement }) {
  const [request, setRequest] = useState<Request | null>(null);
  const [value, setValue] = useState('');
  const [checked, setChecked] = useState(false);
  const pending = useRef<Request | null>(null);
  const input = useRef<HTMLInputElement>(null);
  function finish(result: Result) {
    const current = pending.current;
    pending.current = null;
    overlay.classList.add('hidden');
    current?.resolve(result);
  }
  useLayoutEffect(() => {
    const receive = (event: Event) => {
      const next = (event as CustomEvent<Request>).detail;
      // Una seconda richiesta annulla esplicitamente la prima, senza Promise sospese.
      pending.current?.resolve(null);
      pending.current = next;
      flushSync(() => { setRequest(next); setValue(String(next.valore ?? '')); setChecked(!!next.spunta?.valore); });
      overlay.classList.remove('hidden');
      input.current?.focus(); input.current?.select();
    };
    document.addEventListener('codedb:ask-input', receive);
    return () => document.removeEventListener('codedb:ask-input', receive);
  }, [overlay]);
  if (!request) return null;
  return <form data-arc-owned="prompt" onSubmit={event => { event.preventDefault(); finish(request.spunta ? { testo: value, spunta: checked } : value); }}>
    <h2 id="askinput-title">{request.titolo || 'Inserisci un valore'}</h2>
    <p id="askinput-subtitle" className={`subtitle${request.sottotitolo ? '' : ' hidden'}`}>{request.sottotitolo}</p>
    <div className="arc-prompt-field"><Input ref={input} id="askinput-value" label={request.etichetta || 'Valore'}
      type={request.password ? 'password' : 'text'} value={value} onChange={e => setValue(e.target.value)} autoComplete="off" spellCheck={false} /></div>
    <div id="askinput-check-row" className={request.spunta ? '' : 'hidden'}>
      <Checkbox id="askinput-check" label={request.spunta?.etichetta || 'Conserva originale'} checked={checked} onCheckedChange={value => setChecked(value === true)} />
    </div>
    <div className="modal-actions">
      <Button id="askinput-cancel" variant="secondary" type="button" onClick={() => finish(null)}>Annulla</Button>
      <Button id="askinput-ok" type="submit">{request.ok || 'Conferma'}</Button>
    </div>
  </form>;
}

export function initPrompt() {
  const overlay = document.getElementById('askinput-overlay');
  const host = overlay?.querySelector('.modal');
  if (overlay && host) flushSync(() => createRoot(host).render(<Prompt overlay={overlay} />));
}

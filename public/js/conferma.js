// Le conferme mobile attraversano lo stesso adattatore Arc dei form.
export function chiediConferma(messaggio) {
  if (document.documentElement.classList.contains('embedded-panel') || !window.matchMedia('(max-width: 900px)').matches) return Promise.resolve(window.confirm(messaggio));
  return new Promise(resolve => document.dispatchEvent(new CustomEvent('codedb:ask-confirm', {
    detail: { messaggio: String(messaggio), resolve },
  })));
}

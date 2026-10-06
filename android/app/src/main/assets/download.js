(() => {
  'use strict';
  let busy = false;
  let reply;
  CodeDBFiles.onmessage = event => {
    if (reply) { const done = reply; reply = null; done(event.data); }
  };
  const send = async value => {
    const result = await new Promise(resolve => { reply = resolve; CodeDBFiles.postMessage(JSON.stringify(value)); });
    if (result !== 'ok') throw new Error(result);
  };
  async function download(url, name) {
    if (busy) { alert('Completa prima il salvataggio in corso.'); return; }
    busy = true;
    let reader;
    try {
      // fetch parte subito: il chiamante può revocare l'object URL dopo click().
      const response = await fetch(url);
      if (!response.ok) throw new Error('Download non riuscito: HTTP ' + response.status);
      reader = response.body.getReader();
      await send({ op: 'start', name: name || 'esportazione', mime: response.headers.get('Content-Type') || 'application/octet-stream' });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.length; offset += 32768) {
          const bytes = value.subarray(offset, offset + 32768);
          await send({ op: 'chunk', data: btoa(String.fromCharCode(...bytes)) });
        }
      }
      await send({ op: 'end' });
    } catch (error) {
      await send({ op: 'abort' }).catch(() => {});
      if (error.message !== 'annullato') alert('Salvataggio non riuscito: ' + error.message + '. Il file scelto potrebbe essere incompleto.');
    } finally {
      if (reader) await reader.cancel().catch(() => {});
      busy = false;
    }
  }
  window.__codedbDownload = download;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download')) { void download(this.href, this.download); return; }
    return click.call(this);
  };
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[download]');
    if (link) { event.preventDefault(); void download(link.href, link.download); }
  }, true);
})();

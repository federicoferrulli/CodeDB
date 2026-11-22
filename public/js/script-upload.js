import { MAX_SQL_STATEMENT_BYTES } from './sql-file-limits.mjs';

// Socket.IO conta i byte del JSON sul filo, compresi gli escape. La query arriva
// al driver in una sola istruzione anche quando viaggia in più messaggi.
export function inviaScript(emit, payload, annullato, onUpload) {
  return inviaCodice('script:execute', emit, payload, annullato, onUpload);
}

export async function inviaCodice(evento, emit, payload, annullato = () => false, onUpload) {
  const options = { reconnect: !payload.fileChunk && !payload.previousRunId, rejectOnDisconnect: true };
  const { code, ...meta } = payload;
  if (code.length < 700000 || (code.length < 4500000 && new Blob([JSON.stringify(payload)]).size < 4500000)) {
    return emit(evento, payload, options);
  }
  const uploadBytes = new Blob([code]).size;
  if (uploadBytes > MAX_SQL_STATEMENT_BYTES) throw new Error('La singola istruzione SQL supera il limite di 64 MiB.');
  options.reconnect = false;
  const invia = params => emit('script:upload', { tabId: meta.tabId, dbSessionId: meta.dbSessionId, ...params }, { ...options, timeoutMs: 60000 });
  onUpload?.(0, uploadBytes);
  const { uploadId } = await invia({ action: 'start', runId: meta.runId });
  try {
    let index = 0;
    for (let start = 0; start < code.length; index++) {
      if (annullato()) throw new Error('Caricamento dello script interrotto.');
      let end = Math.min(start + 512 * 1024, code.length);
      if (end < code.length && /[\uD800-\uDBFF]/.test(code[end - 1])) end--;
      const ricevuta = await invia({ action: 'append', uploadId, index, chunk: code.slice(start, end) });
      onUpload?.(ricevuta.bytes, uploadBytes);
      start = end;
    }
    if (annullato()) throw new Error('Caricamento dello script interrotto.');
    return await emit(evento, { ...meta, uploadId, uploadBytes }, options);
  } catch (err) {
    await invia({ action: 'discard', uploadId }).catch(() => {});
    throw err;
  }
}

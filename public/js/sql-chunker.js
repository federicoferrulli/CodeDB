import { intervalliSql } from './sql-split.js';
import { MAX_SQL_STATEMENT_BYTES } from './sql-file-limits.mjs';

const PRIMA_LETTURA = 64 * 1024;
const ISTRUZIONI_PER_BLOCCO = 10000;

async function leggiUtf8(blob, finale = true) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  // Una finestra può terminare nel mezzo di un carattere. Il byte offset del
  // separatore viene misurato solo sul prefisso decodificato per intero.
  const bytes = await blob.arrayBuffer();
  try { return decoder.decode(bytes, { stream: !finale }); }
  catch { throw new Error('Il file contiene testo non valido in UTF-8. Verifica la codifica del file.'); }
}

async function indicizzaFileIntero(file) {
  if (file.size > MAX_SQL_STATEMENT_BYTES) {
    throw new Error(
      `Il file (${formatBytes(file.size)}) supera il limite di ${formatBytes(MAX_SQL_STATEMENT_BYTES)} per una singola esecuzione: `
      + 'gli script JavaScript e i documenti JSON non possono essere suddivisi sui punti e virgola.'
    );
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const finestra = 1024 * 1024;
  let haContenuto = false;
  for (let pos = 0; pos < file.size; pos += finestra) {
    const end = Math.min(pos + finestra, file.size);
    const bytes = await file.slice(pos, end).arrayBuffer();
    let testo;
    try { testo = decoder.decode(bytes, { stream: end < file.size }); }
    catch { throw new Error('Il file contiene testo non valido in UTF-8. Verifica la codifica del file.'); }
    if (!haContenuto && /\S/.test(testo)) haContenuto = true;
  }
  return { start: 0, end: file.size, size: file.size, delimiter: ';', nextDelimiter: ';', statements: haContenuto ? 1 : 0 };
}

export async function indicizzaBlocco({ file, start, target, dbms, delimiter, splitStatements = true }) {
  if (splitStatements === false) return indicizzaFileIntero(file);
  let bytes = Math.min(target, file.size - start);
  for (;;) {
    const eof = start + bytes === file.size;
    const text = await leggiUtf8(file.slice(start, start + bytes), eof);
    let fine = 0, seguente = delimiter, count = 0;
    for (const st of intervalliSql(text, { dbms, backslashEscape: dbms === 'mysql', delimiter })) {
      if (st.next === null && !eof) break;
      if (st.haCodice) count++;
      fine = st.next ?? text.length;
      seguente = st.delimiter;
      if (count >= ISTRUZIONI_PER_BLOCCO) break;
    }
    if (fine || eof) {
      const end = eof && fine === text.length ? file.size : start + new TextEncoder().encode(text.slice(0, fine)).length;
      return { start, end, size: end - start, delimiter, nextDelimiter: seguente, statements: count };
    }
    if (bytes >= MAX_SQL_STATEMENT_BYTES) {
      throw new Error(`L’istruzione SQL al byte ${start} supera il limite di ${formatBytes(MAX_SQL_STATEMENT_BYTES)}.`);
    }
    // Nessun separatore valido: può essere un INSERT esteso o una routine.
    // Raddoppiare mantiene lineare il lavoro anche per una sola istruzione lunga.
    bytes = Math.min(bytes * 2, MAX_SQL_STATEMENT_BYTES, file.size - start);
  }
}

// Il worker riceve il File nativo (un riferimento al file locale). Alla
// finestra tornano solo gli offset, anche per un INSERT di decine di MB.
let worker, idAnalisi = 0;
const attese = new Map();
function analizza(params) {
  if (typeof Worker !== 'function' || !(params.file instanceof Blob)) return indicizzaBlocco(params);
  if (worker === undefined) {
    try {
      worker = new Worker(new URL('./sql-chunker-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        const attesa = attese.get(data.id);
        if (!attesa) return;
        attese.delete(data.id);
        if (data.error) attesa.reject(new Error(data.error));
        else attesa.resolve(data.chunk);
      };
      worker.onerror = () => {
        worker.terminate(); worker = null;
        for (const attesa of attese.values()) attesa.resolve(indicizzaBlocco(attesa.params));
        attese.clear();
      };
    } catch { worker = null; }
  }
  if (!worker) return indicizzaBlocco(params);
  return new Promise((resolve, reject) => {
    const id = ++idAnalisi;
    attese.set(id, { params, resolve, reject });
    try { worker.postMessage({ id, params }); }
    catch { attese.delete(id); resolve(indicizzaBlocco(params)); }
  });
}

/** Indice progressivo: conserva soltanto i confini dei blocchi già scoperti. */
export class SqlChunker {
  constructor(file, targetChunkSize = 1024 * 1024, dbms = '', { splitStatements = true } = {}) {
    if (!file) throw new Error('Seleziona un file da leggere.');
    this.file = file;
    this.dbms = dbms;
    this.splitStatements = splitStatements !== false;
    this.targetChunkSize = Math.max(PRIMA_LETTURA, Math.min(targetChunkSize, 10 * 1024 * 1024));
    this.chunks = [];
    this.complete = false;
    this.pending = null;
  }

  // L'indicizzazione in background, l'anteprima e l'esecuzione possono
  // domandare lo stesso blocco contemporaneamente. Il cursore avanza una volta.
  async ensureChunk(index) {
    if (!Number.isInteger(index) || index < 0) return null;
    while (!this.complete && this.chunks.length <= index) {
      if (!this.pending) {
        const last = this.chunks.at(-1);
        this.pending = analizza({ file: this.file, start: last?.end ?? 0,
          target: last ? this.targetChunkSize : PRIMA_LETTURA,
          dbms: this.dbms, delimiter: last?.nextDelimiter ?? ';',
          splitStatements: this.splitStatements }).then(meta => {
          this.chunks.push({ ...meta, index: this.chunks.length });
          this.complete = meta.end === this.file.size;
        }).finally(() => { this.pending = null; });
      }
      await this.pending;
    }
    return this.chunks[index] || null;
  }

  async init() {
    await this.ensureChunk(0);
    return this.chunks;
  }

  // Il totale diventa noto soltanto quando complete è vero.
  getChunkCount() { return this.chunks.length; }

  async readChunk(index, maxBytes = Infinity) {
    const chunk = await this.ensureChunk(index);
    if (!chunk) throw new Error(`Blocco SQL ${index + 1} fuori dal file.`);
    const end = Math.min(chunk.end, chunk.start + maxBytes);
    const text = await leggiUtf8(this.file.slice(chunk.start, end), end === chunk.end);
    return { index, totalChunks: this.complete ? this.chunks.length : null, text, startByte: chunk.start, endByte: chunk.end,
      totalBytes: this.file.size, delimiter: chunk.delimiter, statements: chunk.statements };
  }

  async readPrefix(maxBytes) {
    return leggiUtf8(this.file.slice(0, maxBytes), this.file.size <= maxBytes);
  }

  getFileInfo() {
    return { name: this.file.name, size: this.file.size, formattedSize: formatBytes(this.file.size),
      chunkCount: this.chunks.length, targetChunkSize: this.targetChunkSize,
      splitStatements: this.splitStatements };
  }
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return parseFloat((bytes / 1024 ** i).toFixed(2)) + ' ' + sizes[i];
}

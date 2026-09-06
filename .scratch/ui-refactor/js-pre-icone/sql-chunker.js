/**
 * CodeDB — SqlChunker
 * 
 * Gestisce il chunking ed il caricamento incrementale di file SQL di grandi dimensioni
 * (anche decine/centinaia di MB o GB).
 * Scompone il file in blocchi di byte (default ~1 MB) cercando di allineare i confini
 * dei chunk al termine di un'istruzione SQL (punto e virgola ';') per evitare di
 * spezzare le query a metà.
 */

export class SqlChunker {
  /**
   * @param {File} file - Oggetto File selezionato dall'utente
   * @param {number} [targetChunkSize=1048576] - Dimensione desiderata per ogni chunk in byte (default 1 MB)
   */
  constructor(file, targetChunkSize = 1024 * 1024) {
    if (!file) throw new Error('Un oggetto File è richiesto per SqlChunker.');
    this.file = file;
    this.targetChunkSize = Math.max(64 * 1024, Math.min(targetChunkSize, 10 * 1024 * 1024)); // Min 64KB, Max 10MB
    this.chunks = []; // memorizza { index, start, end, size }
    this.initialized = false;
  }

  /**
   * Inizializza la mappa dei chunk calcolando gli offset di byte.
   * Cerca di allineare i confini al punto e virgola ';' più vicino.
   */
  async init() {
    if (this.initialized) return this.chunks;

    const fileSize = this.file.size;
    let currentStart = 0;
    let chunkIndex = 0;

    // Se il file è piccolo (<= targetChunkSize), unico chunk
    if (fileSize <= this.targetChunkSize) {
      this.chunks.push({
        index: 0,
        start: 0,
        end: fileSize,
        size: fileSize
      });
      this.initialized = true;
      return this.chunks;
    }

    while (currentStart < fileSize) {
      let targetEnd = Math.min(currentStart + this.targetChunkSize, fileSize);

      if (targetEnd < fileSize) {
        // Leggi una piccola porzione extra (4KB) per cercare il punto e virgola ';' finale
        const searchExtra = 4096;
        const readEnd = Math.min(targetEnd + searchExtra, fileSize);
        const slice = this.file.slice(currentStart, readEnd);
        const text = await this.readBlobAsText(slice);

        // Cerchiamo l'ultimo ';' prima del confine ideale o nella porzione extra
        const targetOffsetInText = Math.min(this.targetChunkSize, text.length);
        const searchRange = text.substring(0, targetOffsetInText + searchExtra);
        const lastSemicolon = searchRange.lastIndexOf(';');

        if (lastSemicolon !== -1 && lastSemicolon >= Math.floor(targetOffsetInText * 0.5)) {
          // Trovato ';' in una posizione ragionevole: calcoliamo l'offset esatto in byte
          const textBeforeSemi = searchRange.substring(0, lastSemicolon + 1);
          const byteLen = new Blob([textBeforeSemi]).size;
          targetEnd = currentStart + byteLen;
        } else {
          // Se non c'è punto e virgola, cerchiamo il più vicino ritorno a capo '\n'
          const lastNewline = searchRange.lastIndexOf('\n');
          if (lastNewline !== -1 && lastNewline >= Math.floor(targetOffsetInText * 0.5)) {
            const textBeforeNL = searchRange.substring(0, lastNewline + 1);
            const byteLen = new Blob([textBeforeNL]).size;
            targetEnd = currentStart + byteLen;
          }
        }
      }

      // Evitiamo chunk vuoti o loop infiniti
      if (targetEnd <= currentStart) {
        targetEnd = Math.min(currentStart + this.targetChunkSize, fileSize);
      }

      this.chunks.push({
        index: chunkIndex,
        start: currentStart,
        end: targetEnd,
        size: targetEnd - currentStart
      });

      chunkIndex++;
      currentStart = targetEnd;
    }

    this.initialized = true;
    return this.chunks;
  }

  /**
   * Restituisce il numero totale di chunk.
   * @returns {number}
   */
  getChunkCount() {
    return this.chunks.length;
  }

  /**
   * Legge il contenuto del chunk specificato.
   * @param {number} index - Indice del chunk (0-based)
   * @returns {Promise<{ index: number, totalChunks: number, text: string, startByte: number, endByte: number, totalBytes: number }>}
   */
  async readChunk(index) {
    if (!this.initialized) await this.init();

    if (index < 0 || index >= this.chunks.length) {
      throw new Error(`Indice chunk ${index} fuori dall'intervallo (0 - ${this.chunks.length - 1}).`);
    }

    const chunkInfo = this.chunks[index];
    const blob = this.file.slice(chunkInfo.start, chunkInfo.end);
    const text = await this.readBlobAsText(blob);

    return {
      index,
      totalChunks: this.chunks.length,
      text,
      startByte: chunkInfo.start,
      endByte: chunkInfo.end,
      totalBytes: this.file.size
    };
  }

  /**
   * Helper per la lettura del Blob come testo.
   * @param {Blob} blob 
   * @returns {Promise<string>}
   */
  readBlobAsText(blob) {
    if (typeof blob.text === 'function') {
      return blob.text();
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Impossibile leggere il blocco di file.'));
      reader.readAsText(blob);
    });
  }

  /**
   * Restituisce informazioni sul file originale.
   */
  getFileInfo() {
    return {
      name: this.file.name,
      size: this.file.size,
      formattedSize: formatBytes(this.file.size),
      chunkCount: this.chunks.length,
      targetChunkSize: this.targetChunkSize
    };
  }
}

/**
 * Utility per formattare la dimensione in KB, MB, GB.
 * @param {number} bytes 
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

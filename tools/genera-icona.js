'use strict';
// Genera le icone dell'app: public/codedb.ico (favicon + collegamento Windows),
// public/codedb.png (voce .desktop su Linux e icona PWA/UI) e build/icon.ico
// (icona multi-risoluzione usata da electron-builder per l'eseguibile/installer Windows).
const fs = require('fs');
const path = require('path');
const { generateTransparentLogo } = require('./genera-logo-trasparente');

// Costruisce un .ico con più frame PNG incapsulati (formato supportato da
// Windows Vista in poi), una risoluzione per voce di `sizes`.
function buildMultiSizeIco(frames) {
  const count = frames.length;
  const headerSize = 6 + 16 * count;
  let offset = headerSize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);

  const dirEntries = [];
  for (let i = 0; i < count; i++) {
    const { size, png } = frames[i];
    const entryOff = 6 + i * 16;
    const dim = size >= 256 ? 0 : size; // 0 = 256px nel formato ICO
    header[entryOff] = dim;
    header[entryOff + 1] = dim;
    header.writeUInt16LE(1, entryOff + 4);   // planes
    header.writeUInt16LE(32, entryOff + 6);  // bpp
    header.writeUInt32LE(png.length, entryOff + 8);
    header.writeUInt32LE(offset, entryOff + 12);
    offset += png.length;
    dirEntries.push(png);
  }
  return Buffer.concat([header, ...dirEntries]);
}

function generateIconAssets() {
  const { squareBuf, side, resize, encodePNG } = generateTransparentLogo();
  const pub = path.join(__dirname, '..', 'public');
  const buildDir = path.join(__dirname, '..', 'build');

  const buf128 = resize(squareBuf, side, 128);
  const buf64  = resize(squareBuf, side, 64);

  const png128 = encodePNG(buf128, 128);
  const png64  = encodePNG(buf64, 64);

  // --- public/codedb.ico (favicon + collegamento, singolo frame 64x64) --
  fs.writeFileSync(path.join(pub, 'codedb.ico'), buildMultiSizeIco([{ size: 64, png: png64 }]));
  fs.writeFileSync(path.join(pub, 'codedb.png'), png128);
  console.log('Generati public/codedb.ico e public/codedb.png');

  // --- build/icon.ico (multi-risoluzione, per l'installer/exe Windows) --
  const sizes = [16, 32, 48, 64, 128, 256];
  const frames = sizes.map((size) => ({ size, png: encodePNG(resize(squareBuf, side, size), size) }));
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildMultiSizeIco(frames));
  console.log('Generato build/icon.ico (16..256px, per electron-builder)');

  // --- build/icon.png (512x512) ------------------------------------------
  // electron-builder pretende almeno 256x256 per l'icona Linux (AppImage/deb)
  // e usa questo file anche per derivare l'icona macOS quando manca icon.icns.
  // public/codedb.png è 128x128: sufficiente per la UI, respinto dalla build.
  fs.writeFileSync(path.join(buildDir, 'icon.png'), encodePNG(resize(squareBuf, side, 512), 512));
  console.log('Generato build/icon.png (512x512, per Linux/macOS)');
}

if (require.main === module) {
  generateIconAssets();
}

module.exports = { generateIconAssets };


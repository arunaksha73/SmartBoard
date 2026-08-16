// Pure Node.js PNG Favicon Generator (uses built-in zlib)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPng(size) {
  const width = size;
  const height = size;
  const rawData = Buffer.alloc((width * 4 + 1) * height);

  // Helper to calculate distance
  const cx = width / 2;
  const cy = height / 2;
  const rCorner = width * 0.22;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * 4 + 1);
    rawData[rowOffset] = 0; // Filter type 0 (None)

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;

      // Normalized coordinates [0, 1]
      const nx = x / width;
      const ny = y / height;

      // Rounded container check
      const dx = Math.max(0, Math.abs(x - cx) - (cx - rCorner));
      const dy = Math.max(0, Math.abs(y - cy) - (cy - rCorner));
      const distToCorner = Math.sqrt(dx * dx + dy * dy);

      if (distToCorner > rCorner) {
        // Transparent outside rounded corners
        rawData[pxOffset + 0] = 0;
        rawData[pxOffset + 1] = 0;
        rawData[pxOffset + 2] = 0;
        rawData[pxOffset + 3] = 0;
        continue;
      }

      // 1. Background gradient (dark navy to pure black)
      let r = 12 + (1 - ny) * 8;
      let g = 16 + (1 - ny) * 10;
      let b = 32 + (1 - ny) * 16;
      let a = 255;

      // 2. Ambient glowing background spots
      const blueDist = Math.hypot(nx - 0.28, ny - 0.5);
      const purpleDist = Math.hypot(nx - 0.72, ny - 0.48);

      if (blueDist < 0.45) {
        const glow = Math.pow(1 - blueDist / 0.45, 2) * 0.35;
        r = r * (1 - glow) + 56 * glow;
        g = g * (1 - glow) + 189 * glow;
        b = b * (1 - glow) + 248 * glow;
      }
      if (purpleDist < 0.45) {
        const glow = Math.pow(1 - purpleDist / 0.45, 2) * 0.4;
        r = r * (1 - glow) + 168 * glow;
        g = g * (1 - glow) + 85 * glow;
        b = b * (1 - glow) + 247 * glow;
      }

      // 3. Smartboard Monitor Frame
      // Rect bounds: x in [0.20, 0.80], y in [0.32, 0.72], border thickness ~0.045
      const rxDist = Math.max(0, Math.abs(nx - 0.5) - 0.22);
      const ryDist = Math.max(0, Math.abs(ny - 0.52) - 0.14);
      const screenCorner = Math.sqrt(rxDist * rxDist + ryDist * ryDist);

      const isFrame = (screenCorner < 0.08 && screenCorner > 0.035);
      if (isFrame) {
        const t = (nx - 0.2) / 0.6; // Gradient along width
        const frR = 56 * (1 - t) + 192 * t;
        const frG = 189 * (1 - t) + 132 * t;
        const frB = 248 * (1 - t) + 252 * t;
        const edgeSoft = Math.min(1, Math.max(0, 1 - Math.abs(screenCorner - 0.057) / 0.025));

        r = r * (1 - edgeSoft) + frR * edgeSoft;
        g = g * (1 - edgeSoft) + frG * edgeSoft;
        b = b * (1 - edgeSoft) + frB * edgeSoft;
      }

      // Monitor base stand
      if (ny >= 0.76 && ny <= 0.80 && Math.abs(nx - 0.5) <= 0.16) {
        const t = (nx - 0.34) / 0.32;
        const frR = 56 * (1 - t) + 192 * t;
        const frG = 189 * (1 - t) + 132 * t;
        const frB = 248 * (1 - t) + 252 * t;
        r = frR; g = frG; b = frB;
      }

      // 4. Stylized glowing "S" shape
      // Top horizontal / arc of S (y ~ 0.32..0.40, x ~ 0.38..0.62)
      // Middle curve of S (y ~ 0.48..0.56, x ~ 0.38..0.62)
      // Bottom curve of S (y ~ 0.64..0.72, x ~ 0.38..0.62)
      // Left vertical connecting top to mid (x ~ 0.36..0.44, y ~ 0.38..0.52)
      // Right vertical connecting mid to bottom (x ~ 0.56..0.64, y ~ 0.52..0.66)
      let sAlpha = 0;

      // Distance to stylized S centerline
      const topArc = Math.hypot(nx - 0.56, ny - 0.38) < 0.08 || (ny >= 0.30 && ny <= 0.37 && nx >= 0.42 && nx <= 0.64);
      const midBar = (ny >= 0.49 && ny <= 0.55 && nx >= 0.40 && nx <= 0.58);
      const botArc = (ny >= 0.67 && ny <= 0.74 && nx >= 0.36 && nx <= 0.58) || (Math.hypot(nx - 0.42, ny - 0.68) < 0.08);
      const leftBar = (nx >= 0.38 && nx <= 0.46 && ny >= 0.34 && ny <= 0.52);
      const rightBar = (nx >= 0.56 && nx <= 0.64 && ny >= 0.50 && ny <= 0.70);

      if (topArc || midBar || botArc || leftBar || rightBar) {
        sAlpha = 1.0;
      }

      // 5. Play triangle at bottom right (nx ~ 0.68..0.76, ny ~ 0.60..0.70)
      const inPlayTri = (nx >= 0.66 && nx <= 0.78 && ny >= 0.59 && ny <= 0.71) &&
                        ((ny - 0.59) * 0.5 >= (nx - 0.66) - 0.12 && (0.71 - ny) * 0.5 >= (nx - 0.66) - 0.12);

      if (inPlayTri) {
        r = 192;
        g = 132;
        b = 252;
      } else if (sAlpha > 0) {
        r = 255;
        g = 255;
        b = 255;
      }

      rawData[pxOffset + 0] = Math.round(r);
      rawData[pxOffset + 1] = Math.round(g);
      rawData[pxOffset + 2] = Math.round(b);
      rawData[pxOffset + 3] = a;
    }
  }

  // Compress IDAT
  const compressed = zlib.deflateSync(rawData);

  // PNG Header
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);

    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    const combined = Buffer.concat([typeBuf, data]);
    const crc = crc32(combined);
    crcBuf.writeUInt32BE(crc, 0);

    return Buffer.concat([len, combined, crcBuf]);
  }

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0; // Compression
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // Interlace

  // CRC32 table
  function crc32(buf) {
    let table = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ (-1)) >>> 0;
  }

  const ihdrChunk = chunk('IHDR', ihdr);
  const idatChunk = chunk('IDAT', compressed);
  const iendChunk = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Generate sizes
const png32 = createPng(64);
const png192 = createPng(192);

fs.writeFileSync(path.join(__dirname, '..', 'favicon.png'), png32);
fs.writeFileSync(path.join(__dirname, '..', 'public', 'favicon.png'), png32);
fs.writeFileSync(path.join(__dirname, '..', 'icon-192.png'), png192);
fs.writeFileSync(path.join(__dirname, '..', 'public', 'icon-192.png'), png192);

console.log('PNG favicons generated successfully!');

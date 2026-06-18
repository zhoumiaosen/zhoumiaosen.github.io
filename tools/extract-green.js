const fs = require("fs");
const zlib = require("zlib");

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readPng(path) {
  const data = fs.readFileSync(path);
  if (data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Not a PNG");
  let off = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  const idat = [];
  while (off < data.length) {
    const len = data.readUInt32BE(off);
    off += 4;
    const type = data.subarray(off, off + 4).toString("ascii");
    off += 4;
    const chunk = data.subarray(off, off + len);
    off += len + 4;
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
    } else if (type === "IDAT") {
      idat.push(chunk);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8 || ![2, 6].includes(colorType)) {
    throw new Error(`Unsupported PNG type bitDepth=${bitDepth} colorType=${colorType}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * channels);
  const prior = Buffer.alloc(stride);
  let src = 0;
  let dst = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const line = Buffer.from(raw.subarray(src, src + stride));
    src += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prior[x];
      const c = x >= channels ? prior[x - channels] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`Unsupported filter ${filter}`);
      }
      line[x] = (line[x] + pred) & 255;
    }
    line.copy(pixels, dst);
    dst += stride;
    line.copy(prior);
  }

  return { width, height, channels, pixels };
}

function writePngRGBA(path, width, height, rgba) {
  const scan = Buffer.alloc(height * (1 + width * 4));
  let s = 0;
  let p = 0;
  for (let y = 0; y < height; y++) {
    scan[s++] = 0;
    rgba.copy(scan, s, p, p + width * 4);
    s += width * 4;
    p += width * 4;
  }

  const chunks = [];
  function chunk(type, payload) {
    const typeBuf = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, payload])));
    chunks.push(len, typeBuf, payload, crc);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  chunk("IHDR", ihdr);
  chunk("IDAT", zlib.deflateSync(scan, { level: 9 }));
  chunk("IEND", Buffer.alloc(0));
  fs.writeFileSync(path, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), ...chunks]));
}

function extract(input, output) {
  const png = readPng(input);
  const rgba = Buffer.alloc(png.width * png.height * 4);
  let minX = png.width;
  let minY = png.height;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * png.channels;
      const o = (y * png.width + x) * 4;
      let r = png.pixels[i];
      let g = png.pixels[i + 1];
      const b = png.pixels[i + 2];
      const greenDominance = g - Math.max(r, b);
      let alpha = 255;

      if (g > 135 && greenDominance > 35) {
        const dominance = Math.min(1, Math.max(0, (greenDominance - 35) / 115));
        const brightness = Math.min(1, Math.max(0, (g - 135) / 120));
        const key = Math.max(dominance, brightness * 0.85);
        alpha = Math.round(255 * (1 - key));
        if (alpha < 22) alpha = 0;
      }

      if (alpha > 0 && greenDominance > 18) {
        g = Math.min(g, Math.max(r, b) + 28);
      }

      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = alpha;

      if (alpha > 8) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const pad = 12;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(png.width - 1, maxX + pad);
  maxY = Math.min(png.height - 1, maxY + pad);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const cropped = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    const srcStart = ((minY + y) * png.width + minX) * 4;
    rgba.copy(cropped, y * width * 4, srcStart, srcStart + width * 4);
  }

  writePngRGBA(output, width, height, cropped);
  console.log(JSON.stringify({ input: { width: png.width, height: png.height }, crop: { x: minX, y: minY, width, height }, output }, null, 2));
}

extract(process.argv[2], process.argv[3]);

import { inflateSync, deflateSync, crc32 } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunks(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const out = [];
  let at = 8;
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    out.push({ type, data: buf.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function pngSize(buf) {
  const ihdr = chunks(buf).find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG has no header');
  return { width: ihdr.data.readUInt32BE(0), height: ihdr.data.readUInt32BE(4) };
}

export function cropPng(buf, rect) {
  const parts = chunks(buf);
  const ihdr = parts.find((c) => c.type === 'IHDR')?.data;
  if (!ihdr) throw new Error('PNG has no header');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [depth, colour, , , interlace] = ihdr.subarray(8, 13);
  if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`);
  }
  const bpp = colour === 6 ? 4 : 3;
  const stride = width * bpp;

  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) throw new Error('crop is empty');

  const raw = inflateSync(Buffer.concat(parts.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  let prev = Buffer.alloc(stride);
  const rows = [];
  for (let y = 0; y < y1; y++) {
    const at = y * (stride + 1);
    const filter = raw[at];
    const line = Buffer.from(raw.subarray(at + 1, at + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 255;
      else if (filter === 2) line[i] = (line[i] + b) & 255;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) line[i] = (line[i] + paeth(a, b, c)) & 255;
      else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
    }
    if (y >= y0) rows.push(line.subarray(x0 * bpp, x1 * bpp));
    prev = line;
  }

  const w = x1 - x0;
  const h = y1 - y0;
  const body = Buffer.alloc(h * (w * bpp + 1));
  rows.forEach((row, i) => row.copy(body, i * (w * bpp + 1) + 1));
  const head = Buffer.from(ihdr);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  return Buffer.concat([SIGNATURE, chunk('IHDR', head), chunk('IDAT', deflateSync(body)), chunk('IEND', Buffer.alloc(0))]);
}

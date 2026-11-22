import type { QrMatrix } from "./qr";

/**
 * Renders a QR matrix as a PNG: black modules on a fully transparent background.
 *
 * Uses a 1-bit palette image (index 0 = transparent, index 1 = opaque black),
 * so even the largest codes stay small. Compression uses the platform's
 * CompressionStream, which is available on Workers and in Node 18+.
 */

const SCALE = 12; // pixels per module
const QUIET = 2; // transparent margin, in modules

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlibDeflate(raw: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function renderPng({ size, modules }: QrMatrix): Promise<Uint8Array<ArrayBuffer>> {
  const dim = (size + QUIET * 2) * SCALE;
  const rowBytes = Math.ceil(dim / 8);
  const raw = new Uint8Array((rowBytes + 1) * dim); // each row: filter byte (0) + packed pixels

  for (let my = 0; my < size; my++) {
    // Build one pixel row for this module row, then repeat it SCALE times.
    const row = new Uint8Array(rowBytes);
    for (let mx = 0; mx < size; mx++) {
      if (!modules[my * size + mx]) continue;
      const x0 = (mx + QUIET) * SCALE;
      for (let px = x0; px < x0 + SCALE; px++) row[px >> 3] |= 0x80 >> (px & 7);
    }
    for (let r = 0; r < SCALE; r++) {
      const y = (my + QUIET) * SCALE + r;
      raw.set(row, y * (rowBytes + 1) + 1);
    }
  }

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, dim);
  iv.setUint32(4, dim);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 3; // colour type: palette

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", new Uint8Array([0, 0, 0, 0, 0, 0])),
    chunk("tRNS", new Uint8Array([0, 255])),
    chunk("IDAT", await zlibDeflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

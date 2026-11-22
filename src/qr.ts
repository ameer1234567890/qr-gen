/**
 * Minimal QR Code encoder: byte mode, error-correction level M, versions 1-40.
 * No dependencies, so it runs unchanged on Cloudflare Workers.
 *
 * Returns the module matrix as a flat Uint8Array (1 = dark) plus its side length.
 */

export interface QrMatrix {
  size: number;
  /** Row-major, `size * size` entries; 1 = dark module, 0 = light. */
  modules: Uint8Array;
}

// Error-correction level M tables, indexed by version (index 0 unused).
const ECC_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const NUM_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31,
  33, 35, 37, 38, 40, 43, 45, 47, 49,
];
const FORMAT_BITS_M = 0; // level M = 0b00

const MAX_VERSION = 40;

function rawDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    n -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
}

// ---------- Reed-Solomon over GF(256), polynomial 0x11D ----------

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((c, i) => {
      result[i] ^= gfMul(c, factor);
    });
  }
  return result;
}

// ---------- Codeword assembly ----------

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function buildCodewords(bytes: Uint8Array, ver: number): number[] {
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCodewords(ver) * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  push(0, (8 - (bits.length % 8)) % 8); // byte-align

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  for (let pad = 0xec; data.length < dataCodewords(ver); pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, add error correction, interleave.
  const numBlocks = NUM_BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);

  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0); // placeholder, skipped when interleaving
    blocks.push(dat.concat(ecc));
  }

  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(block[i]);
    });
  }
  return out;
}

// ---------- Matrix construction ----------

class Grid {
  readonly modules: Uint8Array;
  readonly isFn: Uint8Array;
  constructor(readonly size: number) {
    this.modules = new Uint8Array(size * size);
    this.isFn = new Uint8Array(size * size);
  }
  setFn(x: number, y: number, dark: boolean): void {
    const i = y * this.size + x;
    this.modules[i] = dark ? 1 : 0;
    this.isFn[i] = 1;
  }
}

const bit = (v: number, i: number) => ((v >>> i) & 1) !== 0;

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < n; pos -= step) result.splice(1, 0, pos);
  return result;
}

function drawFormat(g: Grid, mask: number): void {
  const data = (FORMAT_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const s = g.size;

  for (let i = 0; i <= 5; i++) g.setFn(8, i, bit(bits, i));
  g.setFn(8, 7, bit(bits, 6));
  g.setFn(8, 8, bit(bits, 7));
  g.setFn(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) g.setFn(14 - i, 8, bit(bits, i));

  for (let i = 0; i < 8; i++) g.setFn(s - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) g.setFn(8, s - 15 + i, bit(bits, i));
  g.setFn(8, s - 8, true); // always-dark module
}

function drawFunctionPatterns(g: Grid, ver: number): void {
  const s = g.size;
  for (let i = 0; i < s; i++) {
    g.setFn(6, i, i % 2 === 0);
    g.setFn(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < s && y >= 0 && y < s) g.setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(s - 4, 3);
  finder(3, s - 4);

  const pos = alignmentPositions(ver, s);
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          g.setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  drawFormat(g, 0); // reserve the format area; rewritten once the mask is chosen
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = s - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.setFn(a, b, bit(bits, i));
      g.setFn(b, a, bit(bits, i));
    }
  }
}

function placeData(g: Grid, codewords: number[]): void {
  const s = g.size;
  let i = 0;
  for (let right = s - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < s; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? s - 1 - vert : vert;
        const idx = y * s + x;
        if (!g.isFn[idx] && i < codewords.length * 8) {
          g.modules[idx] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }
}

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
  }
}

function applyMask(g: Grid, mask: number): void {
  const s = g.size;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = y * s + x;
      if (!g.isFn[i] && maskApplies(mask, x, y)) g.modules[i] ^= 1;
    }
  }
}

// Penalty score per the QR spec (rules N1-N4); lower is better.
// Written with plain index arithmetic over the typed array: this runs 8x per code.
function penalty(g: Grid): number {
  const s = g.size;
  const m = g.modules;
  let score = 0;

  // Scans one row (stride 1) or column (stride s) starting at `start`.
  const scanLine = (start: number, stride: number) => {
    let run = 1;
    let prev = m[start];
    // Sliding 11-module window for the finder-like pattern (N3), as bits.
    let win = prev;
    for (let k = 1; k < s; k++) {
      const c = m[start + k * stride];
      if (c === prev) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
        prev = c;
      }
      win = ((win << 1) | c) & 0x7ff;
      // 10111010000 and 00001011101: finder pattern plus 4 light modules on either side.
      if (k >= 10 && (win === 0x5d0 || win === 0x05d)) score += 40;
    }
    if (run >= 5) score += 3 + (run - 5);
  };
  for (let i = 0; i < s; i++) {
    scanLine(i * s, 1);
    scanLine(i, s);
  }

  // N2: 2x2 blocks of one colour; also count dark modules for N4.
  let dark = 0;
  for (let y = 0; y < s; y++) {
    const row = y * s;
    for (let x = 0; x < s; x++) {
      const c = m[row + x];
      dark += c;
      if (x + 1 < s && y + 1 < s && c === m[row + x + 1] && c === m[row + s + x] && c === m[row + s + x + 1]) {
        score += 3;
      }
    }
  }

  const total = s * s;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encodes `text` (as UTF-8 bytes) into a QR code at error-correction level M. */
export function encodeQr(text: string): QrMatrix {
  const bytes = utf8(text);

  let ver = 1;
  const fits = (v: number) => 4 + (v <= 9 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v) * 8;
  while (ver <= MAX_VERSION && !fits(ver)) ver++;
  if (ver > MAX_VERSION) throw new Error("That URL is too long to fit in a QR code.");

  const size = ver * 4 + 17;
  const g = new Grid(size);
  drawFunctionPatterns(g, ver);
  placeData(g, buildCodewords(bytes, ver));

  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(g, mask);
    drawFormat(g, mask);
    const score = penalty(g);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    applyMask(g, mask); // undo
  }
  applyMask(g, bestMask);
  drawFormat(g, bestMask);

  return { size, modules: g.modules };
}

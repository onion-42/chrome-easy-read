// MD5 (RFC 1321) of bytes, as lowercase hex. Zotero's file upload asks for it, and WebCrypto has no MD5.
// One source of truth (skill zotero-link); the extensions ship byte-identical copies.

const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const SINES = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
const BLOCK = 64;

/** bytes: Uint8Array or ArrayBuffer. */
export function md5(bytes) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const len = src.byteLength;
  // the message, one 0x80 byte, zeros, then the length in bits as 64-bit little-endian
  const padded = new Uint8Array((((len + 8) >> 6) + 1) * BLOCK);
  padded.set(src);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (len * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(len / 2 ** 29), true);

  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const m = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += BLOCK) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      let f, g;
      if (round === 0) [f, g] = [(b & c) | (~b & d), i];
      else if (round === 1) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (round === 2) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      const x = (a + f + SINES[i] + m[g]) | 0;
      const s = SHIFTS[round * 4 + (i % 4)];
      [a, d, c, b] = [d, c, b, (b + ((x << s) | (x >>> (32 - s)))) | 0];
    }
    state[0] = (state[0] + a) | 0;
    state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0;
    state[3] = (state[3] + d) | 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  state.forEach((word, i) => out.setUint32(i * 4, word >>> 0, true));
  return [...new Uint8Array(out.buffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

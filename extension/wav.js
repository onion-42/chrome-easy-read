// 16-bit PCM <-> WAV: an <audio> element plays Gemini's raw audio, the local voice server answers with WAV.

const HEADER_BYTES = 44;

export function pcmToWav(pcm, sampleRate, channels = 1, bitsPerSample = 16) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const wav = new Uint8Array(HEADER_BYTES + pcm.length);
  const v = new DataView(wav.buffer);
  const ascii = (offset, s) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);            // fmt chunk size
  v.setUint16(20, 1, true);             // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  v.setUint32(40, pcm.length, true);
  wav.set(pcm, HEADER_BYTES);
  return wav;
}

/** WAV file bytes -> { pcm: Uint8Array (PCM16), sampleRate }. Throws on anything that is not 16-bit PCM. */
export function wavToPcm(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file.");
  let sampleRate = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt ") {
      if (view.getUint16(at + 8, true) !== 1 || view.getUint16(at + 22, true) !== 16) throw new Error("Only 16-bit PCM WAV is supported.");
      sampleRate = view.getUint32(at + 12, true);
    } else if (tag(at) === "data") {
      return { pcm: bytes.subarray(at + 8, Math.min(at + 8 + size, bytes.length)), sampleRate };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("The WAV file has no audio data.");
}

export function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function bytesToBase64(bytes) {
  const CHUNK = 0x8000; // String.fromCharCode has an argument limit
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

// 16-bit PCM -> WAV, so an <audio> element can play Gemini's raw audio.

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

export function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { pcmToWav, base64ToBytes, wavToPcm, bytesToBase64 } from "../extension/wav.js";

test("pcmToWav writes a 44-byte PCM header in front of the samples", () => {
  const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const wav = pcmToWav(pcm, 24000);
  const v = new DataView(wav.buffer);
  const str = (o) => String.fromCharCode(...wav.slice(o, o + 4));
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(str(0), "RIFF");
  assert.equal(v.getUint32(4, true), 36 + pcm.length);
  assert.equal(str(8), "WAVE");
  assert.equal(str(12), "fmt ");
  assert.equal(v.getUint16(20, true), 1);      // PCM
  assert.equal(v.getUint16(22, true), 1);      // mono
  assert.equal(v.getUint32(24, true), 24000);  // sample rate
  assert.equal(v.getUint32(28, true), 48000);  // byte rate
  assert.equal(v.getUint16(32, true), 2);      // block align
  assert.equal(v.getUint16(34, true), 16);     // bits per sample
  assert.equal(str(36), "data");
  assert.equal(v.getUint32(40, true), pcm.length);
  assert.deepEqual([...wav.slice(44)], [...pcm]);
});

test("base64ToBytes decodes base64", () => {
  assert.deepEqual([...base64ToBytes(Buffer.from([0, 255, 7]).toString("base64"))], [0, 255, 7]);
});

test("wavToPcm reads back the samples and the sample rate that pcmToWav wrote", () => {
  const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const back = wavToPcm(pcmToWav(pcm, 22050));
  assert.deepEqual([...back.pcm], [...pcm]);
  assert.equal(back.sampleRate, 22050);
});

test("wavToPcm skips chunks it does not know and reads a file that sits inside a bigger buffer", () => {
  const plain = pcmToWav(new Uint8Array([9, 8, 7, 6]), 16000);
  const extra = new Uint8Array([..."LIST"].map((c) => c.charCodeAt(0)).concat([3, 0, 0, 0, 1, 2, 3, 0])); // odd size + pad byte
  const wav = new Uint8Array([...plain.slice(0, 36), ...extra, ...plain.slice(36)]);
  const padded = new Uint8Array([0, 0, ...wav]).subarray(2);
  const back = wavToPcm(padded);
  assert.deepEqual([...back.pcm], [9, 8, 7, 6]);
  assert.equal(back.sampleRate, 16000);
});

test("wavToPcm refuses bytes that are not a 16-bit PCM WAV file", () => {
  assert.throws(() => wavToPcm(new Uint8Array(64)), /Not a WAV file/);
  assert.throws(() => wavToPcm(pcmToWav(new Uint8Array(4), 22050, 1, 8)), /16-bit PCM/);
  assert.throws(() => wavToPcm(pcmToWav(new Uint8Array(4), 22050).slice(0, 36)), /no audio data/);
});

test("bytesToBase64 is the reverse of base64ToBytes, also past one chunk", () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 256);
  assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { pcmToWav, base64ToBytes } from "../extension/wav.js";

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

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, synthesizeLocal, voiceFor, NOT_RUNNING } from "../extension/tts/local.js";
import { pcmToWav, base64ToBytes } from "../extension/wav.js";

const OPTS = { localUrl: "http://127.0.0.1:5005/", localVoiceEn: "en_US-lessac-medium", localVoiceRu: "ru_RU-irina-medium" };
const wavResponse = (pcm, rate) => ({ ok: true, status: 200, arrayBuffer: async () => pcmToWav(pcm, rate).buffer });

test("a Russian phrase gets the Russian voice, everything else the English one", () => {
  assert.equal(voiceFor("ru", OPTS), "ru_RU-irina-medium");
  assert.equal(voiceFor("ru-RU", OPTS), "ru_RU-irina-medium");
  assert.equal(voiceFor("en", OPTS), "en_US-lessac-medium");
  assert.equal(voiceFor(undefined, OPTS), "en_US-lessac-medium");
});

test("the request goes to /synthesize on the local server with the text and the voice", () => {
  const { url, init } = buildRequest("Привет", "ru", OPTS);
  assert.equal(url, "http://127.0.0.1:5005/synthesize");
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), { text: "Привет", voice: "ru_RU-irina-medium" });
});

test("synthesizeLocal returns base64 PCM and the sample rate of the server's WAV", async () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const audio = await synthesizeLocal("Hello", "en", OPTS, async () => wavResponse(pcm, 22050));
  assert.deepEqual([...base64ToBytes(audio.data)], [...pcm]);
  assert.equal(audio.sampleRate, 22050);
});

test("a server that is not running gives the start command", async () => {
  const down = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(synthesizeLocal("Hello", "en", OPTS, down), { message: NOT_RUNNING });
  assert.match(NOT_RUNNING, /systemctl --user start easy-read-voice/);
});

test("a server error names the HTTP status and points at the voice names", async () => {
  const broken = async () => ({ ok: false, status: 500 });
  await assert.rejects(synthesizeLocal("Hello", "en", OPTS, broken), /HTTP 500.*voice names/);
});

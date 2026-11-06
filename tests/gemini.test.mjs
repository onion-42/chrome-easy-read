import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, synthesize, GEMINI_URL } from "../extension/tts/gemini.js";

const OPTS = { apiKey: "k-123", model: "gemini-3.8-flash-tts", voice: "Kore", style: "calm and clear" };
const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });

test("buildRequest asks for 24 kHz PCM from the chosen model, voice and style", () => {
  const { url, init } = buildRequest("Hello there.", OPTS);
  const body = JSON.parse(init.body);
  assert.equal(url, GEMINI_URL);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-goog-api-key"], "k-123");
  assert.equal(body.model, "gemini-3.8-flash-tts");
  assert.deepEqual(body.generation_config.speech_config, [{ voice: "Kore" }]);
  assert.deepEqual(body.response_format, { type: "audio", mime_type: "audio/l16", sample_rate: 24000 });
  const content = body.input[0].content[0];
  assert.equal(content.text, "Hello there.");
  assert.deepEqual(content.annotations, [{ type: "speech_metadata", style: "calm and clear" }]);
});

test("buildRequest leaves out the style annotation when no style is set", () => {
  const body = JSON.parse(buildRequest("Hi.", { ...OPTS, style: "" }).init.body);
  assert.equal(body.input[0].content[0].annotations, undefined);
});

test("synthesize reads the audio from the REST steps (output_audio is only an SDK helper)", async () => {
  const body = { steps: [
    { type: "user_input", content: [{ type: "text", text: "Hi." }] },
    { type: "model_output", content: [{ type: "audio", data: "AAEC", mime_type: "audio/l16" }] },
  ] };
  const audio = await synthesize("Hi.", OPTS, reply(200, body));
  assert.deepEqual(audio, { data: "AAEC", sampleRate: 24000 });
});

test("synthesize explains failures in plain words", async () => {
  const cases = [
    [reply(400, { error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }), /API key/],
    [reply(403, { error: { status: "PERMISSION_DENIED" } }), /API key/],
    [reply(429, { error: { status: "RESOURCE_EXHAUSTED" } }), /rate limit/],
    [reply(503, { error: { status: "UNAVAILABLE" } }), /unavailable.*503/],
    [reply(200, { outputs: [] }), /no audio/],
    [async () => { throw new TypeError("Failed to fetch"); }, /connection/],
  ];
  for (const [fetchFn, message] of cases) {
    await assert.rejects(synthesize("Hi.", OPTS, fetchFn), message);
  }
});

test("synthesize refuses to run without an API key", async () => {
  await assert.rejects(synthesize("Hi.", { ...OPTS, apiKey: "" }, reply(200, {})), /Add your Gemini API key/);
});

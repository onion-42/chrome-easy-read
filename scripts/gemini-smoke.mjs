// One real Gemini TTS request (one short sentence) to check the request format and the key.
// Usage: GEMINI_API_KEY=... node scripts/gemini-smoke.mjs [model] [voice]
import { buildRequest } from "../extension/tts/gemini.js";
import { modelOutputs } from "../extension/gemini-api.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is not set");
  process.exit(1);
}
const [model = "gemini-3.8-flash-tts", voice = "Kore"] = process.argv.slice(2);
const { url, init } = buildRequest("Hello, this is a test.", { apiKey, model, voice, style: "calm and clear" });
const res = await fetch(url, init);
const body = await res.json().catch(() => null);
console.log("HTTP", res.status);
console.log("top-level keys:", body && Object.keys(body));
const audio = modelOutputs(body, "audio").at(-1);
if (audio) {
  const { data, ...meta } = audio;
  console.log("audio:", meta, "bytes:", data ? Buffer.from(data, "base64").length : 0);
} else {
  console.log("body:", JSON.stringify(body).slice(0, 800));
}

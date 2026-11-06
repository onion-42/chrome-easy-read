// Gemini TTS: one request per text chunk, raw 24 kHz PCM back (no word timings in the API).
import { GEMINI_URL, NO_KEY, interactionRequest, send, modelOutputs } from "../gemini-api.js";

export { GEMINI_URL };
const SAMPLE_RATE = 24000;

export function buildRequest(text, { apiKey, model, voice, style }) {
  const content = { type: "text", text };
  if (style) content.annotations = [{ type: "speech_metadata", style }];
  return interactionRequest({
    model,
    input: [{ type: "user_input", content: [content] }],
    response_format: { type: "audio", mime_type: "audio/l16", sample_rate: SAMPLE_RATE },
    generation_config: { speech_config: [{ voice }] },
  }, apiKey);
}

/** Text -> { data: base64 PCM16, sampleRate }. Throws an Error with a message fit for the user. */
export async function synthesize(text, opts, fetchFn = fetch) {
  if (!opts.apiKey) throw new Error(`${NO_KEY} Or switch to the built-in voice.`);
  const body = await send(buildRequest(text, opts), fetchFn);
  const data = modelOutputs(body, "audio").at(-1)?.data;
  if (!data) throw new Error("Gemini returned no audio for this text.");
  return { data, sampleRate: SAMPLE_RATE };
}

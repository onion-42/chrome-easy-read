// Local neural voice: a Piper HTTP server on this computer. Nothing leaves the machine.
import { wavToPcm, bytesToBase64 } from "../wav.js";

export const NOT_RUNNING = "The local voice is not running. Start it: systemctl --user start easy-read-voice";

export const voiceFor = (lang, { localVoiceEn, localVoiceRu }) => (/^ru/i.test(lang || "") ? localVoiceRu : localVoiceEn);

export function buildRequest(text, lang, opts) {
  return {
    url: `${opts.localUrl.replace(/\/+$/, "")}/synthesize`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: voiceFor(lang, opts) }),
    },
  };
}

/** Text -> { data: base64 PCM16, sampleRate }. Throws an Error with a message fit for the user. */
export async function synthesizeLocal(text, lang, opts, fetchFn = fetch) {
  const { url, init } = buildRequest(text, lang, opts);
  let res;
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    throw new Error(NOT_RUNNING, { cause: e });
  }
  if (!res.ok) throw new Error(`The local voice could not read this text (HTTP ${res.status}). Check the voice names in options.`);
  const { pcm, sampleRate } = wavToPcm(new Uint8Array(await res.arrayBuffer()));
  return { data: bytesToBase64(pcm), sampleRate };
}

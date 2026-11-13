// Shared Gemini REST plumbing (Interactions API): request, plain-language errors, model output.

export const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const NO_KEY = "Add your Gemini API key in the extension options.";

export function interactionRequest(payload, apiKey) {
  return {
    url: GEMINI_URL,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(payload),
    },
  };
}

function failure(status, body) {
  const reasons = JSON.stringify(body?.error ?? {});
  if (status === 401 || status === 403 || reasons.includes("API_KEY_INVALID")) {
    return "Gemini rejected the API key. Check it in the extension options.";
  }
  if (status === 429) return "Gemini rate limit reached. Wait a minute and try again.";
  if (status === 413) return "This file is too big for Gemini.";
  if (status >= 500) return `Gemini is unavailable right now (HTTP ${status}). Try again later.`;
  return `Gemini could not handle this request (HTTP ${status}).`;
}

/** Send a request; returns the JSON body or throws an Error whose message is fit for the user. */
export async function send({ url, init }, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    throw new Error("No connection to Gemini. Check the internet connection.", { cause: e });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(failure(res.status, body));
  return body;
}

/** Contents of one type ("text") from the model's output steps, in order.
 * (The SDKs' output_text is a helper; the REST body only has steps.) */
export function modelOutputs(body, type) {
  return (body?.steps ?? [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === type);
}

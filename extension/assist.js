// Questions about the paper (Claude) and translation (DeepSeek). Request builders are pure; tests pass a fake fetch.
export const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
export const MAX_PAPER_CHARS = 1_500_000; // far above any paper; a bigger text is refused, never cut silently
export const MAX_TRANSLATE_CHARS = 60_000;

// USD per million tokens: [input, 1-hour cache write, cache read, output], from
// https://platform.claude.com/docs/en/about-claude/pricing (2026-11-13). A model that is not listed shows tokens only.
export const PRICES = {
  "claude-opus-5-5": { rates: [4, 8, 0.2, 20] },
  "claude-sonnet-5-5": { rates: [2, 4, 0.1, 10] },
  "claude-haiku-5-5": { rates: [0.1, 0.2, 0.01, 0.5], bigRates: [0.5, 1, 0.05, 2.5] },
};
const BIG_PROMPT_TOKENS = 100_000; // Haiku 5.5 costs more per token above this prompt size

/** Token counts and the approximate price of one answer (usd is null when the model has no listed price). */
export function usageOf(body, model) {
  const u = body?.usage ?? {};
  const fresh = u.input_tokens ?? 0, written = u.cache_creation_input_tokens ?? 0;
  const cached = u.cache_read_input_tokens ?? 0, out = u.output_tokens ?? 0;
  const price = PRICES[model];
  const prompt = fresh + written + cached;
  const [input, write, read, output] = (prompt > BIG_PROMPT_TOKENS && price?.bigRates) || price?.rates || [];
  const usd = price ? (fresh * input + written * write + cached * read + out * output) / 1e6 : null;
  return { tokens: prompt + out, cached, usd };
}

const ASK_RULES = [
  "You answer questions about one scientific paper for a reader with dyslexia.",
  "- Use only the paper inside <paper>. When the paper does not say, state that plainly.",
  "- Name where the answer comes from: the section, figure, table or page.",
  "- Answer in the language of the question. Keep technical terms in English.",
  "- Plain text only, no Markdown. Short paragraphs, one idea in each.",
].join("\n");

function failure(who, status) {
  if (status === 401 || status === 403) return `${who} rejected the API key. Check it in the extension options.`;
  if (status === 402) return `${who}: the balance is empty. Top it up, then try again.`;
  if (status === 429) return `${who} rate limit reached. Wait a minute and try again.`;
  if (status === 413) return `This text is too big for ${who}.`;
  if (status >= 500) return `${who} is unavailable right now (HTTP ${status}). Try again later.`;
  return `${who} could not handle this request (HTTP ${status}).`;
}

/** POST JSON -> the JSON body. Throws an Error with a message fit for the user. */
export async function post(who, { url, init }, fetchFn) {
  let res;
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    throw new Error(`No connection to ${who}. Check the internet connection.`, { cause: e });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(failure(who, res.status));
  return body ?? {};
}

/** history: earlier turns exactly as sent and received ({ role, content }); the paper block is the cached prefix. */
export function buildAskRequest({ paper, history, question }, { claudeKey, claudeModel }) {
  return {
    url: CLAUDE_URL,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": claudeKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true", // the key is the user's own and stays in this browser
      },
      body: JSON.stringify({
        model: claudeModel,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: [
          { type: "text", text: ASK_RULES },
          { type: "text", text: `<paper>\n${paper}\n</paper>`, cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
        messages: [...history, { role: "user", content: question }],
      }),
    },
  };
}

/** -> { text, turn, usage }: the answer, the assistant turn to keep in the history (content blocks unchanged), the cost. */
export async function ask(input, opts, fetchFn = fetch) {
  if (!opts.claudeKey) throw new Error("Add your Claude API key in the extension options.");
  if (!input.paper.trim()) throw new Error("There is no text to ask about. For a scanned PDF, use “Read this scan with Gemini” first.");
  if (input.paper.length > MAX_PAPER_CHARS) throw new Error("This text is too long to send to Claude in one piece.");
  const body = await post("Claude", buildAskRequest(input, opts), fetchFn);
  if (body.stop_reason === "refusal") throw new Error("Claude declined to answer this question.");
  const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  if (!text) throw new Error("Claude returned no answer.");
  const cut = body.stop_reason === "max_tokens" ? "\n\n(The answer was cut off at the length limit.)" : "";
  return { text: text + cut, turn: { role: "assistant", content: body.content }, usage: usageOf(body, opts.claudeModel) };
}

export function buildTranslateRequest(text, { deepseekKey, deepseekUrl, deepseekModel, translateTo }) {
  return {
    url: `${deepseekUrl.replace(/\/+$/, "")}/chat/completions`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deepseekKey}` },
      body: JSON.stringify({
        model: deepseekModel,
        messages: [
          { role: "system", content: `Translate the user's text into ${translateTo}. Keep numbers, citations, gene and method names unchanged. Output only the translation.` },
          { role: "user", content: text },
        ],
      }),
    },
  };
}

export async function translate(text, opts, fetchFn = fetch) {
  if (!opts.deepseekKey) throw new Error("Add your DeepSeek API key in the extension options.");
  if (text.length > MAX_TRANSLATE_CHARS) throw new Error(`This selection is too long to translate in one piece (${MAX_TRANSLATE_CHARS} characters at most). Select a smaller part.`);
  const body = await post("DeepSeek", buildTranslateRequest(text, opts), fetchFn);
  const out = body.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error("DeepSeek returned no translation.");
  return { text: out };
}

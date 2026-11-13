import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ask, translate, buildAskRequest, buildTranslateRequest, usageOf, CLAUDE_URL, MAX_TRANSLATE_CHARS, MAX_PAPER_CHARS,
} from "../extension/assist.js";

const OPTS = {
  claudeKey: "sk-ant-test", claudeModel: "claude-opus-5-5",
  deepseekKey: "ds-test", deepseekUrl: "https://api.deepseek.com/", deepseekModel: "deepseek-chat", translateTo: "Russian",
};
const reply = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });
const never = async () => { throw new Error("the network must not be used"); };
const answer = (over = {}) => ({
  stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "TLS are described in Figure 2." }],
  usage: { input_tokens: 100, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0, output_tokens: 500 },
  ...over,
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

/* ---------- price ---------- */

test("usageOf prices a first question: the paper is written to the 1-hour cache", () => {
  const u = usageOf(answer(), "claude-opus-5-5");
  assert.equal(u.tokens, 20600);
  assert.equal(u.cached, 0);
  near(u.usd, (100 * 4 + 20000 * 8 + 500 * 20) / 1e6);
});

test("usageOf prices a follow-up question: the paper is read from the cache", () => {
  const body = { usage: { input_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 20000, output_tokens: 400 } };
  const u = usageOf(body, "claude-opus-5-5");
  assert.equal(u.cached, 20000);
  near(u.usd, (150 * 4 + 20000 * 0.2 + 400 * 20) / 1e6);
});

test("usageOf uses the higher Haiku price for a prompt over 100,000 tokens", () => {
  const small = { usage: { input_tokens: 50000, output_tokens: 1000 } };
  const big = { usage: { input_tokens: 1000, cache_read_input_tokens: 120000, output_tokens: 1000 } };
  near(usageOf(small, "claude-haiku-5-5").usd, (50000 * 0.1 + 1000 * 0.5) / 1e6);
  near(usageOf(big, "claude-haiku-5-5").usd, (1000 * 0.5 + 120000 * 0.05 + 1000 * 2.5) / 1e6);
});

test("usageOf shows tokens only for a model without a listed price or a reply without usage", () => {
  assert.deepEqual(usageOf(answer(), "some-future-model"), { tokens: 20600, cached: 0, usd: null });
  assert.deepEqual(usageOf({}, "some-future-model"), { tokens: 0, cached: 0, usd: null });
});

/* ---------- questions (Claude) ---------- */

test("the Claude request carries the key, the browser header and the paper as a 1-hour cached block", () => {
  const history = [{ role: "user", content: "What is TLS?" }, { role: "assistant", content: [{ type: "text", text: "A structure." }] }];
  const { url, init } = buildAskRequest({ paper: "Paper text.", history, question: "Where is it shown?" }, OPTS);
  const body = JSON.parse(init.body);
  assert.equal(url, CLAUDE_URL);
  assert.equal(init.headers["x-api-key"], "sk-ant-test");
  assert.equal(init.headers["anthropic-version"], "2023-06-01");
  assert.equal(init.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(body.model, "claude-opus-5-5");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.equal(body.system.length, 2);
  assert.equal(body.system[0].cache_control, undefined);
  assert.equal(body.system[1].text, "<paper>\nPaper text.\n</paper>");
  assert.deepEqual(body.system[1].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(body.messages, [...history, { role: "user", content: "Where is it shown?" }]);
});

test("ask returns the answer, the assistant turn unchanged and the usage", async () => {
  const body = answer();
  const res = await ask({ paper: "Paper text.", history: [], question: "Q?" }, OPTS, reply(body));
  assert.equal(res.text, "TLS are described in Figure 2.");
  assert.deepEqual(res.turn, { role: "assistant", content: body.content });
  assert.equal(res.usage.tokens, 20600);
});

test("ask reports a refusal, an empty answer and an answer cut at the length limit", async () => {
  const input = { paper: "Paper text.", history: [], question: "Q?" };
  await assert.rejects(ask(input, OPTS, reply(answer({ stop_reason: "refusal", content: [] }))), /declined/);
  await assert.rejects(ask(input, OPTS, reply(answer({ content: [{ type: "thinking", thinking: "" }] }))), /no answer/);
  const cut = await ask(input, OPTS, reply(answer({ stop_reason: "max_tokens" })));
  assert.match(cut.text, /cut off at the length limit/);
});

test("ask needs a key and a text, and never cuts a text that is too long", async () => {
  const input = { paper: "Paper text.", history: [], question: "Q?" };
  await assert.rejects(ask(input, { ...OPTS, claudeKey: "" }, never), /Claude API key/);
  await assert.rejects(ask({ ...input, paper: "  " }, OPTS, never), /no text to ask about/);
  await assert.rejects(ask({ ...input, paper: "x".repeat(MAX_PAPER_CHARS + 1) }, OPTS, never), /too long/);
});

test("errors name the service and say what to do", async () => {
  const input = { paper: "Paper text.", history: [], question: "Q?" };
  await assert.rejects(ask(input, OPTS, reply({}, 401)), /Claude rejected the API key/);
  await assert.rejects(ask(input, OPTS, reply({}, 429)), /Claude rate limit/);
  await assert.rejects(ask(input, OPTS, reply({}, 529)), /Claude is unavailable/);
  await assert.rejects(translate("text", OPTS, reply({}, 402)), /DeepSeek: the balance is empty/);
  await assert.rejects(translate("text", OPTS, async () => { throw new TypeError("Failed to fetch"); }), /No connection to DeepSeek/);
});

/* ---------- translation (DeepSeek) ---------- */

test("the DeepSeek request goes to the editable address with the model, the key and the target language", () => {
  const { url, init } = buildTranslateRequest("Tertiary lymphoid structures.", OPTS);
  const body = JSON.parse(init.body);
  assert.equal(url, "https://api.deepseek.com/chat/completions");
  assert.equal(init.headers.authorization, "Bearer ds-test");
  assert.equal(body.model, "deepseek-chat");
  assert.match(body.messages[0].content, /into Russian/);
  assert.deepEqual(body.messages[1], { role: "user", content: "Tertiary lymphoid structures." });
});

test("translate returns the translation and reports an empty one", async () => {
  const ok = { choices: [{ message: { content: " Третичные лимфоидные структуры. " } }] };
  assert.deepEqual(await translate("Tertiary lymphoid structures.", OPTS, reply(ok)), { text: "Третичные лимфоидные структуры." });
  await assert.rejects(translate("text", OPTS, reply({ choices: [] })), /no translation/);
});

test("translate sends a long selection whole and refuses one past the limit without using the network", async () => {
  let sent = "";
  const spy = async (url, init) => { sent = JSON.parse(init.body).messages[1].content; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) }; };
  const long = "word ".repeat(1000); // 5000 characters, past the 2000-character note quote
  await translate(long, OPTS, spy);
  assert.equal(sent, long);
  await assert.rejects(translate("x".repeat(MAX_TRANSLATE_CHARS + 1), OPTS, never), /too long to translate/);
  await assert.rejects(translate("text", { ...OPTS, deepseekKey: "" }, never), /DeepSeek API key/);
});

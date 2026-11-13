// One real question to Claude and one real translation by DeepSeek, to check the request formats and the keys.
// The Claude request carries a chrome-extension Origin, as it does from the extension.
// Usage: ANTHROPIC_API_KEY=... DEEPSEEK_API_KEY=... node scripts/assist-smoke.mjs [claude-model]
import { ask, translate, buildAskRequest } from "../extension/assist.js";
import { READER_DEFAULTS } from "../extension/reader-options.js";

const [claudeModel = READER_DEFAULTS.claudeModel] = process.argv.slice(2);
const opts = { ...READER_DEFAULTS, claudeModel, claudeKey: process.env.ANTHROPIC_API_KEY ?? "", deepseekKey: process.env.DEEPSEEK_API_KEY ?? "" };
const PAPER = "Methods. We profiled 12 tumours by multiplex imaging. Results. Tertiary lymphoid structures were found in 7 of 12 tumours (Figure 2).";
const fromExtension = (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin: "chrome-extension://easy-read-smoke" } });

async function check(name, key, run) {
  if (!key) { console.log(`${name}: skipped, no key in the environment`); return; }
  try {
    console.log(`${name}: ok`, JSON.stringify(await run()));
  } catch (e) {
    console.log(`${name}: FAILED: ${e.message}`);
    process.exitCode = 1;
  }
}

await check("Claude", opts.claudeKey, async () => {
  const { text, usage } = await ask({ paper: PAPER, history: [], question: "In how many tumours were TLS found?" }, opts, fromExtension);
  return { model: claudeModel, text, usage };
});
if (opts.claudeKey && process.exitCode) {
  // show the raw error: the plain message hides the reason on purpose
  const { url, init } = buildAskRequest({ paper: PAPER, history: [], question: "Hi" }, opts);
  console.log("Claude raw:", (await (await fromExtension(url, init)).text()).slice(0, 600));
}
await check("DeepSeek", opts.deepseekKey, () => translate("Tertiary lymphoid structures were found in 7 of 12 tumours.", opts));

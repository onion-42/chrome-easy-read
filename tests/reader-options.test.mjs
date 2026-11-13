import { test } from "node:test";
import assert from "node:assert/strict";
import { RATES, READER_DEFAULTS } from "../extension/reader-options.js";

test("speeds run from 0.75x to 10x and keep the usual round values", () => {
  assert.equal(RATES[0], 0.75);
  assert.equal(RATES.at(-1), 10);
  for (const r of [1, 1.5, 2, 3, 5]) assert.ok(RATES.includes(r), `${r}x is missing`);
});

test("the speed slider is log-like: slow speeds change in small steps, fast speeds in big ones", () => {
  const steps = RATES.slice(1).map((r, i) => +(r - RATES[i]).toFixed(2));
  steps.forEach((s, i) => {
    assert.ok(s > 0, `speeds must go up at ${RATES[i]}x`);
    if (i > 0) assert.ok(s >= steps[i - 1], `step shrinks after ${RATES[i]}x`);
  });
  RATES.slice(1).forEach((r, i) => {
    const growth = r / RATES[i];
    assert.ok(growth > 1.03 && growth < 1.2, `${RATES[i]}x -> ${r}x is not a gentle step`);
  });
});

test("the local voice defaults point at this computer and one voice per language", () => {
  assert.equal(new URL(READER_DEFAULTS.localUrl).hostname, "127.0.0.1");
  assert.match(READER_DEFAULTS.localVoiceEn, /^en_/);
  assert.match(READER_DEFAULTS.localVoiceRu, /^ru_/);
});

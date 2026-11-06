import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// easy-read.js has one source of truth: the easy-read skill. The extension ships a copy.
const SKILL = join(process.env.EASY_READ_SKILL || join(homedir(), ".claude", "skills", "easy-read"), "easy-read.js");
const COPY = new URL("../extension/easy-read.js", import.meta.url);

test("the extension's easy-read.js is the skill's file, byte for byte", { skip: !existsSync(SKILL) && "skill not installed" }, () => {
  assert.equal(readFileSync(COPY, "utf8"), readFileSync(SKILL, "utf8"), "run: npm run sync");
});

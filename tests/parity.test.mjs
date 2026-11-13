import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// These files have one source of truth each: a skill. The extension ships copies (npm run sync).
const SKILLS = process.env.CLAUDE_SKILLS || join(homedir(), ".claude", "skills");
const SHARED = [
  [join(process.env.EASY_READ_SKILL || join(SKILLS, "easy-read"), "easy-read.js"), "easy-read.js"],
  [join(SKILLS, "zotero-link", "zotero-api.js"), "zotero-api.js"],
  [join(SKILLS, "zotero-link", "papers.js"), "papers.js"],
];

for (const [skillFile, copy] of SHARED) {
  test(`extension/${copy} is the skill's file, byte for byte`, { skip: !existsSync(skillFile) && "skill not installed" }, () => {
    assert.equal(readFileSync(new URL(`../extension/${copy}`, import.meta.url), "utf8"), readFileSync(skillFile, "utf8"), "run: npm run sync");
  });
}

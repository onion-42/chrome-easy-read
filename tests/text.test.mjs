import { test } from "node:test";
import assert from "node:assert/strict";
import "../extension/text.js";

const { splitCitations, isCitationSup, supSay, toChunks, wordTimings, wordAt } = globalThis.erText;

const spoken = (segs) => segs.map((s) => s.say).join("");
const muted = (segs) => segs.filter((s) => s.say !== s.text).map((s) => s.text);

test("numeric and bracketed citations are not spoken", () => {
  for (const cite of ["[1]", "[1, 2]", "[1–3]", "[12; 15–17]", "[1, с. 25]", "[12, p. 34]", "[3, pp. 1-5]",
    "[Иванов, 2020]", "[Smith et al., 2020]", "[citation needed]", "[note 1]", "[a]"]) {
    const segs = splitCitations(`Response varies widely ${cite}. Next.`);
    assert.deepEqual(muted(segs), [cite], cite);
    assert.equal(spoken(segs), "Response varies widely . Next.", cite);
  }
});

test("author-year citations are not spoken", () => {
  for (const cite of ["(Smith, 2020)", "(Smith et al., 2020; Lee & Kim, 2019)", "(e.g., Smith, 2020)",
    "(Иванов и др., 2020)", "(Smith and Jones 2019)", "(Smith, Jones, and Lee 2019)", "(Smith, 2020a, 2021)",
    "(see Smith et al. 2020)"]) {
    const segs = splitCitations(`Linked to the microbiome ${cite}.`);
    assert.deepEqual(muted(segs), [cite], cite);
  }
});

test("narrative citations keep the authors and drop the year", () => {
  assert.deepEqual(muted(splitCitations("Smith et al. (2020) showed it.")), ["(2020)"]);
  assert.deepEqual(muted(splitCitations("Как показали Иванов и др. (2021), эффект есть.")), ["(2021)"]);
  assert.deepEqual(muted(splitCitations("Smith (2019, 2020) agreed.")), ["(2019, 2020)"]);
});

test("superscript digits are citations after words, but not exponents or units", () => {
  assert.deepEqual(muted(splitCitations("Restored in mice¹². Then more.")), ["¹²"]);
  assert.deepEqual(muted(splitCitations("Doses reached 10⁶ cells.")), []);
  assert.deepEqual(muted(splitCitations("The area in m² is small.")), []);
  assert.deepEqual(muted(splitCitations("An area of 40 metres² here.")), []);
  assert.deepEqual(muted(splitCitations("It equals (a+b)² always.")), []);
});

test("URLs are spoken as their domain, DOIs and footnote marks not at all", () => {
  const segs = splitCitations("Data at https://www.example.org/data/set1. Also doi:10.1038/s41586-020-1234-5 and author*.");
  const url = segs.find((s) => s.text.startsWith("https://"));
  assert.equal(url.text, "https://www.example.org/data/set1");
  assert.equal(url.say, "example.org");
  assert.ok(muted(segs).includes("doi:10.1038/s41586-020-1234-5"));
  assert.ok(muted(segs).includes("*"));
  assert.equal(spoken(segs), "Data at example.org. Also  and author.");
  assert.deepEqual(muted(splitCitations("See https://doi.org/10.1000/xyz123 now.")), ["https://doi.org/10.1000/xyz123"]);
  assert.deepEqual(muted(splitCitations("Smith† and Lee‡ wrote it.")), ["†", "‡"]);
});

test("statistics and ordinary brackets are read", () => {
  for (const text of ["(p < 0.05)", "(n = 34)", "(95% CI 1.2–2.3)",
    "(published in 2020)", "the year (2020)", "[sic]", "p < 0.05 *",
    "(Since 2020)", "(January 2021)", "(Windows 2000)", "(Summer 1945)"]) {
    assert.deepEqual(muted(splitCitations(`It held ${text} here.`)), [], text);
  }
});

test("a bracket holding only figure or table references is not spoken", () => {
  for (const ref of ["(Fig. 2a)", "(Table 1)", "(Supplementary Figure 3)", "(Figure 1B, C)",
    "(Supplementary Fig. S4)", "(Extended Data Fig. 5)", "(Table S2)", "(see Fig. 2)",
    "(Figs. 2 and 3)", "(Fig. 2a; Table 1)", "(Fig. 2a–d)", "(Supplementary Figures 3 and 4)",
    "(Supplementary Table 2)", "(Fig. 1A,B and Supplementary Fig. 2)"]) {
    const segs = splitCitations(`It held ${ref} here.`);
    assert.deepEqual(muted(segs), [ref], ref);
    assert.equal(spoken(segs), "It held  here.", ref);
  }
});

test("a figure reference outside a bracket, or mixed with other text, is read", () => {
  for (const text of ["Fig. 2a shows the result", "(n = 5; Fig. 2a)", "(Figure it out)", "(Table for two)",
    "(as shown in Fig. 2, the effect holds)", "(Fig. 2 shows growth)"]) {
    assert.deepEqual(muted(splitCitations(`It held ${text} here.`)), [], text);
  }
});

test("readFigureRefs keeps figure references spoken", () => {
  const segs = splitCitations("It held (Fig. 2a) here [1].", { readFigureRefs: true });
  assert.deepEqual(muted(segs), ["[1]"]);
  assert.ok(spoken(segs).includes("(Fig. 2a)"));
});

test("a muted figure reference stays in the chunk parts but not in what is said", () => {
  const chunks = toChunks(splitCitations("Growth increased sharply over the whole period (Supplementary Figure 3) in all tumors."), { lang: "en" });
  const parts = chunks.flatMap((c) => c.parts);
  assert.ok(parts.some((p) => p.text === "(Supplementary Figure 3)" && p.say === ""));
  assert.ok(!chunks.map((c) => c.say).join(" ").includes("Figure"));
});

test("readCitations keeps citations spoken but still drops URLs, DOIs and marks", () => {
  const segs = splitCitations("Varies [1, 2] at https://example.org and author*.", { readCitations: true });
  assert.deepEqual(muted(segs), ["https://example.org", "*"]);
  assert.ok(spoken(segs).includes("[1, 2]"));
});

test("isCitationSup tells citations from exponents and units", () => {
  assert.equal(isCitationSup("3", "in mice", false), true);
  assert.equal(isCitationSup("1,2", "et al.", false), true);
  assert.equal(isCitationSup("[12]", "word", false), true);
  assert.equal(isCitationSup("a", "Smith", false), true);
  assert.equal(isCitationSup("6", "reached 10", false), false);
  assert.equal(isCitationSup("2", "area in m", false), false);
  assert.equal(isCitationSup("3", "volume cm", false), false);
  assert.equal(isCitationSup("TM", "Brand", false), false);
  assert.equal(isCitationSup("4", "10", true), true); // links to a reference win
});

test("supSay reads exponents as powers instead of gluing the digits on", () => {
  assert.deepEqual(supSay("6", "reached 10", "en"), { text: "⁶", say: " to the power of 6" });
  assert.deepEqual(supSay("−3", "10", "en-GB"), { text: "⁻³", say: " to the power of −3" });
  assert.deepEqual(supSay("6", "до 10", "ru"), { text: "⁶", say: " в степени 6" });
  assert.deepEqual(supSay("2", "area in m", "en"), { text: "²", say: " 2" });
  assert.deepEqual(supSay("th", "the 5", "en"), { text: "th", say: "th" });
});

test("toChunks splits sentences and keeps muted parts with the sentence they follow", () => {
  const segs = splitCitations("Response varies widely [1, 2]. Fecal transplants restored response in mice¹². Doses reached high levels.");
  const chunks = toChunks(segs, { lang: "en", minChars: 10 });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].say.trim(), "Response varies widely .");
  assert.ok(chunks[0].parts.some((p) => p.text === "[1, 2]" && p.say === ""));
  assert.ok(chunks[1].parts.some((p) => p.text === "¹²"));
  assert.equal(chunks[2].say.trim(), "Doses reached high levels.");
  // parts rebuild the shown text exactly
  assert.equal(chunks.map((c) => c.parts.map((p) => p.text).join("")).join(""),
    segs.map((s) => s.text).join(""));
});

test("toChunks handles Russian and merges very short sentences", () => {
  const ru = toChunks(splitCitations("Первое предложение здесь. Второе предложение тоже."), { lang: "ru", minChars: 5 });
  assert.equal(ru.length, 2);
  const merged = toChunks(splitCitations("Hi. This is a longer sentence here."), { lang: "en", minChars: 10 });
  assert.equal(merged.length, 1);
  assert.equal(toChunks(splitCitations("   "), { lang: "en" }).length, 0);
});

test("wordTimings spread words over the duration and wordAt finds the current word", () => {
  const say = "Doses reached high levels, then fell.";
  const t = wordTimings(say, 3000);
  assert.equal(t.length, 6);
  assert.equal(t[0].t, 0);
  assert.ok(t.every((w, i) => i === 0 || w.t > t[i - 1].t));
  assert.ok(t.at(-1).t < 3000);
  assert.equal(wordAt(t, 0), 0);
  assert.equal(wordAt(t, 2999), say.indexOf("fell"));
  assert.equal(wordAt([], 100), -1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { reflow, drawScale } from "../extension/pdf-text.js";

test("drawScale fits the column and keeps huge pages inside canvas limits", () => {
  assert.equal(drawScale(600, 800, 600, 2), 2);                    // a normal page: column width x DPR
  const tall = drawScale(600, 20000, 600, 2);                      // a long poster strip
  assert.ok(600 * tall <= 8192 && 20000 * tall <= 8192);
  const big = drawScale(5000, 5000, 1200, 3);
  assert.ok(5000 * big * 5000 * big <= 16e6);
});

const W = 612, H = 792;
/* one text item; y grows upwards (PDF space), w defaults to a rough glyph width */
const it = (str, x, y, size = 10, w = str.length * size * 0.5) => ({ str, x, y, w, size });
const page = (items) => ({ width: W, height: H, items });
const texts = (blocks, kind) => blocks.filter((b) => (kind ? b.kind === kind : b.kind !== "page")).map((b) => b.text);

test("lines join with spaces; a larger vertical gap starts a new paragraph", () => {
  const out = reflow([page([
    it("First line of paragraph one", 50, 700), it("continues here", 50, 686), it("and ends.", 50, 672),
    it("Second paragraph starts", 50, 640), it("right here.", 50, 626),
  ])]);
  assert.deepEqual(texts(out, "p"), ["First line of paragraph one continues here and ends.", "Second paragraph starts right here."]);
});

test("items on one line get a space only where there is a gap", () => {
  const out = reflow([page([it("Hello", 50, 700, 10, 25), it("world", 78, 700, 10, 25), it("!", 103, 700, 10, 3)])]);
  assert.deepEqual(texts(out, "p"), ["Hello world!"]);
});

test("hyphenated line ends are joined", () => {
  const out = reflow([page([it("the immuno-", 50, 700), it("therapy works.", 50, 686)])]);
  assert.deepEqual(texts(out, "p"), ["the immunotherapy works."]);
});

test("URLs, DOIs and numbers broken at a line end are joined without a space", () => {
  const out = reflow([page([
    it("See doi:10.1038/s41586-020-", 50, 700), it("1234-5 and https://example.org/data/", 50, 686), it("set1 for details.", 50, 672),
  ])]);
  assert.deepEqual(texts(out, "p"), ["See doi:10.1038/s41586-020-1234-5 and https://example.org/data/set1 for details."]);
});

test("an indented first line starts a paragraph even without a gap", () => {
  const out = reflow([page([
    it("End of the first paragraph.", 50, 700), it("A new paragraph is indented", 62, 686), it("and continues.", 50, 672),
  ])]);
  assert.deepEqual(texts(out, "p"), ["End of the first paragraph.", "A new paragraph is indented and continues."]);
});

test("a clearly larger font becomes a heading", () => {
  const out = reflow([page([
    it("Introduction", 50, 720, 14), it("Body text that is long enough here.", 50, 690), it("More body text follows.", 50, 676),
  ])]);
  assert.deepEqual(texts(out, "h"), ["Introduction"]);
  assert.deepEqual(texts(out, "p"), ["Body text that is long enough here. More body text follows."]);
});

test("two columns: a wide title first, then the left column, then the right", () => {
  const out = reflow([page([
    it("A Wide Title Here", 100, 740, 16, 412),
    it("Left column first line", 50, 700, 10, 230), it("Right column starts here", 330, 700, 10, 230),
    it("ends with a period.", 50, 686, 10, 200), it("and ends too.", 330, 686, 10, 150),
  ])]);
  assert.deepEqual(texts(out), ["A Wide Title Here", "Left column first line ends with a period.", "Right column starts here and ends too."]);
});

test("a sentence broken across columns becomes one paragraph", () => {
  const out = reflow([page([
    it("Several cohorts link it to the gut", 50, 700, 10, 230), it("microbiome in mice.", 330, 700, 10, 180),
    it("Earlier work.", 50, 714, 10, 100), it("More on the right.", 330, 686, 10, 150),
  ])]);
  assert.ok(texts(out, "p").includes("Earlier work. Several cohorts link it to the gut microbiome in mice. More on the right."));
});

test("running headers, footers and page numbers repeated on most pages are dropped", () => {
  const pages = [1, 2, 3].map((n) => page([
    it("Journal of Tests 2026", 200, 770, 9), it(`Body text on page ${n}.`, 50, 600), it(String(n), 300, 30, 9),
  ]));
  const out = reflow(pages);
  assert.deepEqual(out.filter((b) => b.kind === "page").map((b) => b.page), [1, 2, 3]);
  assert.deepEqual(texts(out, "p"), ["Body text on page 1.", "Body text on page 2.", "Body text on page 3."]);
});

test("a header on one page only is kept", () => {
  const out = reflow([page([it("Only once at the top", 200, 770, 9), it("Body.", 50, 600)]), page([it("Other body.", 50, 600)])]);
  assert.ok(texts(out).includes("Only once at the top"));
});

test("line numbers in the margins (bioRxiv) are dropped", () => {
  const out = reflow([page([it("12", 20, 700), it("Real text line.", 72, 700), it("13", 590, 686), it("Next line.", 72, 686)])]);
  assert.deepEqual(texts(out, "p"), ["Real text line. Next line."]);
});

test("a page without text gives only its marker", () => {
  assert.deepEqual(reflow([page([])]), [{ kind: "page", page: 1 }]);
});

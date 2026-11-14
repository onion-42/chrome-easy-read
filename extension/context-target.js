// Remembers the element under the last right-click, so "Read aloud from here" knows where "here" is.
document.addEventListener("contextmenu", (e) => { window.__erContextTarget = e.target; }, true);
// Remembers the last left-clicked word, so reading aloud can start (or jump) there.
document.addEventListener("click", (e) => {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(e.clientX, e.clientY) : null;
  const range = !pos && document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
  const node = pos ? pos.offsetNode : range && range.startContainer, offset = pos ? pos.offset : range ? range.startOffset : 0;
  // kept as text, not as a node: easy-read rebuilds the text nodes when it switches on
  let chars = 0, word = "";
  if (node && e.target.contains(node)) {
    const before = document.createRange();
    before.setStart(e.target, 0); before.setEnd(node, offset);
    chars = before.toString().replace(/\s+/g, " ").length;
    const text = node.nodeValue || "";
    for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu)) if (m.index <= offset && offset <= m.index + m[0].length) word = m[0];
  }
  window.__erClick = { target: e.target, chars, word };
}, true);

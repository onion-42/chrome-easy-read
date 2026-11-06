// Remembers the element under the last right-click, so "Read aloud from here" knows where "here" is.
document.addEventListener("contextmenu", (e) => { window.__erContextTarget = e.target; }, true);

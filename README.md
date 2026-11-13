# easy-read for Chrome

Reading comfort per site, plus reading aloud with subtitles that look the same as your text.

- **easy-read on any site:** dyslexia-friendly font (OpenDyslexic), text size, line and letter spacing,
  calm colours, colour-vision filter (red-green / blue-yellow), bold word starts, focus highlight.
- **Read aloud:** a natural Gemini voice, a local neural voice (Piper, offline) or the free built-in voice
  reads from the paragraph you choose.
  A subtitle bar shows the current sentence and marks the spoken word, in your easy-read style.
- **Citations are not read:** `[1, 2]`, `(Smith et al., 2020)`, superscript refs, DOIs and footnote marks are
  skipped by the voice and shown small and faded. URLs are read as their domain.
- **PDFs too:** a PDF opens as easy-read text (paragraphs, headings, two columns put in order, running headers and
  line numbers removed), with reading aloud. "Show page" draws the real page for figures and tables;
  "Clean up with Gemini" rebuilds messy or scanned PDFs.

Comfort and choice, not a treatment: studies of dyslexia fonts found no reliable gain in reading speed.

## Install (2 minutes)

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and choose the **`extension`** folder of this repo.
3. Pin the "Aa" icon (puzzle icon in the toolbar → pin).
4. For the Gemini voice: right-click the icon → **Options** → paste your API key → **Test voice**.

### Local neural voice (optional, offline)

A natural voice that runs on this computer's processor (no graphics card needed). The text never leaves the machine.
It uses [Piper](https://github.com/OHF-Voice/piper1-gpl), a small speech server on `127.0.0.1`.

1. Install [uv](https://docs.astral.sh/uv/) if you do not have it.
2. Run `bash scripts/local-voice.sh`. It downloads one English and one Russian voice (about 60 MB each) into
   `~/.local/share/piper-voices` and starts the server as a systemd user service that comes up at login.
3. In **Options** choose **Local neural voice** → **Test voice**.

| Task | Command |
|---|---|
| Is it running? | `systemctl --user status easy-read-voice` |
| Start / stop | `systemctl --user start easy-read-voice` / `systemctl --user stop easy-read-voice` |
| Remove | `systemctl --user disable --now easy-read-voice`, then delete `~/.config/systemd/user/easy-read-voice.service` |
| Another voice | `uvx --from 'piper-tts[http]' python -m piper.download_voices <name> --data-dir ~/.local/share/piper-voices`, then put the name in Options |

macOS and Windows have no systemd. Download the voices with the command in the last row, then start the server by hand:
`uvx --from 'piper-tts[http]' python -m piper.http_server -m en_US-lessac-medium --data-dir ~/.local/share/piper-voices --host 127.0.0.1 --port 5005`.

## Use

| Action | How |
|---|---|
| easy-read on / off for this site | click the "Aa" icon, or **Alt+Shift+E** (badge shows `ON`) |
| Change the look | the **Aa** button bottom-left on the page |
| Read aloud from a paragraph | right-click it → **Read aloud from here** |
| Read aloud / pause / resume | **Alt+Shift+R**, or the 🔊 button next to Aa |
| Pause / resume while reading | **Space** (stops on the current word; resume continues from it) |
| Start from a selection | select text, then Alt+Shift+R or 🔊 |
| Voice, speed, citations, work sites | extension **Options** |
| Open a PDF as easy-read text | on the PDF: click the "Aa" icon (badge `PDF` on remembered sites); click again → back |
| Open a PDF link as easy-read text | right-click the link → **Open PDF in easy-read** |
| A PDF from your computer | in the viewer: **Open a PDF…**, or drag the file in (or allow file URLs, below) |
| See figures / tables of a page | the **Show page** button at each page marker |
| Messy or scanned PDF | **Clean up with Gemini** in the viewer header (kept for the last 10 PDFs) |

Local PDFs opened from disk (`file://`) need **Allow access to file URLs** on the extension's details page
in `chrome://extensions`; "Open a PDF…" works without it.

The site is remembered: next visit, easy-read turns on by itself. Reading aloud on a site that is off turns
easy-read on for that tab only. Shortcuts can be changed at `chrome://extensions/shortcuts`.

## Notes, Zotero and the reading list

One paper is one Zotero item. easy-read saves papers and notes to Zotero; the Obsidian vault gets them through
the plan-browser extension (or `node ~/.claude/skills/zotero-link/cli.mjs sync`).

Set up once in the options page, section **Zotero**: paste the API key (zotero.org/settings/keys, rights
library + notes + write), press «Проверить», pick the collection (default `Reading list`), and choose the vault
folder for PDFs.

| Action | How |
|---|---|
| Note on selected text | select text, **Alt+Shift+N** (or 📝, or right-click → «Заметка к выделению») → comment → **Ctrl+Enter** |
| Save the paper without a note | right-click → «Сохранить статью в Zotero», or the button in the panel |
| Edit a note | ✎ in the list; if the note changed in Zotero meanwhile, both texts are shown and yours stays in the field |
| Summary of the whole paper | «Вывод по статье»: one per paper, first in the list (Zotero tag `summary`) |
| See earlier notes | quotes are highlighted in the text; click a highlight to open its note |
| Reading list | **Alt+Shift+L**, or the link in the viewer / options |
| Keep the PDF | in the PDF viewer the file is written to `0_media/papers/<slug>.pdf` of the vault once the paper is known; on an article page press «Сохранить PDF» |
| Your own PDF (e.g. from the author) | reading list → «Прикрепить PDF…» (or drop the file on the row); or open the file in the viewer → 📝 → «Привязать к статье…» |

Works on PDFs (viewer) and on HTML article pages. A page is recognised by `citation_doi` / `citation_pmid`
meta tags, a DOI in the address, or a PubMed address; a PDF by its content hash, a DOI on its first page, or its
address. A page with none of these is saved as a web page item.

## Privacy

- Settings (look) sync through your Chrome profile. The Gemini API key stays in this Chrome only.
- With the Gemini voice, the text being read is sent to Google. Sites listed under
  **"Built-in voice only"** in Options (empty by default; add a work wiki, mail, etc.) always use the built-in voice.
- The built-in voice works offline; nothing leaves the computer.
- The local neural voice sends the text only to the Piper server on `127.0.0.1`, so it also reads the
  "Built-in voice only" sites.
- PDFs are read on this computer. Only **Clean up with Gemini** sends the whole PDF to Google (model
  `gemini-3.8-flash`, about a few cents per paper); it is switched off for the "Built-in voice only" sites.

## Develop

```bash
npm install && npx playwright install chromium
npm test            # unit tests (node --test)
npm run e2e         # Chromium with the extension loaded (Playwright)
npm run sync        # copy easy-read.js from the easy-read skill after it changes
npm run icons       # re-render the toolbar icons
node scripts/fetch-fonts.mjs     # re-download OpenDyslexic (SIL OFL)
node scripts/gemini-smoke.mjs    # one real Gemini request; needs GEMINI_API_KEY in your terminal
npm run vendor      # copy PDF.js (pinned pdfjs-dist) into extension/vendor/pdfjs
npm run test-pdf    # re-print tests/e2e/pages/paper.pdf from paper.html
node scripts/pdf-to-text.mjs some.pdf   # print how the viewer re-flows a PDF
```

`extension/easy-read.js` is a copy. Its source of truth is `~/.claude/skills/easy-read/easy-read.js`;
`tests/parity.test.mjs` fails when the two differ.

### How it fits together

```
background.js   service worker: per-site toggle, injection, badge, voice routing, context menu, shortcuts
easy-read.js    the reading-comfort layer (from the skill) + public API: setEnabled, getState, onChange, emphasize
text.js         pure: citation filter, sentence chunks (Intl.Segmenter), word-time estimate
reader.js       in the page: start point, paragraph highlight, subtitle bar, controls
tts/gemini.js   Gemini TTS request (24 kHz PCM) with plain-language errors
tts/local.js    local Piper server request (WAV -> PCM) with plain-language errors
tts/builtin.js  chrome.tts voices with word events
offscreen.js    plays Gemini and local audio outside the page (no page CSP, speed keeps the pitch)
options.*       voice settings
viewer.*        the PDF viewer: PDF.js text -> easy-read page, "Show page", Gemini clean-up
pdf-text.js     pure: PDF text items -> paragraphs / headings (columns, hyphens, running headers, line numbers)
pdf-clean.js    Gemini clean-up request + Markdown -> plain blocks
gemini-api.js   shared Gemini REST helper (request, plain-language errors, reading the model's output)
host.js         hands easy-read its profile in a page (websites and the viewer)
vendor/pdfjs/   PDF.js 6.4.299 (Apache-2.0), copied by `npm run vendor`
```

## Known limits

- Notes: a quote taken in the HTML version may not be highlighted in the PDF version of the same paper (and the
  reverse), and not after a Gemini clean-up: the text differs. The note itself is always in the list.
- Notes with images, tables or Zotero's own highlights cannot be edited here.
- A PDF of 95 MB or more is not written to the vault (GitHub rejects files of 100 MB).
- After a Chrome restart the vault folder needs one click to confirm access; notes are saved to Zotero regardless.
- Deleting a note is done in Zotero.

- Gemini and the local voice return no word timings, so the marked word is an estimate; the sentence is exact.
- Pause stops on the marked word; resume and a new speed continue from that word. The built-in voice gets
  the rest of the sentence (word-exact); Gemini replays the same audio from the word's estimated start, so it
  can begin a fraction of a second early or late. A built-in voice that reports no words resumes from the
  start of the sentence. Space does nothing special while you type in a field or a button has focus.
- Speed is a slider from 0.75× to 10× on a log-like scale of round values: small steps at slow speeds
  (+0.05 up to 1.1×), bigger ones at fast speeds (+1 from 6× to 10×). The Gemini voice prepares about
  2 sentences ahead per 1× of speed (2 at 1×, 6 at 3×, at most 8); if Gemini answers slower than you listen,
  short gaps between sentences can still appear. At high speeds every sentence is one Gemini request, so the
  free-tier rate limit comes sooner. Some built-in (OS) voices have their own top speed and may not reach 10×.
- Citation filter trade-offs: one-author citations need a comma to be skipped — `(Smith, 2020)` is skipped,
  comma-less `(Smith 2020)` is read, so `(Since 2020)` is never lost. A year in brackets after a capitalised
  word, `Paris (2019)`, is treated like `Smith (2019)` and skipped.
- Very long pages (book length) pause for a moment when reading starts: all paragraphs are prepared up front.
- Text inside iframes (embedded viewers) is neither restyled nor read.
- PDF text view: a real hyphen at a line end ("short-" / "chain") cannot be told from a split word and is
  dropped; unusual layouts (three columns, side boxes, tables) can come out in a wrong order; equations come out
  as broken symbols. "Clean up with Gemini" fixes most of this. Scanned PDFs have no text without Gemini.
- A very long PDF (a whole book) is read completely before the text appears ("Reading page N of M…").
- Text added to the page later (feeds, single-page apps) gets bold word starts after an off/on.
- Settings changed in one tab reach other open tabs on their next reload.
- Chrome's own pages, the Web Store and the PDF viewer cannot be changed by extensions (badge shows `–`).

Fonts: OpenDyslexic, SIL Open Font License (`extension/fonts/OFL.txt`). Code: MIT.

# Audits

## October 2026: Noteshack as released

An audit of the app as it now stands: the word processor, the PDF editor and
the scan reader.

### Checked and fine

- **Privacy.** The only outside site the app contacts is `cdn.jsdelivr.net`,
  for fonts. Documents, PDFs and scans never leave the browser.
- No errors in the console. No sideways scrolling at 320, 390 or 768 px.
  Reloading with the network off works.

### Fixed

| # | Finding | Fixed by |
|---|---|---|
| 1 | **Undo copied the whole document for every step.** For a converted 700-page scan that came to about 12 MB a step, up to 150 steps. | A step now shares everything that did not change with the step before it, so it costs about as much as the edit. |
| 2 | **Each app update deleted the cached libraries** (PDF.js, pdf-lib, Tesseract and its language data), so they were downloaded again after every update. | They have a cache of their own, which updates leave alone. |
| 3 | **Every save of a PDF wrote the original file again**: several MB each time, for an edit of a few bytes. | The original file is stored once, apart from the edits, and written again only when pages from another PDF are added. |
| 4 | Accessibility: the name and date of the open document were too faint on the highlighted row; the page had no main heading; the toolbars were outside any landmark; and the scrolling areas could not be reached with the keyboard. | All four fixed. |
| 5 | The page description for search engines still described only the word processor. | It now covers PDFs and scans. |
| 6 | An unused function in `app.js`. | Removed. |

### Left for later

- A Content Security Policy, as a second line of defense behind the
  sanitizer.
- Moving to a newer PDF.js. 3.11 is still sound with script evaluation turned
  off, which it is, but it no longer receives fixes.
- ~~Automated tests in the repository.~~ Done: `npm test`, run by GitHub on
  every push.

## The original Notepad Online

This is an audit of the first version (one `index.html`, `app.js` and
`styles.css`, about 300 lines of script), and what the rebuild does about
each finding. They are grouped by how much they could hurt you.

### Could lose or corrupt your writing

| # | Finding | Fixed by |
|---|---|---|
| 1 | **Everything was stored in `localStorage`, which holds about 5 MB.** Images were saved inline as base64, so a few photos filled it. After that, every save threw an error that nothing caught: the status stayed on "Typing…" while nothing was being saved. | Documents now live in IndexedDB (hundreds of MB). Photos are scaled down when inserted. A failed save shows **Not saved** in red and explains why. The app also asks the browser to keep its storage rather than clear it when space runs low. |
| 2 | **Find and Replace edited the raw HTML.** Searching for `td`, `class`, `span` or `b` rewrote the tags themselves and could break tables and formatting. The search text was used as a regular expression, so `?`, `(` or `.` either crashed it or matched the wrong things. | Find and replace now works on the visible text only, never the markup. Special characters are matched literally (regex is an opt-in checkbox). Matches are highlighted, with a count, previous/next, and match-case and whole-word options. **Replace all** can be undone, and saves a restore point first. |
| 3 | **Turning spell check on or off reloaded the whole document** (`innerHTML = innerHTML`). That wiped the undo history and moved the cursor to the top. | Spell check is now a plain on/off setting. |
| 4 | **One document only.** "Clear Session" deleted it for good, and starting something new meant destroying the old one. | Any number of documents, with a searchable sidebar, plus Make a copy and Delete (which asks first). |
| 5 | **No undo past the browser's own, no history.** | Version history: a restore point every 10 minutes while you write, on Ctrl+S, and before any big change. Preview any version and restore it, and undo the restore. |
| 6 | **No backup.** The only copy was in one browser profile. | **Back up all documents** saves one file, and **Restore from backup** loads it on any computer. |

### Security

| # | Finding | Fixed by |
|---|---|---|
| 7 | Pasted HTML went in unfiltered and was saved, then reloaded with `innerHTML`. Content like `<img onerror=…>` copied from a web page ran as script every time the page opened. | Everything entering the document (paste, opened files, saved copies, the old draft) passes through an allow-list sanitizer. Scripts, event handlers, `javascript:` links and unknown tags are removed. |
| 8 | Inline `onclick=` handlers throughout the HTML, calling global functions. | All behavior is attached from the script files, and the app's code no longer leaks into the page's global scope. |

### Broken or misleading features

| # | Finding |
|---|---|
| 9 | **Font and size changed the whole document**, not the selected text, and neither was saved or exported. Now they apply to the selection, like any word processor, and each document also has its own default font, size, line spacing, paper size and margins (Page setup). |
| 10 | "Letter Page A4 Layout" mixed up two paper sizes and did not affect printing. Page layout now shows the real paper size and margins, and Letter or A4 plus the margins carry through to print, PDF and Word. |
| 11 | The Markdown preview's patterns were greedy (`**a** and **b**` bolded everything between), lists broke, and it previewed a rich-text document as if it were Markdown. It is replaced by **Markdown shortcuts** while typing (`#`, `-`, `1.`, `[ ]`, `>`, ```` ``` ````, `---`) plus real Markdown open and export. |
| 12 | Saved `.html` files had no `<meta charset>`, so accented letters and emoji could show as garbage. Exports are now complete pages with styles. |
| 13 | The download link was revoked immediately after the click, which cancels the download in some browsers. |
| 14 | Dark mode was not remembered, and the default text color (#333) became invisible text in dark mode. The theme is remembered (Light, Dark or Match my device), and text with no chosen color follows the theme. |
| 15 | The word goal was saved on every keystroke and shared by all documents. Goals are now per document. |
| 16 | Read aloud had no Stop and always read the whole document. It now reads the selection (or everything, highlighting each word as it goes), can be stopped, and lets you pick the voice and speed. |
| 17 | Menus opened only on mouse hover: unusable on phones and tablets, and invisible to the keyboard. Menus now open on click or tap and work with the arrow keys and Esc. |
| 18 | Tables were stuck at the size you inserted them. You can now add and delete rows and columns, turn the header row on or off, and Tab between cells. Images can be resized, centered or wrapped, and given alt text. |
| 19 | The editor was a fixed 550 px tall box inside the page, with nothing for small screens. It now fills the window and has a proper phone layout. |
| 20 | Browser `confirm()`/`prompt()`/`alert()` dialogs. These are replaced with in-app dialogs. |

### Missing for a word processor

These are now included: headings and paragraph styles; bulleted, numbered and
check lists; alignment and indent; links; superscript and subscript; inline
code and code blocks; quotes; horizontal lines and page breaks; special
characters; today's date; clear formatting; full keyboard shortcuts (Ctrl+/
lists them); **open and save Word `.docx`**; PDF through print; Markdown;
plain text; word-count details and reading time; selection word count; focus
mode; zoom; works offline and installs as an app.

### What it still cannot do

Being honest about the limits of a browser-only editor:

- **No real page-by-page layout.** Page view shows the paper width and
  margins, and the status bar estimates the page count. Exact page breaks are
  only decided when you print, or in Word.
- **Word import covers the everyday parts** (headings, bold, italic,
  underline, colors, highlights, lists, tables, links, images, alignment).
  Text boxes, comments, tracked changes, footnotes, headers and footers are
  skipped. Old `.doc` files are not supported. Save them as `.docx` first.
- **No live collaboration or cloud sync.** Documents stay in the browser they
  were written in. Use Back up to move them.
- The editing engine is the browser's own (`execCommand`). It is deprecated
  in name but supported in every current browser, and is what lets Undo work
  across every action.

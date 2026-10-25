# Noteshack

A fast, private word processor and PDF editor that runs entirely in your
browser. No account, no server, no tracking. Your documents stay on your
device. It saves as you type, works offline, opens and saves Word documents,
and lets you edit and sign PDFs.

## Features

**Writing**
- Headings, quotes, code blocks, bulleted, numbered and **check** lists
- Bold, italic, underline, strikethrough, superscript, subscript, inline code
- Any font size and font for selected text, a text color and highlight palette
- Alignment, indent, links, horizontal lines, page breaks, special characters
- Tables: insert from a size grid, add or delete rows and columns, header row, Tab between cells
- Images: insert, paste or drag in; resize by dragging or by preset; center or wrap text; alt text
- **Markdown shortcuts** while you type: `#` heading, `-` bullet, `1.` numbers, `[ ]` checklist, `>` quote, ```` ``` ```` code, `---` line

**Documents**
- Unlimited documents, with a searchable sidebar
- Autosave plus **version history**: browse earlier versions and restore any of them
- **Open** `.docx`, `.md`, `.html` and `.txt`, by menu or by dropping files on the window
- **Download** as Word (`.docx`), PDF, Markdown, web page or plain text
- Page setup per document: font, size, line spacing, Letter or A4, margins
- Back up every document to one file and restore it anywhere

**PDFs**
- Open any PDF (menu, or drop it on the window). It goes in your documents list like everything else.
- **Edit text**: click any line of the PDF's own text and retype it. Only the words you change are replaced; the rest of the line is left exactly as it was.
- **The original font**: the app works out which font the words were set in (from the font's name in the PDF, or, on a scan, by comparing the letters with 31 common document fonts) and downloads it, so new words match. Paid fonts like Arial, Times New Roman and Calibri are matched with free fonts drawn to the same shapes and widths (Arimo, Tinos, Carlito).
- Add text, highlight, white-out, draw, boxes, images, and your **signature** (drawn once, remembered if you like)
- Fill in PDF forms: text boxes, checkboxes, dropdowns and radio buttons
- **Scanned pages become editable text (OCR)**: with Edit text, click a scanned page and the app reads that page (a few seconds; the line you clicked then opens for editing), takes the scanned words off it, and draws every line again as real text in the matched font, size, weight (bold and italic words included) and color, where it was on the page. Edits are then ordinary text edits that match the lines around them, and the downloaded PDF can be searched and copied from. This works the same way on pages whose letters were saved as drawn shapes.
  - A page scanned sideways or upside down is turned the right way up first, and one that went through the scanner crooked is straightened, so lines read cleanly and the new text sits level.
  - Headings set in small caps stay in small caps.
  - **The scan's own letters** (like Acrobat's ClearScan): every copy of a letter on the page is cut out, averaged to take away the scan's noise, traced into a smooth outline and built into a font, so redrawn text, and anything you type, has the scanned letters' own shapes. Letters the page does not show come from the matched font. Pages → Use the scan's own letters, or the matched fonts switches between the two. These fonts are modified copies of free (Open Font License) fonts, so they go by their own names (Noteshack Scan 1, 2…) and keep the original license notice, as that license asks.
  - Every word of a line is redrawn together, so a line looks of a piece; words OCR was unsure of are underlined to check.
  - **Paragraphs rewrap**: click any line of a paragraph and the whole paragraph opens for editing; when you finish, the text flows again from your change (bold and italic words keep their style), lines before it stay as they were, and a paragraph that needs another line gets one below.
  - **Handwriting is left alone**: writing OCR reads unsurely, and marks like check boxes, stay exactly as scanned and are never retyped. If a line was retyped that should not have been, select it and click **Show as scanned**. To clear a filled-in form, drag a box over the writing with Edit text: only the pen strokes go, the form's fill-in lines, printed slashes and printed text stay, and selecting the erased area shows each piece, to click to keep or erase. White-out clears everything in an area.
  - **Fixing a misread**: words OCR may have got wrong are underlined in orange. Right-click any word read from the scan for a menu with the scanned word enlarged, what was read, and Correct this word (type the correction; Tab goes on to the next doubtful word), plus Edit text and Copy. A left click always just edits. A correction is redrawn in place, and searching and copying use it.
  - **Original** (toolbar) shows the page as it was scanned, to check what was read: every word is clickable to correct it, and words OCR was unsure of are shaded.
  - **Pages → Keep this page as scanned** puts the scan back; Edit text then changes single words and leaves the rest of the scan exactly as it was.
  - **Read whole document** (a switch in the toolbar, off by default; hover its ⓘ for details) reads every scanned page in the background instead, several pages at a time, so a long document becomes editable and searchable without clicking each page. A page you click goes first; turning it off pauses, and it carries on where it stopped next time the document is opened.
  - Reading is quick first and careful where it needs to be: a fast reader reads each page, and the lines it was unsure of are read again by the accurate one. Words read surely anywhere in the document are remembered, and a word read unsurely that is one letter away from one of them (seen at least twice) is corrected to it.
  - English only for now; needs the app opened from its web address, not from a file on disk.
- Pages: rotate, delete, reorder, insert blank pages, and add pages from other PDFs
- Undo and redo for everything; your changes are saved as you go
- **Download** a new PDF with your changes. The original file is never touched.
- **Print** shows a preview of exactly what will print (your changes included), then prints straight from it; Download and Open in a new tab are there too.

What PDF editing cannot do, so nothing surprises you:
- Text you change or white-out is **erased from the file** when you download, not just covered, and the rest of the line stays exactly where it was. That includes scanned pages and other pictures: the covered pixels are painted over inside the image itself. Only drawings (lines and shapes) under a white-out stay in the file, hidden. The app tells you when that happens.
- A color scan you have erased part of is saved again as JPEG, so that page's file size can roughly double. Black-and-white scans stay small.
- OCR can misread faint, tiny or handwritten text. Check what it read (the Original button) before relying on it.
- Redrawing a scanned page needs its fonts. Offline, the page stays as scanned and Edit text changes single words instead; choose Pages → Make this page's text editable when you are back online.
- Font matching needs an internet connection the first time a font is used (font files come from the free Fontsource library through jsDelivr; nothing from your document is sent). Offline, or for a font it cannot find, the closest standard font is used.
- A scan's font is matched to the closest of the common fonts the app knows. An unusual or custom typeface will be matched to something similar, not identical.
- Password-protected PDFs cannot be changed.

**Tools**
- Find and replace with highlighting, match case, whole words and regex
- Word count details, reading time, selection count, and a word goal with a progress bar
- Read aloud with word highlighting, a choice of voice and speed
- Spell check toggle, focus mode, zoom, light and dark themes
- Full keyboard shortcuts (press **Ctrl+/** to see them all)
- Works on phones and tablets, works offline, installable as an app

## Where your writing is kept

Documents are stored in your browser's IndexedDB on this device. They are
never uploaded. Clearing your browser's site data deletes them, and they
don't follow you to other browsers or computers. Use **File → Back up all
documents** to keep a copy, or to move them.

Upgrading from the first version? Your old draft is moved into the
documents list automatically the first time you open the new version.

## Privacy

There is no account, no analytics, no ads and no cookies, and documents are
never uploaded. Two things are fetched from the internet:

- **Font files.** When a PDF needs a font, it is downloaded from the free
  [Fontsource](https://fontsource.org) library through jsDelivr
  (`cdn.jsdelivr.net`). Like any website, jsDelivr sees the visitor's IP
  address; nothing from the document is sent.
- **Linked pictures.** A picture in a document that links to a web address
  (for example, pasted from a web page) is loaded from that address.

Everything else, text recognition included, runs on the device.

## Disclaimer

Noteshack is provided as is, without warranty of any kind. Text
recognition and font matching can be wrong: check a PDF before sending,
submitting or signing it, and keep backups of anything important.

Users are responsible for the documents they change. Do not alter a document
in a way that misleads anyone, such as a form or record someone else filled
in or signed.

## License

Noteshack's own code is released under the [MIT License](LICENSE).
The libraries in `vendor/` keep their own licenses, listed below.

## Credits and licenses

Noteshack uses these open-source projects, kept unmodified in `vendor/`
with their license texts:

- [PDF.js](https://mozilla.github.io/pdf.js/) (Mozilla), Apache License 2.0
- [pdf-lib](https://pdf-lib.js.org) and @pdf-lib/fontkit, MIT License
- [Tesseract.js](https://tesseract.projectnaptha.com), Tesseract OCR and its
  English data, Apache License 2.0
- [opentype.js](https://opentype.js.org), MIT License

Fonts come from [Fontsource](https://fontsource.org) when needed and are
not stored in this repository; each is under its own free license (SIL Open
Font License or Apache License 2.0). Fonts made from a scan's letters are
changed copies of those fonts, so they are renamed (Noteshack Scan 1, 2…) and
keep their license notices, as the Open Font License asks.

## Trademarks

Adobe, Acrobat and ClearScan are trademarks of Adobe. Microsoft, Word and
Calibri are trademarks of Microsoft. Arial and Times New Roman are trademarks
of The Monotype Corporation. They are named only to describe compatibility;
Noteshack is not affiliated with or endorsed by them.

## Running it

It is a static site with no build step and no dependencies.

- **Locally:** open `index.html` in a browser. Offline install needs it
  served over http(s), for example `python3 -m http.server`.
- **GitHub Pages:** Settings → Pages → Deploy from a branch → `main`, root folder.
  The live site is <https://noteshack.org>, set by the `CNAME` file and the
  domain's DNS records (four A records and four AAAA records for GitHub Pages,
  and a `www` CNAME to `bobothehutt.github.io`).

Each web address keeps its own saved documents, so after moving the site to
a new address, open the old one, use **File → Back up all documents**, and
restore that file at the new address.

## Files

```
index.html             page structure, menus and toolbar
styles.css             all styling: light and dark themes, phone layout, print
js/app.js              the editor and the rest of the app
js/store.js            document storage (IndexedDB)
js/sanitize.js         cleans pasted and opened content
js/markdown.js         Markdown import and export
js/docx.js             Word .docx import and export
js/zip.js              the zip reading and writing .docx needs
js/pdf.js              the PDF editor
js/fonts.js            identifies and downloads the font a PDF was set in
js/scanfont.js         builds a font from a scan's own letters
vendor/                PDF.js (shows pages), pdf-lib (writes PDFs), Tesseract (reads scans) and opentype.js (builds fonts from scans), with their licenses; loaded only when needed
js/icons.js            toolbar icons
sw.js                  offline support
manifest.webmanifest   app install details
AUDIT.md               what was wrong with the first version, and what changed
LICENSE                the MIT License, for this project's own code
```

After changing any file, bump `CACHE` in `sw.js` so installed copies pick up
the update.

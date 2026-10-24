# Notepad Online

A fast, private word processor and PDF editor that runs entirely in your
browser. No account, no server, no tracking. What you write stays on your
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
- **Edit text**: click any line of the PDF's own text and retype it. The new text matches the original's color and size, in the closest standard font.
- Add text, highlight, white-out, draw, boxes, images, and your **signature** (drawn once, remembered if you like)
- Fill in PDF forms: text boxes, checkboxes, dropdowns and radio buttons
- Pages: rotate, delete, reorder, insert blank pages, and add pages from other PDFs
- Undo and redo for everything; your changes are saved as you go
- **Download** a new PDF with your changes. The original file is never touched.

What PDF editing cannot do, so nothing surprises you:
- Changed or whited-out text is **covered, not erased**. The old words are still inside the file and can be copied out, so do not use this to hide private information.
- Replacement text uses standard PDF fonts (Helvetica, Times, Courier), so it can look slightly different from the original font. Characters outside Western European alphabets cannot be written yet.
- Scanned pages are pictures, so their words cannot be edited (but you can white-out and type over them).
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

## Running it

It is a static site with no build step and no dependencies.

- **Locally:** open `index.html` in a browser. Offline install needs it
  served over http(s), for example `python3 -m http.server`.
- **GitHub Pages:** Settings → Pages → Deploy from a branch → `main`, root folder.
  It will be live at `https://<your-username>.github.io/Notepad-Online/`.

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
vendor/                PDF.js (shows pages) and pdf-lib (writes PDFs), loaded only for PDFs
js/icons.js            toolbar icons
sw.js                  offline support
manifest.webmanifest   app install details
AUDIT.md               what was wrong with the first version, and what changed
```

After changing any file, bump `CACHE` in `sw.js` so installed copies pick up
the update.

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
- **Edit text**: click any line of the PDF's own text and retype it. Only the words you change are replaced; the rest of the line is left exactly as it was.
- **The original font**: the app works out which font the words were set in (from the font's name in the PDF, or, on a scan, by comparing the letters with 31 common document fonts) and downloads it, so new words match. Paid fonts like Arial, Times New Roman and Calibri are matched with free fonts drawn to the same shapes and widths (Arimo, Tinos, Carlito).
- Add text, highlight, white-out, draw, boxes, images, and your **signature** (drawn once, remembered if you like)
- Fill in PDF forms: text boxes, checkboxes, dropdowns and radio buttons
- **Scanned pages become editable text (OCR)**: click Read text and the app reads the page, takes the scanned words off it, and draws every line again as real text in the matched font, size, weight (bold and italic words included) and color, where it was on the page. Edits are then ordinary text edits that match the lines around them, and the downloaded PDF can be searched and copied from. This works the same way on pages whose letters were saved as drawn shapes.
  - A page scanned sideways or upside down is turned the right way up first, and one that went through the scanner crooked is straightened, so lines read cleanly and the new text sits level.
  - Headings set in small caps stay in small caps.
  - Every word of a line is redrawn together, so a line looks of a piece; words OCR was unsure of are underlined to check.
  - **Paragraphs rewrap**: click any line of a paragraph and the whole paragraph opens for editing; when you finish, the text flows again from your change (bold and italic words keep their style), lines before it stay as they were, and a paragraph that needs another line gets one below.
  - **Handwriting is left alone**: writing OCR reads unsurely, and marks like check boxes, stay exactly as scanned. To clear a filled-in form, click a piece of handwriting with Edit text and choose Erase handwriting, use Pages → Erase handwriting on this page, or drag a box around writing the app did not find. Only the pen strokes go: the form's fill-in lines, printed slashes and printed text stay, and selecting erased handwriting shows each piece, to click to keep or erase. The paper (or the dotted shading of a black-and-white scan) is filled in behind it.
  - **Fixing a misread**: words OCR may have got wrong are underlined in orange; click one to see the scanned word enlarged next to what was read, and type the correction (Tab goes on to the next one). Right-click any word read from the scan to do the same. A correction is redrawn in place, and searching and copying use it.
  - **Original** (toolbar) shows the page as it was scanned, to check what was read: every word is clickable to correct it, and words OCR was unsure of are shaded.
  - **Pages → Keep this page as scanned** puts the scan back; Edit text then changes single words and leaves the rest of the scan exactly as it was.
  - English only for now; needs the app opened from its web address, not from a file on disk.
- Pages: rotate, delete, reorder, insert blank pages, and add pages from other PDFs
- Undo and redo for everything; your changes are saved as you go
- **Download** a new PDF with your changes. The original file is never touched.

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
js/fonts.js            identifies and downloads the font a PDF was set in
vendor/                PDF.js (shows pages) and pdf-lib (writes PDFs), loaded only for PDFs
js/icons.js            toolbar icons
sw.js                  offline support
manifest.webmanifest   app install details
AUDIT.md               what was wrong with the first version, and what changed
```

After changing any file, bump `CACHE` in `sw.js` so installed copies pick up
the update.

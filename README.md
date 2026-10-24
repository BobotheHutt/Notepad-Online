# Notepad Online

A fast, private word processor that runs entirely in your browser. No
account, no server, no tracking. What you write stays on your device. It
saves as you type, works offline, and opens and saves Word documents.

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
js/icons.js            toolbar icons
sw.js                  offline support
manifest.webmanifest   app install details
AUDIT.md               what was wrong with the first version, and what changed
```

After changing any file, bump `CACHE` in `sw.js` so installed copies pick up
the update.

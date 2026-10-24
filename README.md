# Notepad Online

A blazing-fast, distraction-free web word processor built entirely using native vanilla web standards. Designed as a lightweight, zero-cost alternative to heavy office suites for day-to-day writing, formatting, and proofreading.

## 🚀 Key Features

- **Session Continuity (Auto-Save):** Automatically backs up your current layout to your browser's internal Local Storage every second.
- **Flexible Document Layouts:** 
  - *Notepad Style:* Full-screen seamless window configuration.
  - *Letter Page Style:* Virtual physical A4/Letter paper canvas setup with margins.
- **Typography & Aesthetics:** Real-time font-family switching, native font scaling, text color palettes, text highlighting tools, and a global Dark Mode layout toggle.
- **Advanced Editing Utilities:** Inline global text find and replace tool, real-time live character/word analytics, and a custom Word Target Goal tracker with a visual progress indicator bar.
- **Accessibility & Media Exports:** Built-in Speech Synthesis audio text reader, standard clean print styles optimize formatting for direct physical printer/PDF saving, alongside traditional `.txt` and formatting-safe `.html` direct file downloads.
- **Developer Markdown Tooling:** Real-time side-by-side split pane live Markdown parser rendering engine.

---

## 💾 Starting a New Writing Session

Because this application uses continuous Local Storage session backups to prevent accidental loss of text if the page refreshes or crashes, it will always automatically pull up your most recent draft when launched.

When you are ready to completely wipe the current canvas state and spin up a **clean new document session**, use these steps:

1. **Click the Red Trash Icon (🗑️ Clear)** located on the far right end of the top app toolbar.
2. A browser dialog alert will appear asking: *"Are you sure you want to permanently clear this document?"*
3. Click **OK / Confirm**.
4. The canvas text and word metric trackers will reset completely, and the local backup memory partition for that specific browser will be entirely wiped, establishing a fresh session canvas instantly.

---

## 🛠️ Local Development & Deployment

### Quick Run Local
1. Download or clone this repository to your machine.
2. Double-click `index.html` to launch the app instantly in any modern desktop or mobile browser.

### Publishing to GitHub Pages
1. Go to your repository settings page on GitHub.
2. Click **Pages** in the left sidebar menu.
3. Under *Build and deployment*, set the deployment source to **Deploy from a branch**.
4. Choose the `main` or `master` branch, select the root `/` folder, and click **Save**.
5. Your application will be live globally at: `https://<your-username>.github.io/Notepad-Online/`

// Makes the PDFs the tests open, in tests/.fixtures/: a typed letter, a form,
// and scans drawn here from made-up text (a little crooked, speckled, one
// page sideways), so the tests never need a real person's document.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'tests', '.fixtures');

export default async function globalSetup() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>fixtures</title>');
  await page.addScriptTag({ path: path.join(ROOT, 'vendor/pdf-lib/pdf-lib.min.js') });
  const out = await page.evaluate(async () => {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    const files = {};

    // a typed letter, two pages
    {
      const d = await PDFDocument.create();
      const f = await d.embedFont(StandardFonts.TimesRoman);
      const fb = await d.embedFont(StandardFonts.HelveticaBold);
      let pg = d.addPage([612, 792]);
      pg.drawText('Invoice 1042', { x: 72, y: 700, size: 24, font: fb });
      pg.drawText('Dear Ms. Rivera, thank you for your order.', { x: 72, y: 660, size: 12, font: f });
      pg.drawText('Total due: $450.00', { x: 72, y: 630, size: 14, font: f, color: rgb(0.7, 0, 0) });
      pg = d.addPage([612, 792]);
      pg.drawText('Page two text', { x: 72, y: 700, size: 12, font: f });
      files['letter.pdf'] = b64(await d.save());
    }

    // a form with one of each kind of field
    {
      const d = await PDFDocument.create();
      const pg = d.addPage([612, 792]);
      const f = await d.embedFont(StandardFonts.Helvetica);
      const form = d.getForm();
      pg.drawText('Name:', { x: 50, y: 700, size: 12, font: f });
      form.createTextField('name').addToPage(pg, { x: 110, y: 690, width: 200, height: 24 });
      pg.drawText('Agree:', { x: 50, y: 650, size: 12, font: f });
      form.createCheckBox('agree').addToPage(pg, { x: 110, y: 645, width: 18, height: 18 });
      const dd = form.createDropdown('color'); dd.addOptions(['Red', 'Green', 'Blue']); dd.addToPage(pg, { x: 110, y: 600, width: 120, height: 24 });
      const rg = form.createRadioGroup('size');
      rg.addOptionToPage('S', pg, { x: 110, y: 560, width: 16, height: 16 });
      rg.addOptionToPage('L', pg, { x: 140, y: 560, width: 16, height: 16 });
      files['form.pdf'] = b64(await d.save());
    }

    // scans: text drawn at 200 dpi on off-white paper, turned a little, speckled
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    function scanPage(lines, { skew = 0, sideways = false } = {}) {
      const W = 1700, H = 2200;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#f4f2ec'; g.fillRect(0, 0, W, H);
      g.save();
      g.translate(W / 2, H / 2); g.rotate((skew * Math.PI) / 180); g.translate(-W / 2, -H / 2);
      g.fillStyle = '#e4e8ef'; g.fillRect(180, 1380, 1340, 150);
      g.fillStyle = '#1b1b1b';
      let y = 260;
      for (const l of lines) {
        g.font = (l.bold ? 'bold ' : '') + (l.size || 46) + 'px Arial, Helvetica, sans-serif';
        g.fillText(l.t, 200, y);
        y += (l.size || 46) * 1.9;
      }
      g.restore();
      const img = g.getImageData(0, 0, W, H);
      for (let i = 0; i < img.data.length; i += 4) {
        const n = (rand() - 0.5) * 18;
        img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
      }
      g.putImageData(img, 0, 0);
      if (!sideways) return c;
      const r = document.createElement('canvas'); r.width = H; r.height = W;
      const rg = r.getContext('2d');
      rg.translate(H, 0); rg.rotate(Math.PI / 2); rg.drawImage(c, 0, 0);
      return r;
    }
    const jpeg = async (c) => new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85))).arrayBuffer());
    async function scanPdf(pages) {
      const d = await PDFDocument.create();
      for (const c of pages) {
        const img = await d.embedJpg(await jpeg(c));
        const w = (c.width / 200) * 72, h = (c.height / 200) * 72;
        d.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
      }
      return b64(await d.save());
    }
    const form1 = [
      { t: 'APPLICATION FOR SERVICE', bold: true, size: 60 },
      { t: 'Full name: John Example' },
      { t: 'Date of birth: March 4, 1981' },
      { t: 'Address: 1200 Main Street, Springfield' },
      { t: 'Please describe the request below and sign' },
      { t: 'the form before you return it to the office.' },
      { t: 'Office use only: received and checked' }
    ];
    const form2 = [
      { t: 'SECOND PAGE', bold: true, size: 60 },
      { t: 'Phone number: 555 0100' },
      { t: 'Email address: john@example.com' },
      { t: 'Signature and date of signing' }
    ];
    files['scan.pdf'] = await scanPdf([scanPage(form1, { skew: 1.2 })]);
    files['multi-scan.pdf'] = await scanPdf([scanPage(form1, { skew: 1.2 }), scanPage(form2, { sideways: true })]);
    return files;
  });
  for (const [name, data] of Object.entries(out)) fs.writeFileSync(path.join(FIXTURES, name), Buffer.from(data, 'base64'));
  await browser.close();
}

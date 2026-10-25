Third-party libraries, unmodified:

- pdfjs/      PDF.js 3.11.174 (Mozilla), Apache-2.0. Displays PDF pages.
- pdf-lib/    pdf-lib 1.17.1, MIT. Writes edited PDFs.
              fontkit.umd.min.js: @pdf-lib/fontkit 1.1.1, MIT. Embeds
              downloaded fonts.
- tesseract/  Tesseract.js 5.1.1 + core 5.1.1 (SIMD, LSTM) + English data
              (4.0.0_best_int; Tesseract data is Apache-2.0). Apache-2.0. Reads
              text on scanned pages.
- opentype/   opentype.js 1.3.4, MIT. Builds fonts from a scan's own letters.

Loaded only when needed: PDF tools when a PDF is opened, Tesseract when
"Read text" is used, opentype.js when a scan's letters are made into a font.

Each folder holds its library's license text, which must stay with it.

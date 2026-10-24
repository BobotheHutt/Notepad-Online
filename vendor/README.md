Third-party libraries, unmodified:

- pdfjs/      PDF.js 3.11.174 (Mozilla), Apache-2.0. Displays PDF pages.
- pdf-lib/    pdf-lib 1.17.1, MIT. Writes edited PDFs.
- tesseract/  Tesseract.js 5.1.1 + core 5.1.1 (SIMD, LSTM) + English data
              (4.0.0_best_int; Tesseract data is Apache-2.0). Apache-2.0. Reads
              text on scanned pages.

Loaded only when needed: PDF tools when a PDF is opened, Tesseract when
"Read text" is used.

Third-party libraries, unmodified:

- pdfjs/      PDF.js 6.4.299 (Mozilla, the "legacy" build, which runs in
              more browsers), Apache-2.0. Displays PDF pages. wasm/ holds its
              image decoders (OpenJPEG, BSD-2-Clause; JBIG2 from PDFium,
              BSD-3-Clause) and color-profile engine (qcms, MIT), with their
              licenses.
- pdf-lib/    pdf-lib 1.17.1, MIT. Writes edited PDFs.
              fontkit.umd.min.js: @pdf-lib/fontkit 1.1.1, MIT. Embeds
              downloaded fonts.
- tesseract/  Tesseract.js 5.1.1 + core 5.1.1 (SIMD, LSTM) + English data
              (4.0.0_best_int; Tesseract data is Apache-2.0). Apache-2.0. Reads
              text on scanned pages. fast/: Tesseract's fast English model
              (tessdata_fast), Apache-2.0, read first; the accurate model
              re-reads the lines it is unsure of.
- opentype/   opentype.js 1.3.4, MIT. Builds fonts from a scan's own letters.
- utif/       UTIF.js (utif2 4.1.0, Photopea), MIT, with pako 2.1.0's inflate
              (MIT) that it uses for compressed TIFFs. Reads TIFF images.

Loaded only when needed: PDF tools when a PDF is opened, Tesseract when
"Read text" is used, opentype.js when a scan's letters are made into a font,
UTIF.js when a TIFF is opened.

Each folder holds its library's license text, which must stay with it.

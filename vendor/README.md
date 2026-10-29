Third-party libraries, unmodified:

- pdfjs/      PDF.js 6.4.299 (Mozilla, the "legacy" build, which runs in
              more browsers), Apache-2.0. Displays PDF pages. wasm/ holds its
              image decoders (OpenJPEG, BSD-2-Clause; JBIG2 from PDFium,
              BSD-3-Clause) and color-profile engine (qcms, MIT), with their
              licenses.
- pdf-lib/    pdf-lib 1.17.1, MIT. Writes edited PDFs.
              fontkit.umd.min.js: @pdf-lib/fontkit 1.1.1, MIT. Embeds
              downloaded fonts.
- tesseract/  Tesseract.js 5.1.1 + core 5.1.1 (SIMD, LSTM) + English, Spanish,
              French, German, Portuguese and Italian data (4.0.0_best_int, from
              @tesseract.js-data; Tesseract data is Apache-2.0). Apache-2.0. Reads
              text on scanned pages. fast/: Tesseract's fast models
              (tessdata_fast) for the same six languages, Apache-2.0, read
              first; the accurate model re-reads the lines it is unsure of.
- opentype/   opentype.js 1.3.4, MIT. Builds fonts from a scan's own letters.
- utif/       UTIF.js (utif2 4.1.0, Photopea), MIT, with pako 2.1.0's inflate
              (MIT) that it uses for compressed TIFFs. Reads TIFF images.

- fonts/      31 common document fonts from Fontsource (5.3.x), Latin set,
              WOFF and WOFF2; each folder holds its license (SIL Open Font
              License 1.1, or Apache 2.0 for Roboto Slab).

- franc/      franc-min 6.2.0 (Titus Wormer), MIT, bundled with the three small
              MIT libraries it uses. Tells which language a text is in.

- hunspell/   hunspell-wasm 0.3.0: the Hunspell spell checker compiled to
              WebAssembly, used under its MPL 1.1 option (LICENSE-MPL).
- dictionaries/  Hunspell dictionaries, from the wooorm/dictionaries
              packages, each folder with its license: en (SCOWL, MIT/BSD),
              es (MPL 1.1 option), fr (MPL 2.0), de (igerman98, GPL 2 or 3),
              pt (VERO, Brazilian, MPL 2.0 option), it (GPL 3). Dictionaries
              are data files, kept apart from Noteshack's own code.

- bergamot/   @browsermt/bergamot-translator 0.4.9: Firefox's translation
              engine, compiled to WebAssembly, MPL-2.0 (LICENSE). The models
              it uses (Mozilla's, also MPL-2.0) are not here: they are on
              files.noteshack.org (tools/translation-models.py), downloaded
              the first time a language pair is used.

- harfbuzz/   harfbuzzjs 1.6.4: HarfBuzz compiled to WebAssembly (harfbuzz.wasm,
              with index.mjs and harfbuzz.js to load it) and its subsetter
              (harfbuzz-subset.wasm), Old MIT (COPYING; LICENSE for the
              JavaScript). Shapes text in other scripts for saved PDFs and
              cuts their fonts down to the letters used. The Noto fonts it
              shapes with (SIL Open Font License 1.1) are not here: they are
              on files.noteshack.org (tools/noto-fonts.py), downloaded the
              first time a script needs one.
- bidi/       bidi-js 1.1.0 (Jason Johnston), MIT. The Unicode bidirectional
              algorithm: the order of right-to-left and left-to-right text.

Loaded only when needed: PDF tools when a PDF is opened, Tesseract when
"Read text" is used, opentype.js when a scan's letters are made into a font,
UTIF.js when a TIFF is opened, the translator when a document is translated,
HarfBuzz and bidi-js when a PDF with text in other scripts is saved.

Each folder holds its library's license text, which must stay with it.

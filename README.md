# DokScan

A website that turns a photo of a paper form into an editable, fillable copy.

- **Scan** – take a photo with your phone or pick an image. The page edges are found automatically
  (drag the corners to adjust) and the page is straightened.
- **Rebuild the layout** – ruled lines, tables, checkboxes and text are detected and placed where
  they were on paper. Text recognition (OCR) runs in your browser with Tesseract; nothing is uploaded.
- **Fill it in** – every table cell, every "Name: ______" / "Company: ______" line, dotted line,
  `Label:` followed by empty space, and every checkbox becomes a field you can type in or tick.
- **Edit layout** – move, resize, add or delete text, fields, boxes, checkboxes and lines;
  double-click text to correct it. Undo/redo included.
- **Saves automatically** in the browser (IndexedDB), so your progress is still there next time you
  open the site on the same device. *Download → Project file* moves a document to another device.
- **Download** as PDF or PNG, or **Print** to any printer your device can reach (including network
  printers) through the system print dialog.

## Hosting on GitHub Pages

The site is plain static files served from the `gh-pages` branch. `.github/workflows/pages.yml` copies `main` to `gh-pages` on every push, so just push to `main`.

If the site shows a 404, open **Settings → Pages** and set **Source** to *Deploy from a branch*,
branch `gh-pages`, folder `/ (root)`.

Live site: `https://blixermixer.github.io/DokScan/`

GitHub Pages on a private repository requires a paid GitHub plan; on a free plan make the repo public.

## Run locally

Any static file server works, e.g. `python3 -m http.server` in this folder, then open
<http://localhost:8000>. (Opening `index.html` directly from disk won't work because the app uses
JavaScript modules.)

## Notes & limits

- English text recognition is bundled. Other languages (Swedish, Polish, German, …) are downloaded
  once from the jsDelivr CDN the first time you scan with them.
- Each scan is one page. Scan multi-page documents page by page.
- Web pages can't talk to printers directly; printing always goes through the device's print dialog,
  where any installed network printer can be chosen.
- Saved documents live in the browser's storage on that device. Clearing site data deletes them,
  so download a project file for anything important.

## Third-party code (in `vendor/`)

- [Tesseract.js](https://github.com/naptha/tesseract.js) 5.1.1 + tesseract.js-core and English
  traineddata – Apache-2.0
- [jsPDF](https://github.com/parallax/jsPDF) 2.5.2 – MIT

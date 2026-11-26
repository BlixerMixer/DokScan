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
- **Accounts (optional)** – sign in with email and password; each person's documents are private and
  follow them to any device. A copy stays on the device so it keeps working offline and syncs later.
  Without accounts set up, documents are saved in the browser on each device.
- **Download** as PDF or PNG, or **Print** to any printer your device can reach (including network
  printers) through the system print dialog.

## Hosting on GitHub Pages

The site is plain static files served from the `gh-pages` branch. `.github/workflows/pages.yml` copies `main` to `gh-pages` on every push, so just push to `main`.

If the site shows a 404, open **Settings → Pages** and set **Source** to *Deploy from a branch*,
branch `gh-pages`, folder `/ (root)`.

Live site: `https://blixermixer.github.io/DokScan/`

GitHub Pages on a private repository requires a paid GitHub plan; on a free plan make the repo public.

## Turning on accounts (Supabase, free)

1. Create a free account at <https://supabase.com> and click **New project** (choose an EU region if
   you're in Europe). Pick any database password; you won't need it here.
2. Open **SQL Editor → New query**, paste everything from [`supabase/setup.sql`](supabase/setup.sql)
   and click **Run**. This creates the documents table, the private `scans` bucket and the rules that
   make every person see only their own documents.
3. Open **Authentication → URL Configuration** and set **Site URL** to
   `https://blixermixer.github.io/DokScan/`. Links in sign-up and password-reset emails lead there.
4. Open **Project Settings → API** (or **API Keys**) and copy the **Project URL** and the
   **publishable / anon** key into [`js/config.js`](js/config.js). Never use the `service_role` /
   secret key here.
5. Push to `main`. About a minute later the site asks people to sign in or create an account.

By default Supabase asks new users to confirm their email address. Its built-in email service only
sends a few emails per hour, which is fine for testing. For 30 people signing up at once, either turn
off **Confirm email** under **Authentication → Sign In / Providers → Email**, or connect your own
email service (SMTP) under **Authentication → Emails**.

Notes:
- Each person's documents are protected by the database's row-level security, not just the website.
- Logging out removes that person's documents from the device (they stay in the account), so shared
  school computers are safe to use.
- If the same document is edited on two devices at the same time, the last change to sync wins.
- Free Supabase projects pause after a week with no activity; open the Supabase dashboard to resume.

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
- Without accounts, saved documents live in the browser's storage on that device. Clearing site data
  deletes them, so download a project file for anything important.

## Support, legal and license

- Support: Blixxzt13@gmail.com · Donations: <https://github.com/sponsors/BlixerMixer>
- [Privacy notice](privacy.html) · [Terms of service](terms.html) · [Licenses](licenses.html)
- © 2026 BlixerMixer. All rights reserved; see [LICENSE](LICENSE). The source is public for reference
  only and may not be copied or re-hosted without permission.

## Third-party code (in `vendor/`)

- [Tesseract.js](https://github.com/naptha/tesseract.js) 5.1.1 + tesseract.js-core and English
  traineddata – Apache-2.0
- [jsPDF](https://github.com/parallax/jsPDF) 2.5.2 – MIT
- [supabase-js](https://github.com/supabase/supabase-js) 2.110.9 – MIT

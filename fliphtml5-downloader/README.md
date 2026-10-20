# FlipHTML5 to PDF

A one-page site: paste a FlipHTML5 book link and it saves the book as a PDF.
Everything runs in the visitor's browser. There's no build step, database or
account.

Ported from [nyr-github/fliphtml5-downloader](https://github.com/nyr-github/fliphtml5-downloader)
(MIT). The original is a full Next.js app with a database, payments and a
community library; this version keeps only the downloader and adds an
optional OCR text layer.

## How it works

1. Reads `https://online.fliphtml5.com/<id1>/<id2>/javascript/config.js` to get
   the title and page list.
2. If the page list is encrypted, loads FlipHTML5's own decoder
   (`deString.js`) to decrypt it.
3. Downloads each page. Image pages are used directly. `.zip` pages are
   obfuscated, password-protected PDFs; they're unwrapped and rendered with
   PDF.js.
4. Puts all pages into one PDF with pdf-lib and saves it.

### Selectable text (OCR)

FlipHTML5 stores most books as page pictures, so the PDF has no text unless
you tick **Selectable text (OCR)**. Then each page is run through
[Tesseract.js](https://github.com/naptha/tesseract.js) in the browser, which
produces a text-only PDF layer (invisible text placed over each word). That
layer is drawn on top of the unchanged page image, so pages look identical
but text can be selected, copied and searched.

- Runs on the visitor's device: about 1–2 s per page.
- First use downloads the OCR engine (~4 MB) and the language data
  (1.4–3 MB per language) from jsDelivr; the browser caches them.
- 20 languages, including Hindi and other Indian languages.

The browser asks FlipHTML5 for each file directly. If that's blocked (CORS),
it falls back to `/api/proxy`, a Netlify Function that fetches only
`*.fliphtml5.com` URLs.

Books the publisher marked as private/encrypted are refused.

## Files

```
public/index.html        page
public/app.js            downloader logic
public/orb.js            Dot, the animated 3D dot-sphere mascot (canvas, no libraries)
public/ui.js             mascot moods, speech bubble, Paste button, link check, quality slider
public/glass.js          liquid glass: refracting rims (Chromium on computers) and pointer-lit edges
public/style.css         styles and the glass material (light and dark)
public/fonts/            Plus Jakarta Sans, self-hosted (SIL OFL, see OFL.txt)
netlify/functions/proxy.mts   CORS fallback (served at /api/proxy)
netlify.toml             publish dir + functions dir
```

app.js reports what a download is doing with `downloader` events on
`document` (`start`, `book`, `ocr-loading`, `progress`, `done`, `error`);
ui.js turns those into Dot's moods and speech bubble.

## Deploy to Netlify

From the Netlify dashboard: **Add new project → Import an existing project →
GitHub**, choose this repository, and set:

- **Base directory:** `fliphtml5-downloader`
- **Build command:** leave empty
- **Publish directory:** `fliphtml5-downloader/public` (filled in from `netlify.toml`)

Or with the CLI, from this folder:

```bash
npx netlify-cli deploy --prod
```

## Run locally

```bash
cd fliphtml5-downloader
npx netlify-cli dev
```

Opening `public/index.html` straight from disk also works, minus the proxy
fallback.

## Use responsibly

Only download books you have the right to keep, such as your own publications
or ones the publisher allows you to download. Not affiliated with FlipHTML5.

# FlipHTML5 to PDF

Paste a FlipHTML5 link, get a PDF. It is a plain static web page: no server, no database, no accounts.

Your browser downloads the book's page images straight from FlipHTML5 and stitches them into a PDF on your own device. Nothing passes through, or is stored on, the site that hosts it.

## Using it

1. Open the site and paste a link such as `https://fliphtml5.com/abcd/efgh/`.
2. Press **Convert to PDF**. The PDF downloads when it is ready (untick the box to download manually).

You can paste several links at once (separated by spaces or new lines). Two books are converted at a time.

### What it will not convert

- Books the publisher marked private or protected (`isEncryptionBook`). This is a deliberate rule, the same one the original project applies.
- Books that keep their pages in ZIP/PDF containers (FlipHTML5's protected page format).
- Books over 2,000 pages, which a browser cannot safely hold in memory.
- Removed, password-protected or otherwise non-public books.

A page that still fails after three attempts is replaced by a blank page and listed on the card, with a **Convert again** button.

### Limits worth knowing

- FlipHTML5 serves pages as pictures, so the PDF has no selectable text layer.
- JPEG pages are embedded exactly as served (no recompression); WebP/PNG pages are converted to JPEG at quality 95 on a white background.
- Page size is the image size at 150 dpi (a 1240 px wide page becomes A4 width).
- It relies on FlipHTML5 allowing these requests from other websites (CORS), the same assumption the original project makes. If FlipHTML5 changes that, or its page-list format, the page will say so rather than hang.
- For books with an encrypted page list, the page loads two scripts from `static.fliphtml5.com` (the same ones FlipHTML5's own reader uses) to decode it. They are only loaded when a book needs them.

Use it for personal, educational purposes with books you are entitled to copy, and respect each publisher's rights and FlipHTML5's terms.

## Project layout

```
site/        the website (this is what gets published)
  index.html, styles.css, favicon.svg, _headers
  js/
    app.js        page: form, queue, cards
    convert.js    one book -> one PDF
    flipbook.js   link parsing, book config, page list, page URLs
    images.js     page image -> JPEG (pass-through or re-encode)
    pdf-writer.js tiny dependency-free PDF writer
    net.js        fetch with timeout, retries, cancellation
test/        unit tests, browser tests, tiny static server
netlify.toml publishes site/ (no build step)
```

## Run and test locally

```bash
npm install
npm start          # http://localhost:8888
npm test           # unit tests + browser tests
```

The browser tests drive the real page in headless Chromium while a fake FlipHTML5 answers the requests (nothing leaves your machine). They write PDFs and screenshots to `test-output/`. They use a stand-in for FlipHTML5's decoder script, so the decoder itself is not covered.

## Deploying to Netlify

The site needs no build. Any of these works:

- **Git:** connect the repository and set the base directory to `fliphtml5-pdf-downloader` (`netlify.toml` already publishes `site/`).
- **CLI:** `npx netlify deploy --prod --dir=site`
- **Drag and drop:** drop the `site/` folder on <https://app.netlify.com/drop>.

## Credits

The way this talks to FlipHTML5 (where a book's `config.js` lives, decoding encrypted page lists with FlipHTML5's own `deString.js`, building page image URLs, refusing `isEncryptionBook` books) follows the open-source [nyr-github/fliphtml5-downloader](https://github.com/nyr-github/fliphtml5-downloader), whose README declares the MIT licence. The code here was written from scratch as a dependency-free static site. See [NOTICE.md](NOTICE.md).

Not affiliated with FlipHTML5.

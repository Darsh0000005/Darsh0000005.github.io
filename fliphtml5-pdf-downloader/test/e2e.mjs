// Browser tests: the real page in headless Chromium, with FlipHTML5 replaced by an
// in-process fake (requests to the real hosts are intercepted, nothing leaves the machine).
// Run with `npm run test:e2e`; set ONLY=<text> to run matching tests.
// PDFs and screenshots are written to test-output/ for inspection.

import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { chromium } from 'playwright-core';
import { serve } from './server.mjs';

const OUT_DIR = fileURLToPath(new URL('../test-output/', import.meta.url));
const VIEWER = 'https://online.fliphtml5.com';
const STATIC = 'https://static.fliphtml5.com';
const CORS = { 'access-control-allow-origin': '*' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const approx = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 0.01, `${message ?? 'value'}: ${actual} vs ${expected}`);

// ---- Fake FlipHTML5 ---------------------------------------------------------

// Stand-in for FlipHTML5's decoder script. It "decrypts" base64 and appends junk after the
// JSON, and only becomes ready after a delay, so the page's polling and trimming get exercised.
// It is NOT FlipHTML5's real algorithm.
const ENGINE_STAND_IN = `
setTimeout(() => {
  window.Module = { _DeString: (pointer) => pointer };
  window.allocateUTF8 = (text) => ({ text });
  window.UTF8ToString = (pointer) => atob(pointer.text) + '\\u0000trailing-junk';
}, 300);
`;

class FakeFlipHtml5 {
  books = new Map();
  requests = []; // pathnames asked of the viewer host
  engineRequests = [];
  engine = 'ok'; // or 'blocked'

  /** Registers a book and returns its fliphtml5.com link. */
  addBook({
    id1 = 'abcd',
    id2 = 'efgh',
    title = 'Test Book',
    pages,
    encrypted = false,
    protectedBook = false,
    configDelay = 0,
    configAbort = false,
  }) {
    const entries = pages.map((page) => ({ n: [page.name], t: `files/thumb/${page.name}` }));
    const config = {
      fliphtml5_pages: encrypted ? Buffer.from(JSON.stringify(entries)).toString('base64') : entries,
      meta: { title, pageWidth: 300, pageHeight: 420 },
      loadingConfig: { isEncryptionBook: protectedBook },
    };
    this.books.set(`${id1}/${id2}`, {
      configText: `var htmlConfig = ${JSON.stringify(config)};\nvar tail = 1;`,
      configDelay,
      configAbort,
      files: new Map(pages.map((page) => [`files/large/${page.name}`, { hits: 0, ...page }])),
    });
    return `https://fliphtml5.com/${id1}/${id2}/`;
  }

  async install(context) {
    await context.route(`${VIEWER}/**`, (route) => this.#viewer(route).catch(() => {}));
    await context.route(`${STATIC}/**`, (route) => {
      this.engineRequests.push(new URL(route.request().url()).pathname);
      if (this.engine === 'blocked') return route.abort();
      const body = route.request().url().includes('jquery') ? '/* jquery stand-in */' : ENGINE_STAND_IN;
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/javascript' }, body });
    });
  }

  async #viewer(route) {
    const { pathname } = new URL(route.request().url());
    this.requests.push(pathname);
    const [id1, id2, ...rest] = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const book = this.books.get(`${id1}/${id2}`);
    const path = rest.join('/');
    if (!book) return route.fulfill({ status: 404, headers: CORS, body: 'Not found' });

    // Requests the browser itself refuses (CORS, ad blockers, offline) look like aborted ones to the page.
    if (path === 'javascript/config.js') {
      if (book.configAbort) return route.abort('failed');
      if (book.configDelay) await sleep(book.configDelay);
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/javascript' },
        body: book.configText,
      });
    }

    const file = book.files.get(path);
    if (!file) return route.fulfill({ status: 404, headers: CORS, body: 'Not found' });
    file.hits++;
    if (file.abort) return route.abort('failed');
    if (file.delay) await sleep(file.delay);
    if (file.failFirst && file.hits <= file.failFirst) {
      return route.fulfill({ status: 503, headers: CORS, body: 'busy' });
    }
    return route.fulfill({
      status: file.status ?? 200,
      headers: { ...CORS, 'content-type': file.type },
      body: file.body,
    });
  }

  filesRequested() {
    return this.requests.filter((path) => path.includes('/files/')).length;
  }
}

// ---- Fixtures & helpers -----------------------------------------------------

// Draws a numbered, per-page-coloured image inside the browser and returns its bytes.
async function generateImage(lab, spec) {
  const base64 = await lab.evaluate(async ({ type, width, height, index, transparent }) => {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = transparent ? 'rgb(20,120,60)' : `hsl(${(index * 53) % 360} 70% 45%)`;
    context.fillRect(0, 0, transparent ? width / 2 : width, height); // a transparent PNG leaves the right half empty
    context.fillStyle = '#fff';
    context.font = 'bold 120px sans-serif';
    context.fillText(String(index + 1), 40, height / 2);
    const blob = await canvas.convertToBlob({ type, quality: 0.9 });
    let binary = '';
    for (const byte of new Uint8Array(await blob.arrayBuffer())) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, { width: 300, height: 420, index: 0, transparent: false, ...spec });
  return Buffer.from(base64, 'base64');
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function pagesOf(makeImage, types, extra = () => ({})) {
  return Promise.all(
    types.map(async (type, index) => ({
      name: `${index + 1}.${EXTENSIONS[type]}`,
      type,
      body: await makeImage({ type, index, transparent: type === 'image/png' }),
      ...extra(index),
    })),
  );
}

const jpegs = (count) => Array(count).fill('image/jpeg');

const card = (page, index = 0) => page.locator('.task').nth(index);
const part = (page, name, index = 0) => card(page, index).locator(`[data-part="${name}"]`);
const waitState = (page, state, index = 0, timeout = 30000) =>
  page.waitForSelector(`.task:nth-child(${index + 1})[data-state="${state}"]`, { timeout });

async function submit(page, text) {
  await page.fill('#link-input', text);
  await page.click('#link-form button[type="submit"]');
}

/** Submits a link and resolves with the PDF the page downloads by itself. */
async function convert(page, link, name) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), submit(page, link)]);
  await mkdir(OUT_DIR, { recursive: true });
  const saved = `${OUT_DIR}${slug(name)}.pdf`;
  await download.saveAs(saved);
  return { bytes: await readFile(saved), filename: download.suggestedFilename() };
}

// Runs axe-core in the page and returns one readable line per accessibility violation.
async function axeViolations(page) {
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core') });
  const { violations } = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
  return violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((node) => node.target.join(' ')).join(' | ')}`,
  );
}

async function inspect(bytes) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return { count: pdf.getPageCount(), sizes: pdf.getPages().map((p) => p.getSize()), title: pdf.getTitle() };
}

// ---- Tests ------------------------------------------------------------------

const cases = [];
const test = (name, run) => cases.push({ name, run });

test('the site is served with the security headers from _headers', async ({ page, site }) => {
  const response = await page.request.get(site.url);
  assert.equal(response.headers()['x-content-type-options'], 'nosniff');
  assert.equal(response.headers()['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.match(response.headers()['content-security-policy'], /object-src 'none'/);
  assert.equal((await page.request.get(`${site.url}_headers`)).status(), 404, '_headers is configuration, not content');
});

test('JPEG pages are embedded byte-for-byte and the card reports success', async ({ page, fake, makeImage }) => {
  const pages = await pagesOf(makeImage, jpegs(6));
  const link = fake.addBook({ title: 'My Test Book', pages });
  const { bytes, filename } = await convert(page, link, 'jpeg-book');

  assert.equal(filename, 'My Test Book.pdf');
  const info = await inspect(bytes);
  assert.equal(info.count, 6);
  assert.equal(info.title, 'My Test Book');
  for (const size of info.sizes) {
    approx(size.width, 144, 'page width'); // 300 px at 150 dpi
    approx(size.height, 201.6, 'page height');
  }
  pages.forEach((p, i) => assert.ok(bytes.includes(p.body), `page ${i + 1} embedded unchanged`));

  await waitState(page, 'done');
  assert.match(await part(page, 'status').innerText(), /^Ready · 6 pages · \d+ KB$/);
  assert.equal(await card(page).locator('.bar').getAttribute('aria-valuenow'), '100');
  assert.equal(await part(page, 'note').isHidden(), true);
  assert.match(await page.locator('#live').innerText(), /My Test Book is ready/);
  assert.equal(await part(page, 'cover').isVisible(), true);
});

test('WebP and PNG pages are converted, JPEG pages stay untouched', async ({ page, fake, makeImage }) => {
  const pages = await pagesOf(makeImage, ['image/webp', 'image/png', 'image/jpeg', 'image/webp']);
  const link = fake.addBook({ pages });
  const { bytes } = await convert(page, link, 'mixed-formats');

  const info = await inspect(bytes);
  assert.equal(info.count, 4);
  info.sizes.forEach((size, i) => approx(size.width, 144, `page ${i + 1} width`));
  assert.ok(bytes.includes(pages[2].body), 'JPEG page embedded unchanged');
  assert.ok(!bytes.includes(pages[1].body), 'PNG page was re-encoded');
  assert.ok(!bytes.includes(pages[0].body), 'WebP page was re-encoded');
});

test('encrypted page lists are decoded with the engine, which is loaded only once', async ({ page, fake, makeImage }) => {
  const first = fake.addBook({ id2: 'one', encrypted: true, pages: await pagesOf(makeImage, jpegs(3)) });
  const second = fake.addBook({ id2: 'two', encrypted: true, pages: await pagesOf(makeImage, jpegs(2)) });

  assert.equal((await inspect((await convert(page, first, 'encrypted-one')).bytes)).count, 3);
  assert.equal((await inspect((await convert(page, second, 'encrypted-two')).bytes)).count, 2);
  assert.deepEqual(
    fake.engineRequests.map((path) => path.split('/').pop()),
    ['jquery-4.0.0.min.js', 'deString.js'],
  );
});

test('a blocked decoder gives a clear error, and trying again works once it is reachable', async ({ page, fake, makeImage }) => {
  fake.engine = 'blocked';
  const link = fake.addBook({ encrypted: true, pages: await pagesOf(makeImage, jpegs(2)) });
  await submit(page, link);
  await waitState(page, 'error');
  assert.match(await part(page, 'note').innerText(), /page-list decoder/);

  fake.engine = 'ok';
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    card(page).locator('[data-action="retry"]').click(),
  ]);
  assert.equal(download.suggestedFilename(), 'Test Book.pdf');
});

test('private/protected books are refused without touching any page', async ({ page, fake, makeImage }) => {
  const link = fake.addBook({ title: 'Members Only', protectedBook: true, pages: await pagesOf(makeImage, jpegs(3)) });
  await submit(page, link);
  await waitState(page, 'error');
  assert.match(await part(page, 'note').innerText(), /private or protected/);
  assert.equal(await part(page, 'title').textContent(), 'Members Only', 'the card is named after the book, not its id');
  assert.equal(await card(page).locator('.bar').isHidden(), true, 'no empty progress bar on a refused book');
  assert.equal(fake.filesRequested(), 0);
  assert.equal(await card(page).locator('[data-action="retry"]').isHidden(), true, 'no pointless retry button');
  assert.equal(await card(page).locator('[data-action="remove"]').isVisible(), true);
});

test('ZIP/PDF container pages are refused', async ({ page, fake }) => {
  const pages = ['1.zip', '2.zip'].map((name) => ({ name, type: 'application/zip', body: Buffer.from('PK') }));
  await submit(page, fake.addBook({ pages }));
  await waitState(page, 'error');
  assert.match(await part(page, 'note').innerText(), /protected format/);
  assert.equal(fake.filesRequested(), 0);
});

test('a book over the page limit is refused before downloading anything', async ({ page, fake }) => {
  const pages = Array.from({ length: 2001 }, (_, i) => ({ name: `${i + 1}.jpg`, type: 'image/jpeg', body: Buffer.alloc(0) }));
  await submit(page, fake.addBook({ pages }));
  await waitState(page, 'error');
  assert.match(await part(page, 'note').innerText(), /2001 pages/);
  assert.equal(fake.filesRequested(), 0);
});

test('an unknown book says it could not be found', async ({ page }) => {
  await submit(page, 'https://fliphtml5.com/nope/nothing/');
  await waitState(page, 'error');
  assert.match(await part(page, 'note').innerText(), /no public book at that link/);
});

test('a page that keeps failing becomes a blank page and is reported', async ({ page, fake, makeImage }) => {
  const pages = await pagesOf(makeImage, jpegs(5), (i) => (i === 2 ? { status: 404 } : {}));
  const { bytes } = await convert(page, fake.addBook({ pages }), 'partial-failure');

  const info = await inspect(bytes);
  assert.equal(info.count, 5);
  info.sizes.forEach((size, i) => approx(size.height, 201.6, `page ${i + 1} height`));
  assert.ok(bytes.includes(pages[1].body) && bytes.includes(pages[3].body));
  assert.ok(!bytes.includes(pages[2].body));

  await waitState(page, 'done');
  assert.match(await part(page, 'note').innerText(), /1 page couldn’t be downloaded \(3\) and was replaced/);

  // The card offers another go, and the missing page comes through once the server recovers.
  const again = card(page).locator('[data-action="retry"]');
  assert.equal(await again.isVisible(), true, 'a book with blank pages can be converted again');
  fake.books.get('abcd/efgh').files.get('files/large/3.jpg').status = 200;
  const [second] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), again.click()]);
  const repaired = await readFile(await second.path());
  assert.equal((await inspect(repaired)).count, 5);
  assert.ok(repaired.includes(pages[2].body), 'page 3 is filled in the second time');
  assert.equal(await part(page, 'note').isHidden(), true);
  assert.equal(await again.isHidden(), true, 'nothing left to retry');
});

test('if the first page fails the whole book fails fast', async ({ page, fake, makeImage }) => {
  const pages = await pagesOf(makeImage, jpegs(6), (i) => (i === 0 ? { status: 403 } : {}));
  await submit(page, fake.addBook({ pages }));
  await waitState(page, 'error');
  assert.match(await part(page, 'note').innerText(), /refused the first page image \(HTTP 403\)/);
  assert.equal(fake.filesRequested(), 1, 'only the probe page was requested');
});

test('requests the browser blocks give a helpful message instead of a hang', async ({ page, fake, makeImage }) => {
  const imagesBlocked = fake.addBook({
    id2: 'images',
    pages: await pagesOf(makeImage, jpegs(3), () => ({ abort: true })),
  });
  await submit(page, imagesBlocked);
  await waitState(page, 'error');
  assert.match(await part(page, 'note').innerText(), /first page image couldn’t be downloaded/);
  assert.equal(fake.filesRequested(), 3, 'the probe page was tried three times, then the book was given up on');

  const configBlocked = fake.addBook({
    id2: 'config',
    configAbort: true,
    pages: await pagesOf(makeImage, jpegs(3)),
  });
  await submit(page, configBlocked);
  await waitState(page, 'error');
  assert.match(await part(page, 'note').innerText(), /Couldn’t reach FlipHTML5/);
});

test('transient server errors are retried transparently', async ({ page, fake, makeImage }) => {
  const pages = await pagesOf(makeImage, jpegs(3), (i) => (i === 1 ? { failFirst: 1 } : {}));
  const { bytes } = await convert(page, fake.addBook({ pages }), 'retry-transient');
  assert.equal((await inspect(bytes)).count, 3);
  assert.ok(bytes.includes(pages[1].body), 'the retried page made it into the PDF');
  await waitState(page, 'done');
  assert.equal(await part(page, 'note').isHidden(), true, 'no warning for a page that recovered');
});

test('cancel stops all requests; converting again completes; remove clears the card', async ({ page, fake, makeImage }) => {
  const pages = await pagesOf(makeImage, jpegs(10), () => ({ delay: 400 }));
  const link = fake.addBook({ pages });
  await page.uncheck('#auto-download');
  await submit(page, link);
  await page.waitForSelector('.task [data-part="cover"]:not([hidden])'); // first page is in, the rest are in flight

  await card(page).locator('[data-action="cancel"]').click();
  await waitState(page, 'cancelled');
  const requestsAtCancel = fake.requests.length;
  await sleep(1500);
  assert.equal(fake.requests.length, requestsAtCancel, 'no new requests after cancelling');
  assert.equal(await part(page, 'status').innerText(), 'Cancelled');

  await card(page).locator('[data-action="retry"]').click();
  await waitState(page, 'done');
  assert.match(await part(page, 'status').innerText(), /^Ready · 10 pages/);

  await card(page).locator('[data-action="remove"]').click();
  assert.equal(await page.locator('.task').count(), 0);
  assert.equal(await page.locator('#queue-section').isHidden(), true);
});

test('bad input is explained; good links in the same paste are still queued', async ({ page, fake, makeImage }) => {
  await page.uncheck('#auto-download');
  await submit(page, 'hello');
  assert.equal(await page.locator('#form-error').isVisible(), true);
  assert.equal(await page.locator('.task').count(), 0);

  await submit(page, '');
  assert.match(await page.locator('#form-error').innerText(), /Paste a FlipHTML5 link first/);

  const good = fake.addBook({ pages: await pagesOf(makeImage, jpegs(2)) });
  await submit(page, `${good} https://example.com/x/y/`);
  await waitState(page, 'done');
  assert.equal(await page.locator('.task').count(), 1);
  assert.match(await page.locator('#form-error').innerText(), /not a fliphtml5\.com link/);
  assert.equal(await page.inputValue('#link-input'), 'https://example.com/x/y/', 'only the unusable link stays in the box');
});

test('the same book is not queued twice', async ({ page, fake, makeImage }) => {
  await page.uncheck('#auto-download');
  const link = fake.addBook({ configDelay: 500, pages: await pagesOf(makeImage, jpegs(2)) });
  await submit(page, link);
  await submit(page, link);
  assert.match(await page.locator('#form-error').innerText(), /already in your list/);
  assert.equal(await page.locator('.task').count(), 1);
});

test('at most two books are converted at the same time', async ({ page, fake, makeImage }) => {
  await page.uncheck('#auto-download');
  const links = [];
  for (const id2 of ['b1', 'b2', 'b3', 'b4']) {
    links.push(fake.addBook({ id2, configDelay: 600, pages: await pagesOf(makeImage, jpegs(2)) }));
  }
  await page.evaluate(() => {
    window.__maxWorking = 0;
    setInterval(() => {
      const working = document.querySelectorAll('.task[data-state="working"]').length;
      window.__maxWorking = Math.max(window.__maxWorking, working);
    }, 20);
  });
  await submit(page, links.join('\n'));
  await page.waitForFunction(() => document.querySelectorAll('.task[data-state="done"]').length === 4, null, {
    timeout: 30000,
  });
  assert.equal(await page.evaluate(() => window.__maxWorking), 2);
});

test('remote titles are shown as text and cannot inject markup', async ({ page, fake, makeImage }) => {
  const title = 'Tom &amp; Jerry</textarea><img src=x onerror="window.__xss=1">: Vol*1?/2';
  const link = fake.addBook({ title, pages: await pagesOf(makeImage, jpegs(2)) });
  const { filename } = await convert(page, link, 'xss-title');

  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('.task img[src="x"]').count(), 0);
  assert.equal(await part(page, 'title').textContent(), 'Tom & Jerry</textarea><img src=x onerror="window.__xss=1">: Vol*1?/2');
  assert.ok(filename.startsWith('Tom & Jerry') && filename.endsWith('.pdf'));
  assert.ok(!/[\\/:*?"<>|]/.test(filename.slice(0, -4)), `file name is safe: ${filename}`);
});

test('non-Latin titles survive in the file name and the PDF metadata', async ({ page, fake, makeImage }) => {
  const title = '日本語の本 – Café 📚';
  const { bytes, filename } = await convert(
    page,
    fake.addBook({ title, pages: await pagesOf(makeImage, jpegs(1)) }),
    'unicode-title',
  );
  assert.equal(filename, `${title}.pdf`);
  assert.equal((await inspect(bytes)).title, title);
});

test('layout and accessibility hold up on desktop, phone and in dark mode (screenshots in test-output/)', async ({ page, fake, makeImage }) => {
  await mkdir(OUT_DIR, { recursive: true });
  await page.uncheck('#auto-download');
  await page.screenshot({ path: `${OUT_DIR}screenshot-empty.png`, fullPage: true });

  const done = fake.addBook({ id2: 'done', title: 'Annual Report 2025', pages: await pagesOf(makeImage, jpegs(8)) });
  const blocked = fake.addBook({ id2: 'blocked', title: 'Members Only', protectedBook: true, pages: await pagesOf(makeImage, jpegs(2)) });
  const partial = fake.addBook({
    id2: 'partial',
    title: 'Garden Guide With A Rather Long Title That Needs To Be Truncated Nicely',
    pages: await pagesOf(makeImage, jpegs(6), (i) => (i === 3 ? { status: 404 } : {})),
  });
  const working = fake.addBook({
    id2: 'working',
    title: 'Travel Handbook',
    pages: await pagesOf(makeImage, jpegs(8), (i) => ({ delay: i === 0 ? 50 : 4000 })),
  });

  await submit(page, done);
  await waitState(page, 'done');
  await submit(page, blocked);
  await waitState(page, 'error');
  await submit(page, partial);
  await waitState(page, 'done');
  await submit(page, working);
  await page.waitForSelector('.task:nth-child(1) [data-part="cover"]:not([hidden])');

  const shoot = (name) => page.screenshot({ path: `${OUT_DIR}screenshot-${name}.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await shoot('desktop');
  assert.deepEqual(await axeViolations(page), [], 'accessibility problems (light)');

  await page.setViewportSize({ width: 390, height: 844 });
  await shoot('phone');
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'no horizontal scrolling on a phone',
  );

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(400); // let the buttons' colour transition settle
  await shoot('dark');
  assert.deepEqual(await axeViolations(page), [], 'accessibility problems (dark)');
});

// ---- Runner -----------------------------------------------------------------

const only = process.env.ONLY;
// Chromium builds download names through the system locale; without UTF-8 (minimal CI images)
// every non-ASCII name collapses to "download", which would hide the behaviour being tested.
const browser = await chromium.launch({ env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' } });
const site = await serve();

const lab = await (await browser.newContext()).newPage();
const imageCache = new Map();
const makeImage = async (spec) => {
  const key = JSON.stringify(spec);
  if (!imageCache.has(key)) imageCache.set(key, await generateImage(lab, spec));
  return imageCache.get(key);
};

let failures = 0;
let ran = 0;
for (const { name, run } of cases) {
  if (only && !name.includes(only)) continue;
  ran++;
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const fake = new FakeFlipHtml5();
  await fake.install(context);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(site.url);

  const started = Date.now();
  try {
    await run({ page, fake, makeImage, site });
    assert.deepEqual(pageErrors, [], 'uncaught errors in the page');
    console.log(`  ok    ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}\n${String(error.stack).replace(/^/gm, '        ')}`);
    await mkdir(OUT_DIR, { recursive: true });
    await page.screenshot({ path: `${OUT_DIR}FAIL-${slug(name).slice(0, 60)}.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
}

await browser.close();
await site.close();
console.log(`\n${ran - failures}/${ran} browser tests passed`);
process.exit(failures ? 1 : 0);

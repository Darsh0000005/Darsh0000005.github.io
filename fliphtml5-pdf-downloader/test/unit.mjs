// Unit tests for the pure parts: link parsing, config parsing, page URLs,
// the JPEG header reader, retry logic and the PDF writer. Run with `npm run test:unit`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { readJpegInfo } from '../site/js/images.js';
import { HttpError, fetchBytes } from '../site/js/net.js';
import { PdfDocument, pageSizeFor } from '../site/js/pdf-writer.js';
import {
  UserError,
  pageUrl,
  parseBookLink,
  parseHtmlConfig,
  splitLinks,
} from '../site/js/flipbook.js';
import { jpegFixtures } from './fixtures.mjs';

const BASE = 'https://online.fliphtml5.com/abcd/efgh/';

test('parseBookLink: accepts the usual link shapes', () => {
  const expected = { id1: 'abcd', id2: 'efgh' };
  for (const link of [
    'https://fliphtml5.com/abcd/efgh/',
    'https://fliphtml5.com/abcd/efgh/Some-Title/',
    'https://fliphtml5.com/abcd/efgh',
    'fliphtml5.com/abcd/efgh',
    '  https://fliphtml5.com/abcd/efgh/  ',
    'https://online.fliphtml5.com/abcd/efgh/#p=3',
    'http://www.fliphtml5.com/abcd/efgh/index.html?utm=x',
  ]) {
    assert.deepEqual(parseBookLink(link), expected, link);
  }
  assert.deepEqual(
    parseBookLink('https://fliphtml5.com/REZIDE/The-Glasshouse_merged/The_Glasshouse/'),
    { id1: 'REZIDE', id2: 'The-Glasshouse_merged' },
  );
  assert.deepEqual(parseBookLink('https://fliphtml5.com/abcd/caf%C3%A9/'), { id1: 'abcd', id2: 'café' });
});

test('parseBookLink: rejects things that are not single-book links', () => {
  const bad = [
    '',
    '   ',
    'not a link at all',
    'https://example.com/abcd/efgh/',
    'https://fliphtml5.com.evil.example/abcd/efgh/',
    'https://evilfliphtml5.com/abcd/efgh/',
    'javascript:alert(1)',
    'ftp://fliphtml5.com/abcd/efgh',
    'https://fliphtml5.com/',
    'https://fliphtml5.com/abcd/',
    'https://fliphtml5.com/bookcase/xyz',
    'https://fliphtml5.com/ab%20cd/efgh/',
    'https://fliphtml5.com/ab$cd/efgh/',
  ];
  for (const link of bad) {
    assert.throws(() => parseBookLink(link), UserError, JSON.stringify(link));
  }
});

test('splitLinks: separates on whitespace and commas', () => {
  assert.deepEqual(splitLinks('a b\nc,d\t\te'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitLinks('   '), []);
  assert.deepEqual(splitLinks(undefined), []);
});

test('parseHtmlConfig: finds the object even with braces and quotes inside strings', () => {
  const object = { a: 1, b: { c: '}; tricky " quote {', d: [1, 2, { e: 'x' }] }, f: 'line\\nbreak' };
  const source = `var htmlConfig = ${JSON.stringify(object)};\nvar other = {"x":1};`;
  assert.deepEqual(parseHtmlConfig(source), object);
  assert.deepEqual(parseHtmlConfig(`window.htmlConfig={"k":true}`), { k: true });
});

test('parseHtmlConfig: unreadable input becomes a UserError', () => {
  for (const source of ['', '<html>Not found</html>', 'var htmlConfig = ;', 'var htmlConfig = {"a":', 'var htmlConfig = {a:1};']) {
    assert.throws(() => parseHtmlConfig(source), (err) => err instanceof UserError && err.code === 'bad-config', source);
  }
});

test('pageUrl: builds image URLs the way the reader does', () => {
  const at = (path) => `${BASE}${path}`;
  assert.equal(pageUrl({ n: ['1.webp'] }, BASE), at('files/large/1.webp'));
  assert.equal(pageUrl({ n: ['./2.jpg'] }, BASE), at('files/large/2.jpg'));
  assert.equal(pageUrl({ n: ['files/large/3.jpg'] }, BASE), at('files/large/3.jpg'));
  assert.equal(pageUrl({ n: ['files\\large\\4.jpg'] }, BASE), at('files/large/4.jpg'));
  assert.equal(pageUrl({ n: ['files/content-page/5.jpg'] }, BASE), at('files/content-page/5.jpg'));
  assert.equal(pageUrl({ n: '6.jpg' }, BASE), at('files/large/6.jpg'));
  assert.equal(pageUrl({ n: ['a b+c.jpg'] }, BASE), at('files/large/a%20b%2Bc.jpg'));
  assert.equal(
    pageUrl({ n: ['https://static.fliphtml5.com/x/1.jpg'] }, BASE),
    'https://static.fliphtml5.com/x/1.jpg',
  );
});

test('pageUrl: refuses containers, odd locations and foreign hosts', () => {
  for (const entry of [
    { n: ['6.zip'] },
    { n: ['files/content-page/7.zip'] },
    { n: ['8.PDF'] },
    { n: ['../secret.jpg'] },
    { n: ['files/../../x.jpg'] },
    { n: ['https://evil.example/1.jpg'] },
    { n: ['https://fliphtml5.com.evil.example/1.jpg'] },
    { n: [] },
    { n: [''] },
    {},
    null,
  ]) {
    assert.equal(pageUrl(entry, BASE), null, JSON.stringify(entry));
  }
});

test('readJpegInfo: reads size and colour model from real JPEG headers', () => {
  assert.deepEqual(readJpegInfo(jpegFixtures.baselineRgb), { width: 24, height: 16, components: 3, embeddable: true });
  assert.deepEqual(readJpegInfo(jpegFixtures.progressiveRgb), { width: 24, height: 16, components: 3, embeddable: true });
  assert.deepEqual(readJpegInfo(jpegFixtures.gray), { width: 24, height: 16, components: 1, embeddable: true });
  // CMYK can't be embedded safely, so it must be re-encoded by the caller.
  assert.deepEqual(readJpegInfo(jpegFixtures.cmyk), { width: 24, height: 16, components: 4, embeddable: false });
});

test('readJpegInfo: not a JPEG, or cut short, gives null', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(readJpegInfo(png), null);
  assert.equal(readJpegInfo(new Uint8Array()), null);
  assert.equal(readJpegInfo(jpegFixtures.baselineRgb.slice(0, 12)), null);
});

test('pageSizeFor: 150 dpi, capped at the PDF page limit', () => {
  const a4 = pageSizeFor(1240, 1754);
  assert.ok(Math.abs(a4.width - 595.2) < 0.01 && Math.abs(a4.height - 841.92) < 0.01);
  const huge = pageSizeFor(100000, 50000);
  assert.equal(huge.width, 14400);
  assert.equal(huge.height, 7200);
  assert.deepEqual(pageSizeFor(0, 0), { width: 1, height: 1 });
});

test('fetchBytes: retries transient failures, not permanent ones', async () => {
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return calls === 1 ? new Response('', { status: 503 }) : new Response(new Uint8Array([1, 2, 3]));
    };
    assert.deepEqual(await fetchBytes('https://x.test/a', { retries: 1 }), new Uint8Array([1, 2, 3]));
    assert.equal(calls, 2);

    calls = 0;
    globalThis.fetch = async () => (calls++, new Response('', { status: 404 }));
    await assert.rejects(fetchBytes('https://x.test/b', { retries: 3 }), (err) => err instanceof HttpError && err.status === 404);
    assert.equal(calls, 1);

    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new TypeError('Failed to fetch');
    };
    await assert.rejects(fetchBytes('https://x.test/c', { retries: 1 }), TypeError);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchBytes: cancelling stops immediately with the abort reason', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (url, { signal }) =>
      new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    const controller = new AbortController();
    const pending = fetchBytes('https://x.test/slow', { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (err) => err.name === 'AbortError');
    assert.equal(controller.signal.aborted, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- PDF writer -------------------------------------------------------------

function containsBytes(haystack, needle) {
  return Buffer.from(haystack).includes(Buffer.from(needle));
}

test('PdfDocument: well-formed file with a correct xref table', async () => {
  const doc = new PdfDocument({ title: 'Café – 日本語 📚', subject: 'Converted from https://fliphtml5.com/abcd/efgh/' });
  doc.addJpegPage({ bytes: jpegFixtures.baselineRgb, width: 24, height: 16, components: 3 });
  doc.addJpegPage({ bytes: jpegFixtures.gray, width: 24, height: 16, components: 1 });
  doc.addBlankPage(11.52, 7.68);
  assert.equal(doc.pageCount, 3);

  const bytes = new Uint8Array(await doc.toBlob().arrayBuffer());
  const text = Buffer.from(bytes).toString('latin1'); // 1 char = 1 byte, so string offsets are file offsets

  assert.ok(text.startsWith('%PDF-1.4\n%'));
  assert.ok(text.endsWith('%%EOF\n'));

  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 5), 'xref\n');
  const header = /^xref\n0 (\d+)\n/.exec(text.slice(startxref));
  const objectCount = Number(header[1]);
  assert.equal(objectCount, 4 + 3 * 2 + 2); // catalog+tree+info, 3 pages x (page+contents), 2 images, +1 for the free entry
  const table = startxref + header[0].length;
  assert.equal(text.substr(table, 20), '0000000000 65535 f \n');
  for (let id = 1; id < objectCount; id++) {
    const entry = text.substr(table + id * 20, 20);
    assert.match(entry, /^\d{10} 00000 n \n$/, `entry ${id}`);
    assert.ok(text.startsWith(`${id} 0 obj\n`, Number(entry.slice(0, 10))), `object ${id} offset`);
  }

  // JPEG data is embedded untouched.
  assert.ok(containsBytes(bytes, jpegFixtures.baselineRgb));
  assert.ok(containsBytes(bytes, jpegFixtures.gray));
  assert.match(text, /\/ColorSpace \/DeviceGray/);
  assert.match(text, /\/ColorSpace \/DeviceRGB/);
  assert.match(text, /\/Filter \/DCTDecode/);

  // Independent parser agrees.
  const parsed = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(parsed.getPageCount(), 3);
  assert.equal(parsed.getTitle(), 'Café – 日本語 📚');
  assert.deepEqual(parsed.getPage(0).getSize(), { width: 11.52, height: 7.68 });
  assert.deepEqual(parsed.getPage(2).getSize(), { width: 11.52, height: 7.68 });
});

test('PdfDocument: an empty document is still a valid file', async () => {
  const bytes = new Uint8Array(await new PdfDocument().toBlob().arrayBuffer());
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 0);
});

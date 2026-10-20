// The whole conversion: book config -> page images -> one PDF.

import { bookPageUrl, loadBook, UserError } from './flipbook.js';
import { fetchPageImage } from './images.js';
import { HttpError } from './net.js';
import { PdfDocument, pageSizeFor } from './pdf-writer.js';

const PAGE_CONCURRENCY = 6;

/**
 * Converts one book to a PDF Blob.
 * Pages that still fail after retries become blank placeholder pages and are
 * reported in `failedPages` (1-based) instead of aborting the whole book.
 */
export async function convertBook(ids, { signal, onBook, onCover, onProgress, onBuilding } = {}) {
  const book = await loadBook(ids, { signal });
  onBook?.(book);

  const total = book.pageUrls.length;
  const images = new Array(total).fill(null);
  const failedPages = [];
  let finished = 0;

  // Page 1 doubles as a probe: if it can't be fetched, nothing else will be either.
  try {
    images[0] = await fetchPageImage(book.pageUrls[0], { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new UserError(describeFirstPageFailure(err), 'first-page');
  }
  onCover?.(images[0]);
  onProgress?.(++finished, total);

  const remaining = Array.from({ length: total - 1 }, (_, i) => i + 1);
  await mapPool(remaining, PAGE_CONCURRENCY, signal, async (index) => {
    try {
      images[index] = await fetchPageImage(book.pageUrls[index], { signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      failedPages.push(index + 1);
    }
    onProgress?.(++finished, total);
  });
  failedPages.sort((a, b) => a - b);

  onBuilding?.();
  const document = new PdfDocument({ title: book.title, subject: `Converted from ${bookPageUrl(ids)}` });
  let size = pageSizeFor(images[0].width, images[0].height);
  for (const image of images) {
    if (image) {
      document.addJpegPage(image);
      size = pageSizeFor(image.width, image.height);
    } else {
      document.addBlankPage(size.width, size.height);
    }
  }
  return { title: book.title, blob: document.toBlob(), pageCount: total, failedPages };
}

function describeFirstPageFailure(err) {
  if (err instanceof HttpError) {
    return `FlipHTML5 refused the first page image (HTTP ${err.status}). This book may not be available for download.`;
  }
  if (err?.message === 'Unsupported image format') {
    return 'The first page isn’t an image this page can read, so the book can’t be converted.';
  }
  return 'The first page image couldn’t be downloaded. The connection may have dropped or the browser blocked the request. Please try again.';
}

// Runs `worker` over `items` with at most `limit` in flight.
async function mapPool(items, limit, signal, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      await worker(items[next++]);
    }
  });
  await Promise.all(runners);
}

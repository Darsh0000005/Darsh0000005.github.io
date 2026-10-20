// Turns downloaded page images into JPEG data that a PDF can embed.
// JPEGs are embedded byte-for-byte; anything else (WebP, PNG, ...) is
// re-encoded through a canvas.

import { fetchBytes } from './net.js';

const REENCODE_QUALITY = 0.95;

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
// Baseline, extended sequential and progressive: what PDF's DCTDecode reads.
const EMBEDDABLE_SOF = new Set([0xc0, 0xc1, 0xc2]);

export async function fetchPageImage(url, options) {
  return toJpegImage(await fetchBytes(url, options));
}

/** @returns {Promise<{bytes: Uint8Array, width: number, height: number, components: number}>} */
export async function toJpegImage(bytes) {
  const info = readJpegInfo(bytes);
  if (info?.embeddable) {
    return { bytes, width: info.width, height: info.height, components: info.components };
  }
  return reencode(bytes);
}

/**
 * Reads size and colour info from a JPEG header without decoding it.
 * Returns null if the bytes are not a JPEG with a readable frame header.
 */
export function readJpegInfo(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2; // markers without a length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // image data before any frame header
    if (SOF_MARKERS.has(marker)) {
      if (i + 10 > bytes.length) return null;
      const precision = bytes[i + 4];
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      const components = bytes[i + 9];
      return {
        width,
        height,
        components,
        embeddable:
          EMBEDDABLE_SOF.has(marker) &&
          precision === 8 &&
          width > 0 &&
          height > 0 &&
          (components === 1 || components === 3),
      };
    }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return null;
}

async function reencode(bytes) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes]));
  } catch {
    throw new Error('Unsupported image format');
  }
  try {
    const canvas = createCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; // flatten transparency onto white
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    const blob = await canvasToJpeg(canvas);
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    const info = readJpegInfo(jpeg);
    if (!info?.embeddable) throw new Error('Could not convert image');
    return { bytes: jpeg, width: info.width, height: info.height, components: info.components };
  } finally {
    bitmap.close?.();
  }
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToJpeg(canvas) {
  if (canvas.convertToBlob) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality: REENCODE_QUALITY });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not convert image'))),
      'image/jpeg',
      REENCODE_QUALITY,
    );
  });
}

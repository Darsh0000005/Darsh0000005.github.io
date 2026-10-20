// Talking to FlipHTML5: link parsing, book config, page list and page URLs.
// Every request goes straight from the visitor's browser to FlipHTML5.

import { fetchBytes, HttpError } from './net.js';

export const VIEWER_ORIGIN = 'https://online.fliphtml5.com';
export const MAX_PAGES = 2000;

// Newer books ship their page list encrypted. These are the two scripts
// FlipHTML5's own reader loads to decode it.
const ENGINE_SCRIPTS = [
  'https://static.fliphtml5.com/resourceFiles/html5_templates/js/jquery-4.0.0.min.js',
  'https://static.fliphtml5.com/resourceFiles/html5_templates/js/deString.js',
];
const ENGINE_TIMEOUT_MS = 15000;

const ID_PATTERN = /^[\p{L}\p{N}_.~-]{1,200}$/u;

/**
 * An error whose message is written to be shown to the person using the page.
 * `title` is the book's title, when it was already known by the time things went wrong.
 */
export class UserError extends Error {
  constructor(message, code = 'error', { title } = {}) {
    super(message);
    this.name = 'UserError';
    this.code = code;
    this.title = title;
  }
}

const MESSAGES = {
  protectedBook:
    'This book is marked private or protected by its publisher, so it can’t be converted here.',
  notFound:
    'FlipHTML5 has no public book at that link. It may be private, password-protected, or removed.',
  network:
    'Couldn’t reach FlipHTML5. Check your connection and any ad blocker or VPN, then try again.',
  badConfig:
    'This doesn’t look like a FlipHTML5 flipbook, or FlipHTML5 changed how it describes books.',
  engine:
    'Couldn’t load FlipHTML5’s page-list decoder. Check your connection and any ad blocker, then try again.',
  decode: 'Couldn’t read this book’s page list. FlipHTML5 may have changed its format.',
  noPages: 'This book has no pages to download.',
  unsupported: 'This book stores its pages in a protected format that can’t be converted here.',
};

const shorten = (text, max = 60) => (text.length > max ? `${text.slice(0, max)}…` : text);

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Splits pasted text into separate links (spaces, commas and new lines separate them). */
export function splitLinks(text) {
  return String(text ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

/**
 * Pulls the two book ids out of a FlipHTML5 link, e.g.
 * https://fliphtml5.com/abcd/efgh/Some-Title/ -> { id1: 'abcd', id2: 'efgh' }.
 * Throws UserError when the text is not a link to a single book.
 */
export function parseBookLink(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new UserError('Paste a FlipHTML5 link first.', 'invalid-link');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new UserError(`“${shorten(String(input).trim())}” is not a valid link.`, 'invalid-link');
  }

  const host = url.hostname.toLowerCase();
  if (!/^https?:$/.test(url.protocol) || (host !== 'fliphtml5.com' && !host.endsWith('.fliphtml5.com'))) {
    throw new UserError(`“${shorten(String(input).trim())}” is not a fliphtml5.com link.`, 'invalid-link');
  }

  const [id1, id2] = url.pathname.split('/').filter(Boolean).map(safeDecode);
  if (id1?.toLowerCase() === 'bookcase') {
    throw new UserError(
      'That link is a bookcase (a list of books). Open one book and paste its own link.',
      'invalid-link',
    );
  }
  if (!id1 || !id2) {
    throw new UserError(
      'A book link looks like https://fliphtml5.com/xxxx/yyyy/ — it needs two parts after the domain.',
      'invalid-link',
    );
  }
  if (![id1, id2].every((id) => ID_PATTERN.test(id) && id !== '.' && id !== '..')) {
    throw new UserError('That link contains characters a FlipHTML5 book link doesn’t use.', 'invalid-link');
  }
  return { id1, id2 };
}

/** Link to the book's public page, used for display and PDF metadata. */
export function bookPageUrl({ id1, id2 }) {
  return `https://fliphtml5.com/${encodeURIComponent(id1)}/${encodeURIComponent(id2)}/`;
}

/**
 * Loads a book's configuration and works out where every page image lives.
 * Throws UserError for anything the person using the page should hear about.
 */
export async function loadBook({ id1, id2 }, { signal } = {}) {
  const base = `${VIEWER_ORIGIN}/${encodeURIComponent(id1)}/${encodeURIComponent(id2)}/`;
  const config = parseHtmlConfig(await fetchConfigText(`${base}javascript/config.js`, signal));
  const title = cleanText(config.meta?.title) || id2;

  // The publisher's own "encrypted / private book" switch is honoured, never bypassed.
  if (isProtected(config)) throw new UserError(MESSAGES.protectedBook, 'protected', { title });

  let entries = config.fliphtml5_pages;
  if (typeof entries === 'string') entries = await decodePageList(entries, title);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new UserError(MESSAGES.noPages, 'no-pages', { title });
  }
  if (entries.length > MAX_PAGES) {
    throw new UserError(
      `This book has ${entries.length} pages, more than the ${MAX_PAGES} a browser can safely turn into one PDF here.`,
      'too-big',
      { title },
    );
  }

  const pageUrls = entries.map((entry) => pageUrl(entry, base));
  if (pageUrls.some((url) => url === null)) throw new UserError(MESSAGES.unsupported, 'unsupported', { title });

  return { id1, id2, title, pageUrls };
}

async function fetchConfigText(url, signal) {
  try {
    return new TextDecoder().decode(await fetchBytes(url, { signal }));
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof HttpError) {
      if ([403, 404, 410].includes(err.status)) throw new UserError(MESSAGES.notFound, 'not-found');
      throw new UserError(
        `FlipHTML5 answered with an error (${err.status}). Please try again in a moment.`,
        'http',
      );
    }
    throw new UserError(MESSAGES.network, 'network');
  }
}

/** Reads the `htmlConfig = {...}` object out of a book's config.js. */
export function parseHtmlConfig(source) {
  const assignment = /\bhtmlConfig\s*=\s*/.exec(source);
  const json = assignment && extractObject(source, assignment.index + assignment[0].length);
  if (!json) throw new UserError(MESSAGES.badConfig, 'bad-config');
  try {
    return JSON.parse(json);
  } catch {
    throw new UserError(MESSAGES.badConfig, 'bad-config');
  }
}

// Returns the balanced {...} starting at `from`, aware of quoted strings.
function extractObject(text, from) {
  if (text[from] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      return text.slice(from, i + 1);
    }
  }
  return null;
}

function isProtected(config) {
  const on = (value) => value === true || value === 1 || value === '1' || value === 'true';
  return [config.loadingConfig, config.bookConfig, config].some((section) => on(section?.isEncryptionBook));
}

/**
 * Works out the full URL of one page image from its page-list entry
 * ({ n: ['1.webp'], t: '...' }). Returns null when the page can't be used:
 * unknown location, or a ZIP/PDF container (FlipHTML5's protected format).
 */
export function pageUrl(entry, base) {
  const name = Array.isArray(entry?.n) ? entry.n[0] : entry?.n;
  if (typeof name !== 'string' || !name.trim()) return null;
  const cleaned = name.trim().replace(/\\/g, '/');
  if (isContainer(cleaned)) return null;

  if (/^https?:\/\//i.test(cleaned)) return isFlipHtml5Host(cleaned) ? cleaned : null;

  let path = cleaned.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (path.split('/').includes('..')) return null;
  path = path.replace(/^files\/large\//, '');
  if (!path.startsWith('files/')) path = `files/large/${path}`;

  const encoded = path
    .split('/')
    .map((segment) => encodeURIComponent(safeDecode(segment)))
    .join('/');
  return new URL(encoded, base).href;
}

const isContainer = (path) => /\.(zip|pdf)$/i.test(path);

function isFlipHtml5Host(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'fliphtml5.com' || host.endsWith('.fliphtml5.com');
  } catch {
    return false;
  }
}

// Titles may carry HTML entities (&amp; ...); a detached textarea decodes them safely.
function cleanText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text.includes('&') || typeof document === 'undefined') return text;
  const decoder = document.createElement('textarea');
  decoder.innerHTML = text;
  return decoder.value.trim();
}

// ---- Page-list decoding ---------------------------------------------------

let enginePromise = null;

async function decodePageList(encrypted, title) {
  try {
    await loadEngine();
  } catch {
    throw new UserError(MESSAGES.engine, 'engine', { title });
  }
  try {
    const decoded = window.UTF8ToString(window.Module._DeString(window.allocateUTF8(encrypted)));
    // The decoder can leave trailing bytes after the JSON array.
    const end = decoded.lastIndexOf(']');
    return JSON.parse(end > 0 ? decoded.slice(0, end + 1) : decoded);
  } catch {
    throw new UserError(MESSAGES.decode, 'decode', { title });
  }
}

function loadEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      for (const [index, src] of ENGINE_SCRIPTS.entries()) {
        try {
          await loadScript(src);
        } catch (err) {
          // jQuery is loaded first only because FlipHTML5's reader does; the decoder is what matters.
          if (index === ENGINE_SCRIPTS.length - 1) throw err;
        }
      }
      await waitFor(
        () => window.allocateUTF8 && window.Module?._DeString && window.UTF8ToString,
        ENGINE_TIMEOUT_MS,
      );
    })().catch((err) => {
      enginePromise = null;
      throw err;
    });
  }
  return enginePromise;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => fail(new Error(`Timed out loading ${src}`)), ENGINE_TIMEOUT_MS);
    const fail = (err) => {
      clearTimeout(timer);
      script.remove();
      reject(err);
    };
    script.src = src;
    script.async = true;
    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => fail(new Error(`Failed to load ${src}`));
    document.head.append(script);
  });
}

function waitFor(isReady, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (isReady()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for the decoder'));
      }
    }, 100);
  });
}

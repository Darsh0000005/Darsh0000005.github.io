// The page itself: link form, conversion queue and task cards.

import { convertBook } from './convert.js';
import { parseBookLink, splitLinks, UserError } from './flipbook.js';

const MAX_PARALLEL = 2;
const AUTO_DOWNLOAD_KEY = 'fliphtml5-pdf.autoDownload';
const MAX_LISTED_PAGES = 10;
const NON_RETRYABLE = new Set(['protected', 'unsupported', 'too-big', 'no-pages']);

const form = document.querySelector('#link-form');
const input = document.querySelector('#link-input');
const formError = document.querySelector('#form-error');
const autoDownload = document.querySelector('#auto-download');
const queueSection = document.querySelector('#queue-section');
const taskList = document.querySelector('#task-list');
const template = document.querySelector('#task-template');
const liveRegion = document.querySelector('#live');

const tasks = []; // newest first

// ---- Preferences ----------------------------------------------------------

try {
  autoDownload.checked = localStorage.getItem(AUTO_DOWNLOAD_KEY) !== '0';
} catch {
  // Storage can be blocked (private mode); the default stays on.
}
autoDownload.addEventListener('change', () => {
  try {
    localStorage.setItem(AUTO_DOWNLOAD_KEY, autoDownload.checked ? '1' : '0');
  } catch {
    // Not worth bothering anyone about.
  }
});

// ---- Form -----------------------------------------------------------------

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const links = splitLinks(input.value);
  const problems = [];
  const unusable = [];

  if (links.length === 0) problems.push('Paste a FlipHTML5 link first.');
  for (const link of links) {
    try {
      const ids = parseBookLink(link);
      if (isListed(ids)) problems.push(`“${ids.id2}” is already in your list.`);
      else addTask(ids);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      problems.push(err.message);
      unusable.push(link);
    }
  }

  showFormProblems(problems);
  input.value = unusable.join(' '); // keep only what still needs fixing
  input.focus();
  pump();
});

function showFormProblems(problems) {
  formError.replaceChildren(
    ...problems.map((message) => Object.assign(document.createElement('p'), { textContent: message })),
  );
  formError.hidden = problems.length === 0;
}

// ---- Tasks ----------------------------------------------------------------

function isListed({ id1, id2 }) {
  return tasks.some(
    (task) => task.key === `${id1}/${id2}` && ['queued', 'working', 'done'].includes(task.state),
  );
}

function addTask(ids) {
  const task = {
    ids,
    key: `${ids.id1}/${ids.id2}`,
    state: 'queued',
    stage: '',
    title: ids.id2,
    total: 0,
    done: 0,
    failedPages: [],
    error: '',
    retryable: true,
    blobUrl: '',
    coverUrl: '',
    filename: '',
    size: 0,
    controller: null,
    frame: 0,
    el: template.content.firstElementChild.cloneNode(true),
  };
  tasks.unshift(task);
  taskList.prepend(task.el);
  queueSection.hidden = false;
  paint(task);
}

// Starts queued tasks (oldest first) until MAX_PARALLEL are running.
function pump() {
  let running = tasks.filter((task) => task.state === 'working').length;
  for (const task of [...tasks].reverse()) {
    if (running >= MAX_PARALLEL) return;
    if (task.state === 'queued') {
      run(task);
      running++;
    }
  }
}

async function run(task) {
  const controller = new AbortController();
  Object.assign(task, { state: 'working', stage: 'lookup', done: 0, controller });
  render(task);
  try {
    const result = await convertBook(task.ids, {
      signal: controller.signal,
      onBook(book) {
        Object.assign(task, { title: book.title, total: book.pageUrls.length, stage: 'pages' });
        render(task);
      },
      onCover(image) {
        revoke(task.coverUrl);
        task.coverUrl = URL.createObjectURL(new Blob([image.bytes], { type: 'image/jpeg' }));
        render(task);
      },
      onProgress(done) {
        task.done = done;
        render(task);
      },
      onBuilding() {
        task.stage = 'build';
        render(task);
      },
    });
    finish(task, result);
  } catch (err) {
    fail(task, err, controller.signal.aborted);
  } finally {
    task.controller = null;
    pump();
  }
}

function finish(task, { title, blob, pageCount, failedPages }) {
  if (!tasks.includes(task)) return; // removed while it was finishing
  revoke(task.blobUrl);
  Object.assign(task, {
    state: 'done',
    title,
    total: pageCount,
    done: pageCount,
    failedPages,
    blobUrl: URL.createObjectURL(blob),
    size: blob.size,
    filename: fileNameFor(title, task.ids.id2),
  });
  paint(task);
  announce(`${title} is ready.`);
  if (autoDownload.checked) saveFile(task);
}

function fail(task, err, cancelled) {
  if (!tasks.includes(task)) return; // removed by the user; nothing left to report
  if (cancelled) {
    task.state = 'cancelled';
    announce('Conversion cancelled.');
  } else {
    const known = err instanceof UserError;
    if (!known) console.error(err);
    Object.assign(task, {
      state: 'error',
      title: (known && err.title) || task.title,
      error: known ? err.message : 'Something went wrong while converting this book. Please try again.',
      retryable: !(known && NON_RETRYABLE.has(err.code)),
    });
    announce(`Could not convert ${task.title}.`);
  }
  paint(task);
}

taskList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  const task = button && tasks.find((candidate) => candidate.el === button.closest('.task'));
  if (!task) return;
  switch (button.dataset.action) {
    case 'download':
      saveFile(task);
      break;
    case 'cancel':
      cancel(task);
      break;
    case 'retry':
      revoke(task.blobUrl);
      Object.assign(task, { state: 'queued', error: '', failedPages: [], done: 0, blobUrl: '' });
      paint(task);
      pump();
      break;
    case 'remove':
      remove(task);
      break;
  }
});

function cancel(task) {
  if (task.state === 'working') task.controller?.abort();
  else if (task.state === 'queued') {
    task.state = 'cancelled';
    paint(task);
  }
}

function remove(task) {
  task.controller?.abort();
  cancelAnimationFrame(task.frame);
  revoke(task.blobUrl);
  revoke(task.coverUrl);
  tasks.splice(tasks.indexOf(task), 1);
  task.el.remove();
  queueSection.hidden = tasks.length === 0;
  input.focus();
  pump();
}

function saveFile(task) {
  const link = document.createElement('a');
  link.href = task.blobUrl;
  link.download = task.filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

window.addEventListener('beforeunload', (event) => {
  if (tasks.some((task) => task.state === 'working')) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// ---- Rendering ------------------------------------------------------------

// Progress events can arrive hundreds of times a second; paint at most once per frame.
function render(task) {
  if (task.frame) return;
  task.frame = requestAnimationFrame(() => {
    task.frame = 0;
    paint(task);
  });
}

function part(task, name) {
  return task.el.querySelector(`[data-part="${name}"]`);
}

function paint(task) {
  const { el } = task;
  el.dataset.state = task.state;
  el.dataset.retryable = String(task.retryable);
  el.dataset.partial = String(task.state === 'done' && task.failedPages.length > 0);

  const title = part(task, 'title');
  title.textContent = task.title;
  title.title = task.title; // full text on hover when the card truncates it
  part(task, 'status').textContent = statusText(task);

  const cover = part(task, 'cover');
  cover.hidden = !task.coverUrl;
  if (task.coverUrl && cover.getAttribute('src') !== task.coverUrl) cover.src = task.coverUrl;

  const bar = el.querySelector('.bar');
  const percent = progressPercent(task);
  bar.hidden = percent === 0 && (task.state === 'error' || task.state === 'cancelled');
  bar.toggleAttribute('data-indeterminate', percent === null);
  if (percent === null) bar.removeAttribute('aria-valuenow');
  else bar.setAttribute('aria-valuenow', String(percent));
  part(task, 'fill').style.width = percent === null ? '' : `${percent}%`;

  const note = noteText(task);
  const noteEl = part(task, 'note');
  noteEl.textContent = note;
  noteEl.hidden = !note;
  noteEl.dataset.kind = task.state === 'error' ? 'error' : 'warning';
}

function progressPercent(task) {
  switch (task.state) {
    case 'queued':
      return 0;
    case 'working':
      if (task.stage === 'lookup') return null;
      if (task.stage === 'build') return 100;
      return task.total ? Math.min(99, Math.round((task.done / task.total) * 100)) : null;
    case 'done':
      return 100;
    default:
      return task.total ? Math.round((task.done / task.total) * 100) : 0;
  }
}

function statusText(task) {
  switch (task.state) {
    case 'queued':
      return 'Waiting in line…';
    case 'working':
      if (task.stage === 'lookup') return 'Looking up the book…';
      if (task.stage === 'build') return 'Building the PDF…';
      return `Downloading pages · ${task.done} of ${task.total}`;
    case 'done':
      return `Ready · ${task.total} ${task.total === 1 ? 'page' : 'pages'} · ${formatBytes(task.size)}`;
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Couldn’t convert this book';
  }
}

function noteText(task) {
  if (task.state === 'error') return task.error;
  if (task.state === 'done' && task.failedPages.length > 0) {
    const shown = task.failedPages.slice(0, MAX_LISTED_PAGES).join(', ');
    const more = task.failedPages.length > MAX_LISTED_PAGES ? ', …' : '';
    const count = task.failedPages.length;
    return `${count} ${count === 1 ? 'page' : 'pages'} couldn’t be downloaded (${shown}${more}) and ${count === 1 ? 'was' : 'were'} replaced with blank pages. Try again to fill ${count === 1 ? 'it' : 'them'} in.`;
  }
  return '';
}

// ---- Helpers --------------------------------------------------------------

function revoke(url) {
  if (url) URL.revokeObjectURL(url);
}

function announce(message) {
  liveRegion.textContent = message;
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileNameFor(title, fallback) {
  const base = (title || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return `${base || fallback}.pdf`;
}

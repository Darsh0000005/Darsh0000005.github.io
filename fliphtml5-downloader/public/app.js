// FlipHTML5 to PDF: runs entirely in the browser.
// The page-decoding logic is ported from nyr-github/fliphtml5-downloader (MIT).
(() => {
  "use strict";

  const ONLINE = "https://online.fliphtml5.com";
  const PROXY = "/api/proxy?url=";
  const DESTRING_DEPS = [
    "https://static.fliphtml5.com/resourceFiles/html5_templates/js/jquery-4.0.0.min.js",
    "https://static.fliphtml5.com/resourceFiles/html5_templates/js/deString.js",
  ];
  const PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const CONCURRENCY = 4;
  const PX_TO_PT = 0.75;
  const MAX_PT = 14400; // largest page side a PDF allows

  const QUALITY = {
    best: { maxSide: Infinity, jpeg: 0.92, pdfScale: 2.5 },
    balanced: { maxSide: 2000, jpeg: 0.85, pdfScale: 2 },
    small: { maxSide: 1400, jpeg: 0.7, pdfScale: 1.5 },
  };

  const form = document.getElementById("form");
  const input = document.getElementById("url");
  const qualitySelect = document.getElementById("quality");
  const tasksEl = document.getElementById("tasks");
  const tpl = document.getElementById("task-tpl");

  if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;

  let running = 0;
  // Once a direct request fails (usually CORS), send the rest through the proxy.
  let directWorks = true;

  // ---------- networking ----------

  async function fetchFlip(url) {
    if (directWorks) {
      try {
        const res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
        if (res.ok) return res;
      } catch {
        directWorks = false;
      }
    }
    let res;
    try {
      res = await fetch(PROXY + encodeURIComponent(url));
    } catch {
      throw new Error("Network error. Check your connection and try again.");
    }
    if (!res.ok) {
      if (res.status === 404) throw new Error("Not found on FlipHTML5. Check the link.");
      throw new Error(`FlipHTML5 returned an error (${res.status}).`);
    }
    return res;
  }

  function loadScript(src) {
    if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Couldn't load ${src}`));
      document.body.appendChild(s);
    });
  }

  function waitFor(test, timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (test()) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error("The page decoder timed out. Refresh and try again."));
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  // ---------- book config ----------

  function parseBookUrl(raw) {
    let u;
    try {
      u = new URL(raw.trim());
    } catch {
      return null;
    }
    if (!/(^|\.)fliphtml5\.com$/i.test(u.hostname)) return null;
    const [id1, id2] = u.pathname.split("/").filter(Boolean);
    if (!id1 || !id2 || id1 === "bookcase") return null;
    if (!/^[\w-]+$/.test(id1) || !/^[\w-]+$/.test(id2)) return null;
    return { id1, id2 };
  }

  // config.js holds `htmlConfig = {...};`. Try each `};` as the end of the
  // object, then fall back to the last `}` in the file.
  function parseConfig(text) {
    const at = text.search(/htmlConfig\s*=\s*\{/);
    if (at < 0) throw new Error("Couldn't read this book's configuration.");
    const start = text.indexOf("{", at);
    const ends = [];
    const re = /\}\s*;/g;
    re.lastIndex = start;
    for (let m; (m = re.exec(text)); ) ends.push(m.index);
    ends.push(text.lastIndexOf("}"));
    for (const end of ends) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // keep looking
      }
    }
    throw new Error("Couldn't read this book's configuration.");
  }

  // Newer books ship the page list encrypted; FlipHTML5's own WASM decoder
  // (deString.js) turns it back into JSON.
  async function decryptPages(encrypted) {
    for (const src of DESTRING_DEPS) await loadScript(src);
    await waitFor(
      () => window.allocateUTF8 && window.UTF8ToString && window.Module && window.Module._DeString,
      15000,
    );
    let out = window.UTF8ToString(window.Module._DeString(window.allocateUTF8(encrypted)));
    const end = out.lastIndexOf("]");
    if (end > 0) out = out.slice(0, end + 1);
    return JSON.parse(out);
  }

  function cleanPath(p) {
    return String(p).replace(/\\/g, "/").replace(/^\/+/, "");
  }

  function pageUrl(base, page) {
    const raw = Array.isArray(page.n) ? page.n[0] : page.n;
    if (/^https?:\/\//i.test(raw)) return raw;
    const rel = cleanPath(raw).replace("files/large/", "").replace("./", "");
    if (rel.includes("files/content-page")) return base + rel;
    if (isZip(rel)) return base + "files/content-page/" + rel;
    return base + "files/large/" + rel;
  }

  function thumbUrl(base, t) {
    if (!t) return "";
    if (/^https?:\/\//i.test(t)) return t;
    return base + cleanPath(t).replace(/\.\//g, "");
  }

  function isZip(url) {
    return /\.zip(\?|#|$)/i.test(url);
  }

  async function loadBook({ id1, id2 }) {
    const base = `${ONLINE}/${id1}/${id2}/`;
    const text = await (await fetchFlip(base + "javascript/config.js")).text();
    const config = parseConfig(text);

    if (config.loadingConfig && config.loadingConfig.isEncryptionBook === true) {
      throw new Error("This book is private or encrypted, so it can't be downloaded.");
    }

    let pages = config.fliphtml5_pages;
    if (typeof pages === "string") pages = await decryptPages(pages);
    if (!Array.isArray(pages) || pages.length === 0) throw new Error("This book has no pages to download.");

    const meta = config.meta || {};
    return {
      title: (meta.title || id2).trim(),
      pageWidth: Number(meta.pageWidth) || 0,
      cover: thumbUrl(base, pages[0].t),
      urls: pages.map((p) => pageUrl(base, p)),
    };
  }

  // ---------- page rendering ----------

  function canvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        async (blob) => {
          if (!blob) return reject(new Error("Couldn't encode the page image."));
          resolve(new Uint8Array(await blob.arrayBuffer()));
        },
        "image/jpeg",
        quality,
      );
    });
  }

  function whiteCanvas(w, h) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    return { canvas, ctx };
  }

  async function decodeImage(blob) {
    if (window.createImageBitmap) {
      try {
        return await createImageBitmap(blob);
      } catch {
        // fall back to <img> below
      }
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function imagePage(url, q) {
    const blob = await (await fetchFlip(url)).blob();
    const img = await decodeImage(blob);
    const w = img.width;
    const h = img.height;
    const scale = Math.min(1, q.maxSide / Math.max(w, h));

    // Keep the original bytes when there is nothing to change.
    if (scale === 1 && q.maxSide === Infinity && /jpe?g/i.test(blob.type)) {
      if (img.close) img.close();
      return [{ bytes: new Uint8Array(await blob.arrayBuffer()), w, h }];
    }

    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const { canvas, ctx } = whiteCanvas(cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    if (img.close) img.close();
    const bytes = await canvasToJpeg(canvas, q.jpeg);
    canvas.width = canvas.height = 0;
    return [{ bytes, w: cw, h: ch }];
  }

  // "Zip" pages are actually obfuscated, password-protected PDFs: the PDF sits
  // between byte 1083 and size-1003, its first 4000 bytes are inverted, and
  // the password is stored in the 3 bytes either side of it.
  function unwrapZipPage(buf) {
    const bytes = new Uint8Array(buf);
    const size = bytes.length;
    if (size < 2100) throw new Error("Page file is too small.");
    const dec = new TextDecoder();
    const password = dec.decode(bytes.subarray(1080, 1083)) + dec.decode(bytes.subarray(size - 1003, size - 1000));
    const data = bytes.slice(1083, size - 1003);
    const n = Math.min(4000, data.length);
    for (let i = 0; i < n; i++) data[i] = 255 - data[i];
    return { data, password };
  }

  async function zipPage(url, q) {
    if (!window.pdfjsLib) throw new Error("The PDF reader didn't load. Refresh and try again.");
    const buf = await (await fetchFlip(url)).arrayBuffer();
    const { data, password } = unwrapZipPage(buf);
    const doc = await window.pdfjsLib.getDocument({ data, password }).promise;
    const out = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(q.pdfScale, q.maxSide / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        const { canvas, ctx } = whiteCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: ctx, viewport }).promise;
        out.push({ bytes: await canvasToJpeg(canvas, q.jpeg), w: canvas.width, h: canvas.height });
        canvas.width = canvas.height = 0;
        page.cleanup();
      }
    } finally {
      doc.destroy();
    }
    return out;
  }

  // ---------- PDF assembly ----------

  async function buildPdf(book, q, onProgress) {
    const { jsPDF } = window.jspdf;
    const total = book.urls.length;
    const results = new Array(total);
    let next = 0;
    let added = 0;
    let done = 0;
    let failed = 0;
    let doc = null;

    const addPage = ({ bytes, w, h }) => {
      let pw = (book.pageWidth || w) * PX_TO_PT;
      let ph = pw * (h / w);
      const fit = Math.min(1, MAX_PT / Math.max(pw, ph));
      pw *= fit;
      ph *= fit;
      const orientation = pw > ph ? "l" : "p";
      if (!doc) doc = new jsPDF({ unit: "pt", format: [pw, ph], orientation });
      else doc.addPage([pw, ph], orientation);
      doc.addImage(bytes, "JPEG", 0, 0, pw, ph, undefined, "NONE");
      added++;
    };

    // Pages finish out of order; add them to the PDF in order as soon as
    // the next one is ready so finished images don't pile up in memory.
    const flush = () => {
      while (next < total && results[next] !== undefined) {
        for (const p of results[next]) addPage(p);
        results[next] = null;
        next++;
      }
    };

    let cursor = 0;
    const worker = async () => {
      while (cursor < total) {
        const i = cursor++;
        const url = book.urls[i];
        try {
          results[i] = isZip(url) ? await zipPage(url, q) : await imagePage(url, q);
        } catch (err) {
          console.warn(`Page ${i + 1} failed:`, err);
          results[i] = [];
          failed++;
        }
        done++;
        flush();
        onProgress(done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

    if (!doc || added === 0) {
      throw new Error("None of the pages could be downloaded. FlipHTML5 may be blocking requests right now.");
    }
    return { blob: doc.output("blob"), failed };
  }

  // ---------- UI ----------

  function createTask(label) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const titleEl = el.querySelector(".title");
    const statusEl = el.querySelector(".status");
    const barEl = el.querySelector(".bar span");
    const actionsEl = el.querySelector(".task-actions");
    const coverEl = el.querySelector(".cover");
    titleEl.textContent = label;
    tasksEl.prepend(el);

    return {
      title(t) {
        titleEl.textContent = t;
        titleEl.title = t;
      },
      cover(src) {
        if (!src) return;
        coverEl.referrerPolicy = "no-referrer";
        coverEl.onload = () => (coverEl.hidden = false);
        coverEl.src = src;
      },
      status(t) {
        statusEl.textContent = t;
      },
      progress(frac) {
        barEl.style.width = `${Math.round(frac * 100)}%`;
      },
      state(s) {
        el.classList.remove("done", "error");
        if (s) el.classList.add(s);
      },
      action(node) {
        actionsEl.append(node);
      },
      remove() {
        el.remove();
      },
    };
  }

  function safeFilename(name) {
    const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    return (cleaned || "fliphtml5-book") + ".pdf";
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    return url;
  }

  async function run(rawUrl) {
    const ids = parseBookUrl(rawUrl);
    const task = createTask(ids ? ids.id2 : rawUrl);
    if (!ids) {
      task.state("error");
      task.status("That doesn't look like a FlipHTML5 book link. It should look like fliphtml5.com/abcde/fghi/.");
      return;
    }

    const q = QUALITY[qualitySelect.value] || QUALITY.balanced;
    running++;
    try {
      task.status("Reading book details...");
      const book = await loadBook(ids);
      task.title(book.title);
      task.cover(book.cover);
      task.status(`Downloading ${book.urls.length} pages...`);

      const { blob, failed } = await buildPdf(book, q, (done, total) => {
        task.progress(done / total);
        task.status(`Page ${done} of ${total}`);
      });

      const filename = safeFilename(book.title);
      const blobUrl = saveBlob(blob, filename);
      const mb = (blob.size / 1048576).toFixed(1);
      task.progress(1);
      task.state("done");
      task.status(
        failed
          ? `Saved ${filename} (${mb} MB). ${failed} page${failed === 1 ? "" : "s"} couldn't be downloaded and ${failed === 1 ? "was" : "were"} skipped.`
          : `Saved ${filename} (${mb} MB).`,
      );

      const again = document.createElement("a");
      again.className = "btn";
      again.href = blobUrl;
      again.download = filename;
      again.textContent = "Save PDF again";
      task.action(again);
    } catch (err) {
      console.error(err);
      task.state("error");
      task.status(err && err.message ? err.message : "Something went wrong.");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn ghost";
      retry.textContent = "Try again";
      retry.onclick = () => {
        task.remove();
        run(rawUrl);
      };
      task.action(retry);
    } finally {
      running--;
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    input.value = "";
    run(value);
  });

  window.addEventListener("beforeunload", (e) => {
    if (running > 0) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  const shared = new URLSearchParams(location.search).get("url");
  if (shared) input.value = shared;
})();

// Liquid glass extras on top of the CSS glass in style.css:
// 1. Elements marked data-lens get a clear rim that magnifies and bends the
//    backdrop, around a frosted middle that keeps text readable. This needs
//    SVG filters as backdrop filters, which only Chromium supports, so
//    elsewhere the frosted CSS glass is used as is.
// 2. Each glass rim's highlight turns toward the pointer.
(() => {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const chromium = brands.some((b) => b.brand === "Chromium");
  const lessGlass = matchMedia("(prefers-reduced-transparency: reduce)");

  // Map for a rounded rectangle. Within `bezel` px of the edge, R/G (offsets
  // around 128) sample the backdrop from further inside, strongest at the
  // rim, which magnifies it like the curved edge of a lens. B is how much of
  // that clear rim shows over the frosted middle.
  function displacementMap(w, h, radius, bezel) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(w, h);
    const px = image.data;
    const hw = w / 2;
    const hh = h / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const lx = x + 0.5 - hw;
        const ly = y + 0.5 - hh;
        const qx = Math.abs(lx) - (hw - radius);
        const qy = Math.abs(ly) - (hh - radius);
        let inside;
        let nx;
        let ny;
        if (qx > 0 && qy > 0) {
          const len = Math.hypot(qx, qy);
          inside = radius - len;
          nx = (qx / len) * Math.sign(lx);
          ny = (qy / len) * Math.sign(ly);
        } else if (qx > qy) {
          inside = radius - qx;
          nx = Math.sign(lx);
          ny = 0;
        } else {
          inside = radius - qy;
          nx = 0;
          ny = Math.sign(ly);
        }
        let dx = 0;
        let dy = 0;
        let rim = 0;
        if (inside >= 0 && inside < bezel) {
          const t = 1 - inside / bezel;
          const mag = t * t;
          dx = -nx * mag;
          dy = -ny * mag;
          rim = t * t * (3 - 2 * t);
        }
        const i = (y * w + x) * 4;
        px[i] = 128 + dx * 127;
        px[i + 1] = 128 + dy * 127;
        px[i + 2] = rim * 255;
        px[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL();
  }

  function setupLenses() {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    document.body.append(svg);

    const render = (el) => {
      const lens = el._lens;
      const w = Math.round(el.offsetWidth);
      const h = Math.round(el.offsetHeight);
      if (!w || !h || (w === lens.w && h === lens.h)) return;
      lens.w = w;
      lens.h = h;
      const style = getComputedStyle(el);
      const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, w / 2, h / 2);
      const bezel = Math.min(30, h * 0.3, w * 0.3);
      lens.image.setAttribute("href", displacementMap(w, h, radius, bezel));
      lens.image.setAttribute("width", w);
      lens.image.setAttribute("height", h);
      // Offsets up to 0.3 x bezel: about 2.5x magnification at the rim,
      // and well short of folding over (which starts at 0.5 x bezel).
      lens.map.setAttribute("scale", (bezel * 0.6).toFixed(1));
      lens.frost.setAttribute("stdDeviation", parseFloat(style.getPropertyValue("--frost")) || 8);
      el.style.setProperty("--lens", `url(#${lens.id})`);
      el.classList.add("lensed");
    };

    const node = (name, attrs) => {
      const n = document.createElementNS(NS, name);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) render(entry.target);
    });

    // Per element: frosted copy of the backdrop, a bent copy, and the bent
    // copy laid over the frost only along the rim (mask from the map's B).
    let n = 0;
    for (const el of document.querySelectorAll("[data-lens]")) {
      const id = `lens-${++n}`;
      const filter = node("filter", { id, "color-interpolation-filters": "sRGB" });
      const image = node("feImage", { x: 0, y: 0, preserveAspectRatio: "none", result: "map" });
      const frost = node("feGaussianBlur", { in: "SourceGraphic", edgeMode: "duplicate", result: "frost" });
      const map = node("feDisplacementMap", { in: "SourceGraphic", in2: "map", xChannelSelector: "R", yChannelSelector: "G", result: "bent" });
      filter.append(
        image,
        frost,
        map,
        node("feGaussianBlur", { in: "bent", stdDeviation: 0.6, result: "smooth" }),
        node("feColorMatrix", { in: "map", type: "matrix", values: "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0", result: "rim" }),
        node("feComposite", { in: "smooth", in2: "rim", operator: "in", result: "clearRim" }),
        node("feComposite", { in: "clearRim", in2: "frost", operator: "over" }),
      );
      svg.append(filter);
      el._lens = { id, image, map, frost, w: 0, h: 0 };
      observer.observe(el);
    }
  }

  // The refraction filter re-runs every frame, so keep it to computers
  // (mouse or trackpad, 4+ cores); phones get the frosted glass.
  const capable = matchMedia("(pointer: fine)").matches && (navigator.hardwareConcurrency || 4) >= 4;
  if (chromium && capable && !lessGlass.matches && "ResizeObserver" in window) setupLenses();

  // ---------- rim light that follows the pointer ----------

  let pointer = null;
  let queued = false;

  function aimLights() {
    queued = false;
    if (!pointer) return;
    for (const el of document.querySelectorAll(".glass")) {
      const r = el.getBoundingClientRect();
      if (r.bottom < -50 || r.top > innerHeight + 50) continue;
      let angle = (Math.atan2(pointer.x - (r.left + r.width / 2), r.top + r.height / 2 - pointer.y) * 180) / Math.PI;
      // Unwrap so the highlight turns the short way round.
      const prev = el._light ?? -45;
      while (angle - prev > 180) angle -= 360;
      while (angle - prev < -180) angle += 360;
      el._light = angle;
      el.style.setProperty("--light", `${angle.toFixed(1)}deg`);
    }
  }

  function queue() {
    if (!queued) {
      queued = true;
      requestAnimationFrame(aimLights);
    }
  }

  addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse") return;
      pointer = { x: e.clientX, y: e.clientY };
      queue();
    },
    { passive: true },
  );
  addEventListener("scroll", queue, { passive: true });
})();

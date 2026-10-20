// Liquid glass, in three parts:
// 1. Clear glass for panels and cards, in every browser (including Safari
//    on iPhone): the page background is a known pattern (colour blobs and a
//    dot grid), so each glass element gets a canvas showing the background
//    behind it as seen through glass: bent and magnified at the rim with a
//    little colour fringing, lightly frosted in the middle. The background
//    scrolls with the page, so a canvas only needs redrawing when the layout
//    changes. Without WebGL, the frosted CSS glass in style.css is used.
// 2. The floating nav has page content moving under it, so it keeps CSS
//    backdrop blur; in Chromium on computers it also gets a refracting rim
//    from an SVG filter (Safari can't use SVG filters as backdrop filters).
// 3. Each glass rim's highlight turns toward the pointer, or on touch
//    screens toward a light above the screen, so it shifts as you scroll.
(() => {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const root = document.documentElement;
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const lessGlass = matchMedia("(prefers-reduced-transparency: reduce)");
  const GRID = 24; // dot grid spacing, px

  // ---------- helpers ----------

  function parseColor(text) {
    const s = text.trim();
    if (s.startsWith("#")) {
      const hex = s.length === 4 ? s.slice(1).replace(/./g, "$&$&") : s.slice(1, 7);
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).concat(1);
    }
    const n = (s.match(/[\d.]+/g) || []).map(Number);
    return [n[0] / 255, n[1] / 255, n[2] / 255, n.length > 3 ? n[3] : 1];
  }

  const css = (name, el = root) => getComputedStyle(el).getPropertyValue(name);

  // Position in the document, ignoring transforms (entrance animations, hover
  // lifts), so the background behind an element is where it settles.
  function docBox(el) {
    let x = 0;
    let y = 0;
    for (let n = el; n; n = n.offsetParent) {
      x += n.offsetLeft;
      y += n.offsetTop;
    }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }

  // ---------- 1. clear glass ----------

  const VERT = "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }";

  const FRAG = `
precision highp float;
uniform float uTop;       // drawing buffer height, device px (gl_FragCoord
                          // counts from the buffer's corner, not the viewport's)
uniform float uDpr;
uniform vec2 uOrigin;     // element top-left in the document, css px
uniform vec2 uSize;       // element size, css px
uniform float uRadius;
uniform float uBezel;     // width of the refracting rim
uniform float uFrost;     // softening of the dot grid seen through the middle
uniform vec4 uTint;       // rgb + amount
uniform vec3 uGrade;      // saturation, brightness, rim glow
uniform vec3 uBase;
uniform vec4 uGrid;
uniform vec4 uBlob[10];   // centre xy, radii zw (document px)
uniform vec4 uBlobColor[10];
uniform int uBlobs;

// The page background, exactly as the CSS draws it.
vec3 scene(vec2 p, float soft) {
  vec3 c = uBase;
  for (int i = 0; i < 10; i++) {
    if (i >= uBlobs) break;
    vec2 d = (p - uBlob[i].xy) / uBlob[i].zw;
    c = mix(c, uBlobColor[i].rgb, uBlobColor[i].a * clamp(1.0 - length(d) / 0.7, 0.0, 1.0));
  }
  float r = length(mod(p, ${GRID.toFixed(1)}) - ${(GRID / 2).toFixed(1)});
  float g;
  if (soft < 0.05) {
    g = 1.0 - clamp((r - 1.2) / 0.5, 0.0, 1.0);
  } else {
    float s = 0.55 + soft;
    g = min(1.0, 2.1 / (2.0 * s * s)) * exp(-r * r / (2.0 * s * s));
  }
  return mix(c, uGrid.rgb, uGrid.a * g);
}

void main() {
  vec2 local = vec2(gl_FragCoord.x, uTop - gl_FragCoord.y) / uDpr;
  vec2 h = uSize * 0.5;
  vec2 lp = local - h;
  vec2 q = abs(lp) - (h - uRadius);
  float sdf = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
  vec2 n;
  if (q.x > 0.0 && q.y > 0.0) n = normalize(q) * sign(lp);
  else if (q.x > q.y) n = vec2(sign(lp.x), 0.0);
  else n = vec2(0.0, sign(lp.y));

  // t: 0 in the middle, 1 at the edge. Near the edge, sample from further
  // in (magnifies, like the curved rim of a lens), each colour a little
  // differently (dispersion). 0.3 x bezel keeps the bend from folding over.
  float t = clamp(1.0 + sdf / uBezel, 0.0, 1.0);
  float rim = t * t * (3.0 - 2.0 * t);
  vec2 off = -n * t * t * 0.3 * uBezel;
  vec2 p = uOrigin + local;
  float soft = uFrost * (1.0 - rim);
  vec3 col;
  if (rim > 0.002) {
    col.r = scene(p + off * 1.18, soft).r;
    col.g = scene(p + off, soft).g;
    col.b = scene(p + off * 0.82, soft).b;
  } else {
    col = scene(p, soft);
  }

  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uGrade.x) * uGrade.y;
  col = mix(col, uTint.rgb, uTint.a);
  col = clamp(col + uGrade.z * rim * rim, 0.0, 1.0);
  float alpha = clamp(0.5 - sdf * uDpr, 0.0, 1.0);
  gl_FragColor = vec4(col * alpha, alpha);
}`;

  function createRenderer() {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) return null;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = {};
    for (const name of ["uTop", "uDpr", "uOrigin", "uSize", "uRadius", "uBezel", "uFrost", "uTint", "uGrade", "uBase", "uGrid", "uBlob", "uBlobColor", "uBlobs"]) {
      u[name] = gl.getUniformLocation(prog, name);
    }
    return { canvas, gl, u };
  }

  // Colour blobs anchored to the page's sections, in document px. The CSS
  // background is built from the same list, so glass and page always match.
  function backgroundModel() {
    const width = document.body.clientWidth;
    const rx = Math.max(180, Math.min(460, width * 0.3));
    const ry = Math.max(170, Math.min(400, rx * 0.9));
    const at = (sel) => {
      const el = document.querySelector(sel);
      return el ? docBox(el) : null;
    };
    const color = (name) => parseColor(css(name));
    const blobs = [];
    const add = (x, y, name, scale = 1) => blobs.push({ x, y, rx: rx * scale, ry: ry * scale, color: color(name) });
    const orb = at("#orb");
    const panel = at("#form");
    const steps = at(".steps");
    const faq = at(".faq-list");
    if (orb) {
      const cx = orb.x + orb.w / 2;
      const cy = orb.y + orb.h / 2;
      add(cx - width * 0.32, cy + 30, "--blob-violet");
      add(cx + width * 0.36, cy - 40, "--blob-sky");
    }
    if (panel) {
      const cy = panel.y + panel.h / 2;
      add(panel.x - 30, cy, "--blob-pink", 0.9);
      add(panel.x + panel.w * 0.55, cy + 40, "--blob-indigo", 0.85);
      add(panel.x + panel.w + 20, cy + 70, "--blob-amber", 0.9);
    }
    if (steps) {
      const cy = steps.y + steps.h / 2;
      add(steps.x + 30, cy, "--blob-violet", 0.9);
      add(steps.x + steps.w - 20, cy + 60, "--blob-sky", 0.9);
    }
    if (faq) {
      const cy = faq.y + faq.h / 2;
      add(faq.x + faq.w, cy - 40, "--blob-pink", 0.9);
      add(faq.x, cy + 80, "--blob-indigo", 0.9);
    }
    return { base: color("--bg"), grid: color("--grid"), blobs };
  }

  const rgbaText = (c) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3]})`;

  function paintBackdrop(backdrop, model) {
    // CSS draws the first layer on top: grid, then blobs from the top down.
    const blobs = model.blobs
      .slice()
      .reverse()
      .map((b) => `radial-gradient(${b.rx.toFixed(1)}px ${b.ry.toFixed(1)}px at ${b.x.toFixed(1)}px ${b.y.toFixed(1)}px, ${rgbaText(b.color)}, transparent 70%)`);
    backdrop.style.backgroundColor = rgbaText(model.base);
    backdrop.style.backgroundImage = [`radial-gradient(${rgbaText(model.grid)} 1.2px, transparent 1.7px)`, ...blobs].join(", ");
    backdrop.style.backgroundSize = [`${GRID}px ${GRID}px`, ...blobs.map(() => "100% 100%")].join(", ");
    backdrop.style.backgroundRepeat = ["repeat", ...blobs.map(() => "no-repeat")].join(", ");
  }

  function setupClearGlass() {
    const backdrop = document.querySelector(".backdrop");
    let r;
    try {
      r = createRenderer();
    } catch (err) {
      console.warn("Clear glass unavailable:", err);
      return;
    }
    if (!r || !backdrop) return;
    const { gl, u } = r;

    const glassEls = () => [...document.querySelectorAll(".glass")].filter((el) => !el.classList.contains("nav"));
    const num = (name, fallback) => {
      const v = parseFloat(css(name));
      return Number.isFinite(v) ? v : fallback;
    };
    let lastScene = "";

    // Redraws only the glass whose size, position or background changed.
    function draw() {
      queued = false;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const model = backgroundModel();
      const isDark = dark.matches;
      const grade = [num("--lq-sat", 1.3), num("--lq-bright", 1), num("--lq-glow", 0.15)];
      const scene = JSON.stringify([model, grade, isDark, dpr]);
      if (scene !== lastScene) {
        paintBackdrop(backdrop, model);
        lastScene = scene;
      }

      const items = [];
      for (const el of glassEls()) {
        const box = docBox(el);
        if (!box.w || !box.h) continue;
        const style = getComputedStyle(el);
        const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, box.w / 2, box.h / 2);
        const tint = parseFloat(style.getPropertyValue("--lq-tint"));
        const frost = parseFloat(style.getPropertyValue("--lq-frost"));
        const key = `${scene}|${box.x},${box.y},${box.w},${box.h},${radius},${tint},${frost}`;
        if (el._glassKey === key && el.querySelector(":scope > .glass-canvas")) continue;
        items.push({ el, box, radius, tint, frost, key });
      }
      if (!items.length) {
        root.classList.add("liquid");
        return;
      }
      const needW = Math.ceil(Math.max(...items.map((it) => it.box.w)) * dpr);
      const needH = Math.ceil(Math.max(...items.map((it) => it.box.h)) * dpr);
      if (r.canvas.width < needW || r.canvas.height < needH) {
        r.canvas.width = Math.max(r.canvas.width, needW);
        r.canvas.height = Math.max(r.canvas.height, needH);
      }

      const blobs = model.blobs.slice(0, 10);
      const pos = new Float32Array(40);
      const col = new Float32Array(40);
      blobs.forEach((b, i) => {
        pos.set([b.x, b.y, b.rx, b.ry], i * 4);
        col.set(b.color, i * 4);
      });
      gl.uniform4fv(u.uBlob, pos);
      gl.uniform4fv(u.uBlobColor, col);
      gl.uniform1i(u.uBlobs, blobs.length);
      gl.uniform3fv(u.uBase, model.base.slice(0, 3));
      gl.uniform4fv(u.uGrid, model.grid);
      gl.uniform1f(u.uDpr, dpr);
      gl.uniform1f(u.uTop, r.canvas.height);
      gl.uniform3fv(u.uGrade, grade);

      for (const { el, box, radius, tint, frost, key } of items) {
        let out = el.querySelector(":scope > .glass-canvas");
        if (!out) {
          out = document.createElement("canvas");
          out.className = "glass-canvas";
          out.setAttribute("aria-hidden", "true");
          el.prepend(out);
        }
        const w = Math.round(box.w * dpr);
        const h = Math.round(box.h * dpr);
        if (out.width !== w || out.height !== h) {
          out.width = w;
          out.height = h;
        }
        el._glassKey = key;
        // Draw into the buffer's top-left corner, then copy that corner out.
        gl.viewport(0, r.canvas.height - h, w, h);
        gl.uniform2f(u.uOrigin, box.x, box.y);
        gl.uniform2f(u.uSize, box.w, box.h);
        gl.uniform1f(u.uRadius, radius);
        // Rim width scales with the element: thin on chips, up to 26 px on panels.
        gl.uniform1f(u.uBezel, Math.max(6, Math.min(26, box.h * 0.24, box.w * 0.24)));
        gl.uniform1f(u.uFrost, Number.isFinite(frost) ? frost : 3);
        gl.uniform4fv(u.uTint, isDark ? [0.04, 0.04, 0.09, Number.isFinite(tint) ? tint : 0.3] : [1, 1, 1, Number.isFinite(tint) ? tint : 0.2]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        const ctx = out.getContext("2d");
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(r.canvas, 0, 0, w, h, 0, 0, w, h);
      }
      root.classList.add("liquid");
    }

    let queued = false;
    const schedule = () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(draw);
      }
    };

    // Redraw whenever anything could have moved or resized.
    const sizes = new ResizeObserver(schedule);
    sizes.observe(document.body);
    const watch = () => glassEls().forEach((el) => sizes.observe(el));
    watch();
    new MutationObserver(() => {
      watch();
      schedule();
    }).observe(document.querySelector("main") || document.body, { childList: true, subtree: true });
    addEventListener("resize", schedule);
    document.addEventListener("animationend", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    document.addEventListener("toggle", schedule, true);
    dark.addEventListener("change", schedule);
    if (document.fonts) document.fonts.ready.then(schedule);
    gl.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      root.classList.remove("liquid");
    });
    draw();
  }

  // ---------- 2. refracting rim for the nav (Chromium on computers) ----------

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

  if (!lessGlass.matches) {
    setupClearGlass();
    // The SVG filter re-runs every frame, so keep it to computers.
    const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
    const chromium = brands.some((b) => b.brand === "Chromium");
    const capable = matchMedia("(pointer: fine)").matches && (navigator.hardwareConcurrency || 4) >= 4;
    if (chromium && capable && "ResizeObserver" in window) setupLenses();
  }

  // ---------- 3. rim light ----------

  let pointer = null;
  let queued = false;

  function aimLights() {
    queued = false;
    // With no mouse, light comes from above the screen, so rims shift as
    // the page scrolls past it.
    const light = pointer || { x: innerWidth / 2, y: -innerHeight * 0.6 };
    for (const el of document.querySelectorAll(".glass")) {
      const r = el.getBoundingClientRect();
      if (r.bottom < -50 || r.top > innerHeight + 50) continue;
      let angle = (Math.atan2(light.x - (r.left + r.width / 2), r.top + r.height / 2 - light.y) * 180) / Math.PI;
      // Unwrap so the highlight turns the short way round.
      const prev = el._light ?? angle;
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
  addEventListener("resize", queue);
  queue();
})();

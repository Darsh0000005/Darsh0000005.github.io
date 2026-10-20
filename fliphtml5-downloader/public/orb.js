// Dot, the page's mascot: a 3D sphere of dots with a face that reacts to
// what the downloader is doing. Drawn on a 2D canvas, no libraries.
// ui.js drives it through window.Orb.
(() => {
  "use strict";

  const canvas = document.getElementById("orb");
  const ctx = canvas && canvas.getContext && canvas.getContext("2d");
  if (!ctx) return;

  const TAU = Math.PI * 2;
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const CAMERA = 4.5; // distance from the sphere centre, in sphere radii
  const LEVELS = 10; // colour steps along the gradient
  const ALPHAS = 5; // opacity steps by depth
  const PER_PASS = LEVELS * ALPHAS + 1; // + one bucket for scan highlights
  const RING_DOTS = 72;
  const LIGHT = normalize([-0.5, 0.6, 0.65]);

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const darkScheme = matchMedia("(prefers-color-scheme: dark)");

  // How each mood moves; the current values ease toward these.
  const MOODS = {
    idle: { spin: 0.22, wave: 0.03, ring: 0, scan: 0, ok: 0, err: 0, eye: 1, glow: 0.55 },
    ready: { spin: 0.42, wave: 0.045, ring: 0, scan: 0, ok: 0, err: 0, eye: 1.12, glow: 0.85 },
    working: { spin: 0.85, wave: 0.07, ring: 1, scan: 0, ok: 0, err: 0, eye: 0.85, glow: 0.8 },
    reading: { spin: 0.5, wave: 0.05, ring: 1, scan: 1, ok: 0, err: 0, eye: 0.8, glow: 0.85 },
    done: { spin: 0.45, wave: 0.05, ring: 0, scan: 0, ok: 1, err: 0, eye: 1, glow: 1 },
    error: { spin: 0.12, wave: 0.02, ring: 0, scan: 0, ok: 0, err: 1, eye: 1, glow: 0.7 },
    sleepy: { spin: 0.06, wave: 0.015, ring: 0, scan: 0, ok: 0, err: 0, eye: 0.12, glow: 0.3 },
  };

  // Gradient stops (top, middle, bottom) for each colour scheme.
  const PALETTES = {
    light: {
      brand: [[124, 58, 237], [79, 70, 229], [8, 145, 178]],
      ok: [[16, 185, 129], [13, 148, 136], [8, 145, 178]],
      err: [[239, 68, 68], [234, 88, 12], [219, 39, 119]],
      ring: [91, 61, 245],
      scan: [6, 182, 212],
      halo: [124, 58, 237],
      shadow: "rgba(40, 24, 110, 0.18)",
      eye: "#16123a",
      eyeGlow: null,
      blush: "rgba(236, 72, 153, 0.28)",
      blend: "source-over",
      haloAlpha: 0.2,
    },
    dark: {
      brand: [[167, 139, 250], [129, 140, 248], [34, 211, 238]],
      ok: [[52, 211, 153], [45, 212, 191], [34, 211, 238]],
      err: [[248, 113, 113], [251, 146, 60], [244, 114, 182]],
      ring: [180, 165, 255],
      scan: [255, 255, 255],
      halo: [139, 92, 246],
      shadow: "rgba(139, 92, 246, 0.28)",
      eye: "#ffffff",
      eyeGlow: "rgba(255, 255, 255, 0.8)",
      blush: "rgba(244, 114, 182, 0.35)",
      blend: "lighter",
      haloAlpha: 0.32,
    },
  };

  function normalize(v) {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  function gradient(stops, s) {
    return s < 0.5 ? mix(stops[0], stops[1], s * 2) : mix(stops[1], stops[2], (s - 0.5) * 2);
  }

  function rgba(c, a) {
    return `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
  }

  // Evenly spread points on a unit sphere (Fibonacci lattice).
  function spherePoints(n) {
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(1 - y * y);
      pts[i * 3] = Math.cos(GOLDEN * i) * r;
      pts[i * 3 + 1] = y;
      pts[i * 3 + 2] = Math.sin(GOLDEN * i) * r;
    }
    return pts;
  }

  // ---------- state ----------

  let count = 0;
  let base = null; // unit sphere points
  let sx = null; // projected x, y, radius and bucket per point
  let sy = null;
  let sr = null;
  let bucketOf = null;
  let order = null;
  const bucketCount = new Uint16Array(PER_PASS * 2);
  const bucketStart = new Uint16Array(PER_PASS * 2);
  const colors = new Array(PER_PASS * 2);

  let moodName = "idle";
  let target = MOODS.idle;
  const cur = { ...MOODS.idle };
  let progress = null; // 0..1, or null while unknown
  let shownProgress = 0;

  const look = { x: 0, y: 0 };
  let pointer = null; // where the pointer is, relative to the orb
  let lookOverride = null;

  let time = 0;
  let rotY = 0.6;
  let ringRot = 0;
  let hopAge = Infinity;
  let shakeAge = Infinity;
  let wobbleAge = Infinity;
  let happyUntil = 0;
  let blinkIn = 1.5;
  let blinkAge = Infinity;
  const particles = [];

  let size = 0;
  let dpr = 1;
  let visible = true;
  let running = false;
  let last = 0;

  function palette() {
    return darkScheme.matches ? PALETTES.dark : PALETTES.light;
  }

  function motion() {
    return reduceMotion.matches ? 0.15 : 1;
  }

  function resize() {
    const css = canvas.clientWidth || 260;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(css * dpr);
    if (px !== size) {
      size = px;
      canvas.width = canvas.height = px;
    }
    const n = css < 230 ? 560 : 820;
    if (n !== count) {
      count = n;
      base = spherePoints(n);
      sx = new Float32Array(n);
      sy = new Float32Array(n);
      sr = new Float32Array(n);
      bucketOf = new Uint8Array(n);
      order = new Uint16Array(n);
    }
  }

  // ---------- update ----------

  function update(dt) {
    const m = motion();
    time += dt;
    const ease = 1 - Math.exp(-dt * 4);
    for (const key in cur) cur[key] += (target[key] - cur[key]) * ease;

    rotY += dt * cur.spin * m;
    ringRot += dt * (0.9 + cur.spin) * m;
    if (progress != null) shownProgress += (progress - shownProgress) * (1 - Math.exp(-dt * 6));

    let lx;
    let ly;
    if (lookOverride) {
      lx = lookOverride.x;
      ly = lookOverride.y;
    } else if (moodName === "reading") {
      // Eyes sweep along lines of text, then snap back.
      const s = (time * 0.55) % 1;
      lx = s < 0.85 ? -0.75 + (s / 0.85) * 1.5 : 0.75 - ((s - 0.85) / 0.15) * 1.5;
      ly = 0.35;
    } else if (moodName === "working") {
      lx = 0.45 * Math.sin(time * 0.8);
      ly = -0.35 + 0.1 * Math.sin(time * 1.3);
    } else if (pointer && performance.now() - pointer.at < 5000) {
      lx = pointer.x;
      ly = pointer.y;
    } else {
      lx = 0.35 * Math.sin(time * 0.37);
      ly = 0.2 * Math.sin(time * 0.29 + 1);
    }
    const follow = 1 - Math.exp(-dt * 6);
    look.x += (lx - look.x) * follow;
    look.y += (ly - look.y) * follow;

    blinkIn -= dt;
    if (blinkIn <= 0) {
      blinkAge = 0;
      blinkIn = 2.4 + Math.random() * 3.6;
    }
    blinkAge += dt;
    hopAge += dt;
    shakeAge += dt;
    wobbleAge += dt;

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      p.vx *= 0.985;
      p.vy = p.vy * 0.985 - 1.3 * dt;
      p.vz *= 0.985;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
    }
  }

  // ---------- drawing ----------

  function draw() {
    const pal = palette();
    const w = size;
    const m = motion();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, w);

    const hop = hopAge < 0.55 ? Math.sin((Math.PI * hopAge) / 0.55) : 0;
    const shake = shakeAge < 0.8 ? Math.sin(shakeAge * 42) * Math.exp(-shakeAge * 5) : 0;
    const wobble = wobbleAge < 1.4 ? 0.09 * Math.sin(wobbleAge * 16) * Math.exp(-wobbleAge * 4) : 0;
    const breath = 1 + 0.022 * Math.sin(time * 1.6) * m;
    const R = w * 0.29;
    const cx = w / 2 + shake * R * 0.12;
    const cy = w * 0.47 - hop * R * 0.22;
    const scaleX = breath * (1 + wobble);
    const scaleY = breath * (1 - wobble);

    // Ground shadow, smaller while hopping.
    const shadowW = R * (1.05 - hop * 0.35);
    const sh = ctx.createRadialGradient(w / 2, w * 0.47 + R * 1.32, 0, w / 2, w * 0.47 + R * 1.32, shadowW);
    sh.addColorStop(0, pal.shadow);
    sh.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.save();
    ctx.translate(w / 2, w * 0.47 + R * 1.32);
    ctx.scale(1, 0.18);
    ctx.translate(-w / 2, -(w * 0.47 + R * 1.32));
    ctx.fillStyle = sh;
    ctx.fillRect(w / 2 - shadowW, w * 0.47 + R * 1.32 - shadowW, shadowW * 2, shadowW * 2);
    ctx.restore();

    // Soft halo behind the sphere.
    const haloColor = mix(mix(pal.halo, gradient(pal.ok, 0.5), cur.ok), gradient(pal.err, 0.3), cur.err);
    const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.9);
    halo.addColorStop(0, rgba(haloColor, pal.haloAlpha * cur.glow));
    halo.addColorStop(1, rgba(haloColor, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, w);

    // Colours for this frame: gradient level x depth alpha, per pass.
    for (let k = 0; k < LEVELS; k++) {
      const s = k / (LEVELS - 1);
      const c = mix(mix(gradient(pal.brand, s), gradient(pal.ok, s), cur.ok), gradient(pal.err, s), cur.err);
      for (let a = 0; a < ALPHAS; a++) {
        const alpha = (0.1 + (0.9 * (a + 0.5)) / ALPHAS).toFixed(3);
        colors[k * ALPHAS + a] = colors[PER_PASS + k * ALPHAS + a] = rgba(c, alpha);
      }
    }
    colors[PER_PASS - 1] = colors[PER_PASS * 2 - 1] = rgba(pal.scan, 0.95);

    // Sphere rotation: spin plus a lean toward where Dot is looking.
    const ay = rotY + look.x * 0.5;
    const ax = 0.32 + look.y * 0.3;
    const cosY = Math.cos(ay);
    const sinY = Math.sin(ay);
    const cosX = Math.cos(ax);
    const sinX = Math.sin(ax);
    const wave = cur.wave * m;
    const t = time;
    const bandY = 0.85 * Math.sin(t * 2.2);
    const scanOn = cur.scan > 0.5;
    const dotBase = R * 0.021;

    bucketCount.fill(0);
    for (let i = 0; i < count; i++) {
      const x0 = base[i * 3];
      const y0 = base[i * 3 + 1];
      const z0 = base[i * 3 + 2];
      const d = 1 + wave * (Math.sin(3.1 * x0 + t * 1.9) * Math.sin(2.7 * y0 + t * 1.3) + 0.6 * Math.sin(4.3 * z0 - t * 2.3));

      const x1 = x0 * cosY + z0 * sinY;
      const z1 = -x0 * sinY + z0 * cosY;
      const y2 = y0 * cosX - z1 * sinX;
      const z2 = y0 * sinX + z1 * cosX;

      const persp = CAMERA / (CAMERA - z2 * d);
      sx[i] = cx + x1 * d * R * scaleX * persp;
      sy[i] = cy - y2 * d * R * scaleY * persp;

      const depth = (z2 + 1) / 2;
      const lambert = Math.max(0, x1 * LIGHT[0] + y2 * LIGHT[1] + z2 * LIGHT[2]);
      const alpha = 0.12 + 0.88 * Math.pow(depth, 1.4) * (0.6 + 0.4 * lambert);
      const highlight = scanOn && z2 > -0.2 && Math.abs(y2 - bandY) < 0.09;
      sr[i] = dotBase * persp * (0.55 + 0.65 * depth) * (highlight ? 1.5 : 1);

      const level = Math.max(0, Math.min(LEVELS - 1, Math.round(((1 - (0.8 * y0 + 0.45 * x0) / 1.25) / 2) * (LEVELS - 1))));
      const a = Math.min(ALPHAS - 1, Math.floor(alpha * ALPHAS));
      const pass = z2 < 0 ? 0 : PER_PASS;
      const b = pass + (highlight ? PER_PASS - 1 : level * ALPHAS + a);
      bucketOf[i] = b;
      bucketCount[b]++;
    }

    // Counting sort so each bucket is one path and one fill.
    let acc = 0;
    for (let b = 0; b < PER_PASS * 2; b++) {
      bucketStart[b] = acc;
      acc += bucketCount[b];
    }
    const fill = bucketStart.slice();
    for (let i = 0; i < count; i++) order[fill[bucketOf[i]]++] = i;

    ctx.globalCompositeOperation = pal.blend;
    drawRing(pal, cx, cy, R, scaleX, scaleY, false);
    for (let b = 0; b < PER_PASS * 2; b++) {
      const n = bucketCount[b];
      if (!n) continue;
      ctx.fillStyle = colors[b];
      ctx.beginPath();
      for (let j = bucketStart[b], end = j + n; j < end; j++) {
        const i = order[j];
        ctx.moveTo(sx[i] + sr[i], sy[i]);
        ctx.arc(sx[i], sy[i], sr[i], 0, TAU);
      }
      ctx.fill();
    }
    drawRing(pal, cx, cy, R, scaleX, scaleY, true);
    drawParticles(pal, cx, cy, R);
    ctx.globalCompositeOperation = "source-over";
    drawFace(pal, cx, cy, R, scaleX, scaleY);
  }

  // A tilted ring of dots that orbits while Dot works; the lit arc shows progress.
  function drawRing(pal, cx, cy, R, scaleX, scaleY, front) {
    if (cur.ring < 0.02) return;
    const tiltX = 0.42;
    const tiltZ = -0.28;
    const cX = Math.cos(tiltX);
    const sX = Math.sin(tiltX);
    const cZ = Math.cos(tiltZ);
    const sZ = Math.sin(tiltZ);
    const lit = progress == null ? null : shownProgress;
    for (let i = 0; i < RING_DOTS; i++) {
      const f = i / RING_DOTS;
      const ang = f * TAU + ringRot;
      const x = Math.cos(ang) * 1.55;
      const z = Math.sin(ang) * 1.55;
      const y1 = -z * sX;
      const z1 = z * cX;
      const x2 = x * cZ - y1 * sZ;
      const y2 = x * sZ + y1 * cZ;
      if (z1 < 0 === front) continue;
      const on = lit == null ? (f - time * 0.6 + 10) % 1 < 0.22 : f < lit;
      const persp = CAMERA / (CAMERA - z1);
      const r = R * (on ? 0.03 : 0.016) * persp;
      ctx.fillStyle = rgba(pal.ring, (on ? 0.95 : 0.22) * cur.ring);
      ctx.beginPath();
      ctx.arc(cx + x2 * R * scaleX * persp, cy - y2 * R * scaleY * persp, r, 0, TAU);
      ctx.fill();
    }
  }

  function drawParticles(pal, cx, cy, R) {
    for (const p of particles) {
      const persp = CAMERA / (CAMERA - p.z);
      const c = gradient(pal.ok, p.hue);
      ctx.fillStyle = rgba(c, Math.max(0, p.life / p.max).toFixed(3));
      ctx.beginPath();
      ctx.arc(cx + p.x * R * persp, cy - p.y * R * persp, R * 0.026 * persp, 0, TAU);
      ctx.fill();
    }
  }

  // Rounded capsule centred on (x, y).
  function capsule(x, y, w, h) {
    const r = Math.min(w, h) / 2;
    ctx.beginPath();
    if (h >= w) {
      ctx.arc(x, y - h / 2 + r, r, Math.PI, 0);
      ctx.arc(x, y + h / 2 - r, r, 0, Math.PI);
    } else {
      ctx.arc(x - w / 2 + r, y, r, Math.PI / 2, (Math.PI * 3) / 2);
      ctx.arc(x + w / 2 - r, y, r, -Math.PI / 2, Math.PI / 2);
    }
    ctx.closePath();
    ctx.fill();
  }

  function drawFace(pal, cx, cy, R, scaleX, scaleY) {
    const fx = cx + look.x * R * 0.24 * scaleX;
    const fy = cy + look.y * R * 0.18 * scaleY - R * 0.04;
    const gap = R * 0.21 * (1 - 0.15 * Math.abs(look.x));
    const happy = moodName === "done" || time < happyUntil;
    const worried = moodName === "error";
    const blink = blinkAge < 0.18 ? 1 - Math.sin((Math.PI * blinkAge) / 0.18) * 0.92 : 1;

    ctx.fillStyle = pal.eye;
    ctx.strokeStyle = pal.eye;
    if (pal.eyeGlow) {
      ctx.shadowColor = pal.eyeGlow;
      ctx.shadowBlur = R * 0.16;
    }

    for (const side of [-1, 1]) {
      const ex = fx + side * gap;
      if (happy) {
        // ^ ^
        ctx.lineWidth = R * 0.065;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(ex, fy + R * 0.04, R * 0.085, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      } else if (worried) {
        ctx.save();
        ctx.translate(ex, fy + R * 0.03);
        ctx.rotate(side * 0.38);
        capsule(0, 0, R * 0.17, Math.max(R * 0.02, R * 0.075 * blink));
        ctx.restore();
      } else {
        const eh = Math.max(R * 0.02, R * 0.3 * cur.eye * blink);
        capsule(ex, fy, R * 0.13 * (1 - 0.2 * Math.abs(look.x)), eh);
      }
    }

    ctx.shadowBlur = 0;
    if (happy) {
      ctx.lineWidth = R * 0.05;
      ctx.beginPath();
      ctx.arc(fx, fy + R * 0.14, R * 0.075, Math.PI * 0.2, Math.PI * 0.8);
      ctx.stroke();
      ctx.fillStyle = pal.blush;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(fx + side * gap * 1.55, fy + R * 0.13, R * 0.075, R * 0.045, 0, 0, TAU);
        ctx.fill();
      }
    }
  }

  // ---------- loop ----------

  function frame(now) {
    if (!visible || document.hidden) {
      running = false;
      return;
    }
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }

  function burst() {
    for (let i = 0; i < 70; i++) {
      const u = normalize([Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1]);
      const speed = 1.1 + Math.random() * 1.5;
      const max = 0.8 + Math.random() * 0.7;
      particles.push({
        x: u[0], y: u[1], z: u[2],
        vx: u[0] * speed, vy: u[1] * speed + 0.7, vz: u[2] * speed,
        life: max, max, hue: Math.random(),
      });
    }
  }

  resize();
  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(canvas);
  else addEventListener("resize", resize);

  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) start();
    }).observe(canvas);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) start();
  });

  addEventListener(
    "pointermove",
    (e) => {
      const r = canvas.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      pointer = {
        x: Math.max(-1, Math.min(1, dx / (innerWidth * 0.35))),
        y: Math.max(-1, Math.min(1, dy / (innerHeight * 0.35))),
        at: performance.now(),
      };
    },
    { passive: true },
  );

  canvas.addEventListener("click", () => {
    window.Orb.react("wobble");
    canvas.dispatchEvent(new CustomEvent("orbpoke", { bubbles: true }));
  });

  window.Orb = {
    get mood() {
      return moodName;
    },
    setMood(name) {
      if (!MOODS[name] || name === moodName) return;
      moodName = name;
      target = MOODS[name];
      blinkAge = 0; // swap eye shapes mid-blink
      if (name !== "working" && name !== "reading") progress = null;
    },
    setProgress(p) {
      if (p == null) {
        progress = null;
        shownProgress = 0;
      } else {
        progress = Math.max(0, Math.min(1, p));
      }
    },
    react(kind) {
      if (kind === "wobble") happyUntil = time + 0.9;
      if (reduceMotion.matches) return;
      if (kind === "hop") hopAge = 0;
      else if (kind === "shake") shakeAge = 0;
      else if (kind === "wobble") wobbleAge = 0;
      else if (kind === "burst") burst();
    },
    // Point Dot's eyes somewhere (-1..1 on each axis), or pass null to let go.
    lookAt(x, y) {
      lookOverride = x == null ? null : { x, y };
    },
  };

  start();
})();

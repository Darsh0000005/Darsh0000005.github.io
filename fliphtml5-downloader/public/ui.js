// Page interactions around the downloader: the mascot's moods and speech
// bubble, the Paste button and the live link check. app.js does the work
// and reports what it's doing through "downloader" events.
(() => {
  "use strict";

  const noop = () => {};
  const orb = window.Orb || { mood: "idle", setMood: noop, setProgress: noop, react: noop, lookAt: noop };
  const form = document.getElementById("form");
  const input = document.getElementById("url");
  const field = input.closest(".field");
  const pasteBtn = document.getElementById("paste");
  const bubble = document.getElementById("bubble");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  const BOOK_LINK = /^\s*https?:\/\/([\w-]+\.)*fliphtml5\.com\/(?!bookcase\/)[\w-]+\/[\w-]+/i;
  const HELLO = "Paste a FlipHTML5 link and I'll turn it into a PDF.";
  const READY = "That's a FlipHTML5 book. Press Download PDF when you're ready.";
  const POKES = [
    "Hi, I'm Dot. I turn flipbooks into PDFs.",
    "Tip: turn on Selectable text to copy words from your PDF.",
    "Hehe, that tickles.",
    "I'm made of a few hundred tiny dots.",
  ];

  let pokeIndex = 0;
  let settle = null;
  let holdUntil = 0;
  let lastActivity = Date.now();

  // A download is running while its card has neither finished state.
  const busy = () => !!document.querySelector("#tasks .task:not(.done):not(.error)");

  // ---------- speech bubble ----------

  let typer = null;
  function say(text, stream = true) {
    if (bubble.dataset.text === text) return;
    bubble.dataset.text = text;
    clearInterval(typer);
    bubble.classList.remove("typing");
    if (!stream || reduceMotion.matches) {
      bubble.textContent = text;
      return;
    }
    const words = text.split(" ");
    let shown = 0;
    bubble.textContent = "";
    bubble.classList.add("typing");
    typer = setInterval(() => {
      shown++;
      bubble.textContent = words.slice(0, shown).join(" ");
      if (shown >= words.length) {
        clearInterval(typer);
        bubble.classList.remove("typing");
      }
    }, 55);
  }

  // Say something and keep it up for a moment before progress counters take over.
  function announce(text, holdMs) {
    say(text);
    holdUntil = Date.now() + holdMs;
  }

  function sayProgress(text) {
    if (Date.now() >= holdUntil) say(text, false);
  }

  function short(title) {
    return title.length > 42 ? title.slice(0, 40).trimEnd() + "…" : title;
  }

  // Go back to resting once nothing is running.
  function settleSoon(ms) {
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (busy()) return;
      orb.setMood("idle");
      checkLink(false);
    }, ms);
  }

  // ---------- downloader events ----------

  document.addEventListener("downloader", ({ detail: d }) => {
    lastActivity = Date.now();
    clearTimeout(settle);
    switch (d.state) {
      case "start": {
        orb.setMood("working");
        orb.setProgress(null);
        orb.react("hop");
        announce("On it! Opening the book…", 1500);
        const card = document.querySelector("#tasks .task");
        // Bring the progress card into view only if it's mostly off screen.
        if (card && card.getBoundingClientRect().top > innerHeight - 60) {
          card.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "nearest" });
        }
        break;
      }
      case "book":
        announce(`Found “${short(d.title)}”. ${d.pages} pages to fetch.`, 2200);
        break;
      case "ocr-loading":
        orb.setMood("reading");
        orb.setProgress(null);
        announce("Loading text recognition. It's quicker next time.", 1500);
        break;
      case "progress":
        orb.setMood(d.ocr ? "reading" : "working");
        orb.setProgress(d.done / d.total);
        sayProgress(d.ocr ? `Reading page ${d.done} of ${d.total}…` : `Fetching page ${d.done} of ${d.total}…`);
        break;
      case "done":
        orb.setMood("done");
        orb.setProgress(1);
        orb.react("burst");
        orb.react("hop");
        announce(d.ocr ? "Done! Your PDF is downloaded, and its text is selectable." : "Done! Your PDF is in your downloads.", 2500);
        settleSoon(6000);
        break;
      case "error":
        orb.setMood("error");
        orb.react("shake");
        announce(d.message, 2500);
        settleSoon(7000);
        break;
    }
  });

  // ---------- link field ----------

  function checkLink(fromPaste) {
    const value = input.value.trim();
    const ok = BOOK_LINK.test(value);
    field.classList.toggle("valid", ok);
    if (busy()) return;
    if (ok) {
      if (orb.mood !== "ready") {
        orb.setMood("ready");
        orb.react("hop");
      }
      say(READY);
      return;
    }
    if (orb.mood === "ready") orb.setMood("idle");
    if (!value) say(HELLO);
    else if (fromPaste) say("Hmm, that doesn't look like a FlipHTML5 book link. It should look like fliphtml5.com/abcde/fghi/.");
  }

  input.addEventListener("input", (e) => checkLink(e.inputType === "insertFromPaste"));
  input.addEventListener("focus", () => orb.lookAt(0, 0.9));
  input.addEventListener("blur", () => {
    orb.lookAt(null);
    if (input.value.trim() && !BOOK_LINK.test(input.value)) checkLink(true);
  });

  // app.js clears the field when a download starts.
  form.addEventListener("submit", () => {
    field.classList.remove("valid");
    orb.lookAt(null);
  });

  if (navigator.clipboard && navigator.clipboard.readText) {
    pasteBtn.hidden = false;
    pasteBtn.addEventListener("click", async () => {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (!text) {
          say("Your clipboard is empty. Copy the book's link first.");
          return;
        }
        input.value = text;
        input.focus();
        checkLink(true);
      } catch {
        input.focus();
        say("I couldn't read your clipboard. Press Ctrl+V, or long-press the box and choose Paste.");
      }
    });
  }

  // ---------- quality: a glass thumb slides to the chosen option ----------

  const seg = document.getElementById("quality-group");
  const thumb = seg.querySelector(".seg-thumb");
  function placeThumb(animate) {
    const checked = seg.querySelector("input:checked");
    if (!checked) return;
    const label = checked.closest("label");
    thumb.classList.toggle("instant", !animate);
    thumb.style.width = `${label.offsetWidth}px`;
    thumb.style.transform = `translateX(${label.offsetLeft}px)`;
    if (animate) {
      thumb.classList.remove("jelly");
      void thumb.offsetWidth; // restart the squash animation
      thumb.classList.add("jelly");
    }
  }
  seg.addEventListener("change", () => placeThumb(true));
  thumb.addEventListener("animationend", () => thumb.classList.remove("jelly"));
  if ("ResizeObserver" in window) new ResizeObserver(() => placeThumb(false)).observe(seg);
  if (document.fonts) document.fonts.ready.then(() => placeThumb(false));
  placeThumb(false);

  // ---------- little extras ----------

  document.addEventListener("orbpoke", () => {
    if (busy()) return;
    say(POKES[pokeIndex++ % POKES.length]);
    clearTimeout(settle);
    settle = setTimeout(() => checkLink(false), 6000);
  });

  // Dot dozes off when nothing has happened for a while.
  const wake = () => {
    lastActivity = Date.now();
    if (orb.mood === "sleepy") {
      orb.setMood("idle");
      orb.react("hop");
      checkLink(false);
    }
  };
  for (const ev of ["pointermove", "pointerdown", "keydown", "scroll", "touchstart"]) {
    addEventListener(ev, wake, { passive: true });
  }
  setInterval(() => {
    if (orb.mood === "idle" && !busy() && Date.now() - lastActivity > 40000) {
      orb.setMood("sleepy");
      say("Zzz… paste a link to wake me up.");
    }
  }, 4000);

  if (input.value) checkLink(false);
})();

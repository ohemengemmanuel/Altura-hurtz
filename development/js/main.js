/* Shared behaviour for every page: mobile menu, contact details, copy buttons. */
(function () {
  const cfg = window.AH_CONFIG || {};

  // Mobile menu
  const toggle = document.querySelector(".nav-toggle");
  const links = document.getElementById("nav-links");
  if (toggle && links) {
    const setOpen = (open) => {
      links.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Menu");
    };
    toggle.addEventListener("click", () => setOpen(!links.classList.contains("is-open")));
    // Close with Escape or a tap outside the menu
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && links.classList.contains("is-open")) { setOpen(false); toggle.focus(); }
    });
    document.addEventListener("click", (e) => {
      if (links.classList.contains("is-open") && !links.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });
  }

  // Split nav: the link pill gets its background once the hero has scrolled out from under the header.
  const header = document.querySelector(".site-header");
  const heroEl = document.querySelector(".hero, .page-hero");
  if (header && heroEl) {
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([en]) => header.classList.toggle("is-scrolled", !en.isIntersecting),
        { rootMargin: "-68px 0px 0px 0px" }).observe(heroEl);
    } else {
      const check = () => header.classList.toggle("is-scrolled", heroEl.getBoundingClientRect().bottom < 68);
      window.addEventListener("scroll", check, { passive: true });
      check();
    }
  }

  // Links to a section on the current page scroll smoothly. Links to other pages load normally,
  // so a page never animates a scroll while it is still loading.
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href*="#"]');
    if (!a) return;
    const url = new URL(a.href, location.href);
    if (url.pathname !== location.pathname || !url.hash) return;
    const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
    if (!target) return;
    e.preventDefault();
    if (links && links.classList.contains("is-open")) toggle.click();
    target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    history.pushState(null, "", url.hash);
  });

  // Mild scroll reveal. Only elements that start below the screen are hidden and faded in,
  // so nothing already visible ever flashes. Skipped for reduced motion.
  if (!reduceMotion && "IntersectionObserver" in window) {
    const groups = [
      ".section-head", ".intro-grid", ".cta-band", ".form-card", ".summary",
      ".beat-list", ".empty-state",
      [".service-grid", ".service-card"], [".steps", "li"], [".policy-list", "li"],
      [".contact-grid", ".contact-item"], [".gear", "li"]
    ];
    const items = [];
    groups.forEach((g) => {
      if (typeof g === "string") {
        document.querySelectorAll("main " + g).forEach((el) => items.push(el));
      } else {
        document.querySelectorAll("main " + g[0]).forEach((parent) => {
          parent.querySelectorAll(":scope > " + g[1]).forEach((el, i) => {
            el.style.setProperty("--i", Math.min(i, 6));
            items.push(el);
          });
        });
      }
    });
    const below = items.filter((el) => el.getBoundingClientRect().top > window.innerHeight);
    if (below.length) {
      document.documentElement.classList.add("anim");
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
        });
      }, { rootMargin: "0px 0px -8% 0px" });
      below.forEach((el) => { el.classList.add("reveal"); io.observe(el); });
    }
  }

  // Meters only animate while on screen, so they cost nothing when scrolled away.
  document.querySelectorAll(".meter-bank").forEach((pair) => {
    if (!("IntersectionObserver" in window)) { pair.classList.add("is-live"); return; }
    new IntersectionObserver((entries) => {
      entries.forEach((en) => pair.classList.toggle("is-live", en.isIntersecting));
    }).observe(pair);
  });

  // Gain fader on the meter bank. Drag or click the track, scroll, or use the keys; double-click resets.
  document.querySelectorAll(".gain-fader").forEach((fader) => {
    const control = fader.closest(".gain-control");
    const bank = control && control.parentElement.querySelector(".meter-bank");
    const readout = control && control.querySelector(".knob-readout");
    const track = fader.querySelector(".fader-track");
    if (!bank || !track) return;
    const MIN = -12, MAX = 3;
    let db = 0;
    const fmt = (v) => (v > 0 ? "+" : v < 0 ? "\u2212" : "") + Math.abs(v).toFixed(1) + " dB";
    const set = (v) => {
      db = Math.round(Math.min(MAX, Math.max(MIN, v)) * 2) / 2;
      const gain = Math.pow(10, db / 20);
      bank.style.setProperty("--gain", gain.toFixed(3));
      bank.style.setProperty("--cap", Math.max(0, 1 - gain).toFixed(3));
      fader.style.setProperty("--pos", ((db - MIN) / (MAX - MIN)).toFixed(4));
      fader.setAttribute("aria-valuenow", String(db));
      fader.setAttribute("aria-valuetext", fmt(db));
      readout.textContent = fmt(db);
    };
    // Pointer position on the track to dB
    const fromPointer = (y) => {
      const r = track.getBoundingClientRect();
      const frac = 1 - (y - r.top) / r.height;
      return MIN + Math.min(1, Math.max(0, frac)) * (MAX - MIN);
    };
    set(0);

    fader.addEventListener("pointerdown", (e) => {
      fader.setPointerCapture(e.pointerId);
      fader.classList.add("is-dragging");
      set(fromPointer(e.clientY));
    });
    fader.addEventListener("pointermove", (e) => {
      if (fader.hasPointerCapture(e.pointerId)) set(fromPointer(e.clientY));
    });
    const stop = () => fader.classList.remove("is-dragging");
    fader.addEventListener("pointerup", stop);
    fader.addEventListener("pointercancel", stop);
    fader.addEventListener("wheel", (e) => {
      e.preventDefault();
      set(db + (e.deltaY < 0 ? 0.5 : -0.5));
    }, { passive: false });
    fader.addEventListener("keydown", (e) => {
      const step = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 3, PageDown: -3 }[e.key];
      if (step) { set(db + step); e.preventDefault(); }
      else if (e.key === "Home") { set(MIN); e.preventDefault(); }
      else if (e.key === "End") { set(MAX); e.preventDefault(); }
    });
    fader.addEventListener("dblclick", () => set(0));
  });

  // Mixing deck channel faders (Studio policies). Drag, click the track, scroll, or use arrow
  // keys; double-click resets to that channel's starting level.
  document.querySelectorAll(".mix-fader").forEach((fader) => {
    const track = fader.querySelector(".mix-fader-track");
    const start = parseFloat(fader.dataset.start || "0.6");
    let pos = start;
    const set = (p) => {
      pos = Math.min(1, Math.max(0, p));
      fader.style.setProperty("--pos", pos.toFixed(3));
      fader.setAttribute("aria-valuenow", String(Math.round(pos * 100)));
    };
    const fromPointer = (y) => {
      const r = track.getBoundingClientRect();
      return 1 - (y - r.top) / r.height;
    };
    set(start);
    fader.addEventListener("pointerdown", (e) => {
      fader.setPointerCapture(e.pointerId);
      fader.classList.add("is-dragging");
      set(fromPointer(e.clientY));
    });
    fader.addEventListener("pointermove", (e) => {
      if (fader.hasPointerCapture(e.pointerId)) set(fromPointer(e.clientY));
    });
    const stop = () => fader.classList.remove("is-dragging");
    fader.addEventListener("pointerup", stop);
    fader.addEventListener("pointercancel", stop);
    fader.addEventListener("wheel", (e) => {
      e.preventDefault();
      set(pos + (e.deltaY < 0 ? .05 : -.05));
    }, { passive: false });
    fader.addEventListener("keydown", (e) => {
      const step = { ArrowUp: .05, ArrowRight: .05, ArrowDown: -.05, ArrowLeft: -.05 }[e.key];
      if (step) { set(pos + step); e.preventDefault(); }
      else if (e.key === "Home") { set(0); e.preventDefault(); }
      else if (e.key === "End") { set(1); e.preventDefault(); }
    });
    fader.addEventListener("dblclick", () => set(start));
  });

  // Fill contact details from config: <span data-config="contact.phone"></span>
  const read = (path) => path.split(".").reduce((o, k) => (o ? o[k] : undefined), cfg);
  document.querySelectorAll("[data-config]").forEach((el) => {
    const value = read(el.dataset.config);
    if (value) el.textContent = value;
  });

  // Links built from config
  const wa = cfg.contact && cfg.contact.whatsapp;
  document.querySelectorAll("[data-whatsapp-link]").forEach((a) => {
    if (wa) a.href = "https://wa.me/" + wa;
  });
  const email = cfg.contact && cfg.contact.email;
  document.querySelectorAll("[data-email-link]").forEach((a) => {
    if (email) a.href = "mailto:" + email;
  });
  ["facebook", "instagram", "threads", "youtube", "tiktok"].forEach((net) => {
    const url = cfg.contact && cfg.contact[net];
    document.querySelectorAll('[data-social="' + net + '"]').forEach((a) => {
      if (url) {
        a.href = url;
      } else {
        // No link set yet in config.js: keep the icon visible but make it do nothing.
        a.removeAttribute("target");
        a.setAttribute("aria-disabled", "true");
        a.title += " (coming soon)";
        a.addEventListener("click", (e) => e.preventDefault());
      }
    });
  });

  // Prices from config: <span data-price="recordingPerHour"></span>
  document.querySelectorAll("[data-price]").forEach((el) => {
    const v = cfg.pricing && cfg.pricing[el.dataset.price];
    if (typeof v === "number") el.textContent = (cfg.currency || "GH₵") + v.toLocaleString("en-GH");
  });

  // Copy buttons: <button class="copy-btn" data-copy-from="elementId">
  document.querySelectorAll("[data-copy-from]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const src = document.getElementById(btn.dataset.copyFrom);
      if (!src) return;
      const label = btn.querySelector(".label");
      try {
        await navigator.clipboard.writeText(src.textContent.trim());
        if (label) { const old = label.textContent; label.textContent = "Copied"; setTimeout(() => (label.textContent = old), 1400); }
      } catch (e) {
        const range = document.createRange();
        range.selectNodeContents(src);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  });

  // Footer year
  document.querySelectorAll("[data-year]").forEach((el) => (el.textContent = new Date().getFullYear()));
})();

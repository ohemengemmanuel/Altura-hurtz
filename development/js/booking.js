/* Booking forms: live pricing, track titles, file pickers, validation, submission.
   A page opts in with <form id="booking-form" data-mode="..." data-service-name="...">.
   Modes: "rec-mix" (hours + tracks), "recording" (hours), "mix" (tracks), "quote" (no price). */
(function () {
  const form = document.getElementById("booking-form");
  if (!form) return;

  const cfg = window.AH_CONFIG;
  const cur = cfg.currency;
  const mode = form.dataset.mode;
  const serviceName = form.dataset.serviceName;
  const noun = form.dataset.noun || "booking";
  const $ = (sel) => form.querySelector(sel);
  const money = (n) => cur + Math.round(n).toLocaleString("en-GH");

  const tracksInput = $("#tracks");
  const hoursInput = $("#hours");
  const titlesBox = $("#track-titles");
  const summaryLines = document.getElementById("summary-lines");
  const summaryTotal = document.getElementById("summary-total");
  const confirmation = document.getElementById("confirmation");

  /* Discounts */
  function discountFor(qty, tiers) {
    let pct = 0;
    (tiers || []).forEach((t) => { if (qty >= t.min) pct = Math.max(pct, t.percent); });
    return pct;
  }

  function renderTierTable(el, tiers, unit, unitPlural) {
    if (!el) return;
    const rows = [{ min: 1, percent: 0 }].concat(tiers).map((t, i, arr) => {
      const next = arr[i + 1];
      const range = next ? (next.min - 1 === t.min ? String(t.min) : t.min + " to " + (next.min - 1)) : t.min + " or more";
      return "<tr><td>" + range + " " + (t.min === 1 && (!next || next.min === 2) ? unit : unitPlural) + "</td><td>" + (t.percent ? t.percent + "% off" : "Standard") + "</td></tr>";
    });
    el.innerHTML = "<thead><tr><th>" + unitPlural.charAt(0).toUpperCase() + unitPlural.slice(1) + "</th><th>Rate</th></tr></thead><tbody>" + rows.join("") + "</tbody>";
  }
  renderTierTable(document.getElementById("hour-tiers"), cfg.pricing.recordingHourDiscounts, "hour", "hours");
  renderTierTable(document.getElementById("track-tiers"), cfg.pricing.mixMasterTrackDiscounts, "track", "tracks");

  /* Steppers */
  form.querySelectorAll(".stepper").forEach((st) => {
    const input = st.querySelector("input");
    st.querySelectorAll("button[data-step]").forEach((b) => {
      b.addEventListener("click", () => {
        const min = Number(input.min || 1), max = Number(input.max || 99);
        const v = Math.min(max, Math.max(min, (Number(input.value) || min) + Number(b.dataset.step)));
        input.value = v;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
  });
  if (tracksInput) tracksInput.max = cfg.maxTracks;
  if (hoursInput) hoursInput.max = cfg.maxSessionHours;

  /* Track titles, one field per track */
  function syncTitles() {
    if (!titlesBox || !tracksInput) return;
    const n = clamp(tracksInput);
    const existing = titlesBox.querySelectorAll("input");
    const kept = Array.from(existing).map((i) => i.value);
    titlesBox.innerHTML = "";
    for (let i = 1; i <= n; i++) {
      const id = "track_title_" + i;
      const wrap = document.createElement("div");
      wrap.className = "field";
      wrap.innerHTML =
        '<label for="' + id + '">Track ' + i + ' title <span class="req">*</span></label>' +
        '<input type="text" id="' + id + '" name="' + id + '" required autocomplete="off" placeholder="Working title is fine">' +
        '<span class="error-text">Add a title for track ' + i + '.</span>';
      wrap.querySelector("input").value = kept[i - 1] || "";
      titlesBox.appendChild(wrap);
    }
  }

  function clamp(input) {
    const min = Number(input.min || 1), max = Number(input.max || 99);
    let v = parseInt(input.value, 10);
    if (isNaN(v)) v = min;
    return Math.min(max, Math.max(min, v));
  }

  /* Dates and times */
  const dateInput = $("#session_date");
  if (dateInput) {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    dateInput.min = d.toISOString().slice(0, 10);
  }
  const timeSelect = $("#session_time");
  if (timeSelect) {
    cfg.sessionStartTimes.forEach((t) => {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = t;
      timeSelect.appendChild(o);
    });
  }

  /* Payment methods */
  const payBox = $("#payment-options");
  if (payBox) {
    payBox.innerHTML = cfg.paymentMethods.map((p, i) =>
      '<div class="choice"><input type="radio" name="payment_method" id="pay-' + p.id + '" value="' + p.label + '"' + (i === 0 ? " required" : "") + '>' +
      '<label for="pay-' + p.id + '"><span class="material-symbols-rounded" aria-hidden="true">' + p.icon + '</span><span>' + p.label + '<small>' + p.note + '</small></span></label></div>'
    ).join("");
  }

  /* File pickers */
  form.querySelectorAll(".dropzone").forEach((zone) => {
    const input = zone.querySelector('input[type="file"]');
    const list = document.getElementById(zone.dataset.list);
    const allowed = (input.accept || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const show = () => {
      if (!list) return;
      list.innerHTML = Array.from(input.files).map((f) =>
        '<li><span class="material-symbols-rounded" aria-hidden="true">audio_file</span>' + escapeHtml(f.name) + ' <span class="muted">(' + (f.size / 1048576).toFixed(1) + ' MB)</span></li>'
      ).join("");
    };
    input.addEventListener("change", show);
    ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, () => zone.classList.add("is-over")));
    ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove("is-over")));
    input.dataset.allowed = allowed.join(",");
  });

  /* Pricing */
  function calc() {
    const lines = [];
    let total = 0;
    const p = cfg.pricing;

    if (mode === "rec-mix" || mode === "recording") {
      const h = hoursInput ? clamp(hoursInput) : 0;
      const base = h * p.recordingPerHour;
      const pct = discountFor(h, p.recordingHourDiscounts);
      lines.push({ label: "Recording, " + h + (h === 1 ? " hour" : " hours") + " x " + money(p.recordingPerHour), value: money(base) });
      if (pct) lines.push({ label: pct + "% multi hour discount", value: "-" + money(base * pct / 100), discount: true });
      total += base * (1 - pct / 100);
      setText("hours-price", money(base * (1 - pct / 100)) + (pct ? " after " + pct + "% off" : ""));
    }
    if (mode === "rec-mix" || mode === "mix") {
      const t = tracksInput ? clamp(tracksInput) : 0;
      const base = t * p.mixMasterPerTrack;
      const pct = discountFor(t, p.mixMasterTrackDiscounts);
      lines.push({ label: "Mix and master, " + t + (t === 1 ? " track" : " tracks") + " x " + money(p.mixMasterPerTrack), value: money(base) });
      if (pct) lines.push({ label: pct + "% multi track discount", value: "-" + money(base * pct / 100), discount: true });
      total += base * (1 - pct / 100);
      setText("tracks-price", money(base * (1 - pct / 100)) + (pct ? " after " + pct + "% off" : ""));
    }
    if (mode === "recording" && tracksInput) {
      const t = clamp(tracksInput);
      lines.push({ label: "Tracks to record", value: String(t) });
    }

    if (summaryLines) {
      summaryLines.innerHTML = lines.map((l) =>
        "<div" + (l.discount ? ' class="discount"' : "") + "><dt>" + l.label + "</dt><dd>" + l.value + "</dd></div>"
      ).join("");
    }
    if (summaryTotal) {
      const next = mode === "quote" ? "Quote" : money(total);
      if (summaryTotal.textContent && summaryTotal.textContent !== next) {
        summaryTotal.classList.remove("bump");
        void summaryTotal.offsetWidth; // restart the pulse animation
        summaryTotal.classList.add("bump");
      }
      summaryTotal.textContent = next;
    }
    return { lines, total };
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  form.addEventListener("input", (e) => {
    if (e.target === tracksInput) syncTitles();
    if (e.target.closest(".field")) e.target.closest(".field").classList.remove("has-error");
    calc();
  });
  if (tracksInput) tracksInput.addEventListener("blur", () => { tracksInput.value = clamp(tracksInput); syncTitles(); calc(); });
  if (hoursInput) hoursInput.addEventListener("blur", () => { hoursInput.value = clamp(hoursInput); calc(); });

  syncTitles();
  calc();

  /* Validation */
  function validate() {
    let firstBad = null;
    const mark = (field, bad) => {
      if (!field) return;
      field.classList.toggle("has-error", bad);
      if (bad && !firstBad) firstBad = field;
    };

    form.querySelectorAll(".field").forEach((f) => f.classList.remove("has-error"));

    form.querySelectorAll("input[required], select[required], textarea[required]").forEach((el) => {
      if (el.type === "radio") return;
      if (el.type === "checkbox") { mark(el.closest(".field"), !el.checked); return; }
      if (el.type === "file") return;
      const empty = !el.value.trim();
      const badEmail = el.type === "email" && el.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value);
      const badPhone = el.type === "tel" && el.value && el.value.replace(/\D/g, "").length < 9;
      mark(el.closest(".field"), empty || badEmail || badPhone);
    });

    const pay = form.querySelector('input[name="payment_method"]');
    if (pay) mark(pay.closest(".field"), !form.querySelector('input[name="payment_method"]:checked'));

    form.querySelectorAll("[data-file-or-link]").forEach((group) => {
      const file = group.querySelector('input[type="file"]');
      const link = group.querySelector('input[type="url"]');
      const hasFile = file && file.files.length > 0;
      const hasLink = link && link.value.trim().length > 0;
      let bad = !hasFile && !hasLink;
      if (hasFile && file.dataset.allowed) {
        const ok = file.dataset.allowed.split(",");
        bad = bad || Array.from(file.files).some((f) => !ok.some((ext) => f.name.toLowerCase().endsWith(ext)));
      }
      if (hasLink && !/^https?:\/\/\S+$/i.test(link.value.trim())) bad = true;
      mark(group, bad);
    });

    if (firstBad) {
      firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
      const focusable = firstBad.querySelector("input, select, textarea");
      if (focusable) focusable.focus({ preventScroll: true });
    }
    return !firstBad;
  }

  /* Summary text for WhatsApp, email and the form service */
  function reference() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return "AH-" + String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  }

  function buildSummary(ref) {
    const v = (name) => { const el = form.elements[name]; return el ? (el.value || "").trim() : ""; };
    const out = [];
    out.push(cfg.studioName + " " + (noun === "message" ? "message" : noun === "request" ? "quote request" : "booking request"));
    out.push("Reference: " + ref);
    out.push("Service: " + serviceName);
    out.push("");
    out.push("Artist: " + v("artist_name"));
    out.push("Email: " + v("email"));
    out.push("Phone: " + v("phone"));
    if (v("session_date")) out.push("Session: " + v("session_date") + " at " + v("session_time") + (hoursInput ? ", " + clamp(hoursInput) + " hours" : ""));
    if (tracksInput) {
      out.push("Tracks: " + clamp(tracksInput));
      form.querySelectorAll('#track-titles input').forEach((el, i) => out.push("  " + (i + 1) + ". " + el.value.trim()));
    }
    form.querySelectorAll("[data-file-or-link]").forEach((group) => {
      const label = group.dataset.fileOrLink;
      const file = group.querySelector('input[type="file"]');
      const link = group.querySelector('input[type="url"]');
      const names = file ? Array.from(file.files).map((f) => f.name) : [];
      if (names.length) out.push(label + ": " + names.join(", "));
      if (link && link.value.trim()) out.push(label + " link: " + link.value.trim());
    });
    form.querySelectorAll("[data-summary-field]").forEach((el) => {
      if (el.value && el.value.trim()) out.push(el.dataset.summaryField + ": " + el.value.trim());
    });
    const pay = form.querySelector('input[name="payment_method"]:checked');
    if (pay) out.push("Payment method: " + pay.value);
    if (mode !== "quote") {
      const { lines, total } = calc();
      out.push("");
      lines.forEach((l) => out.push(l.label + ": " + l.value));
      out.push("Estimated total: " + money(total));
    }
    if (v("notes")) { out.push(""); out.push("Notes: " + v("notes")); }
    return out.join("\n");
  }

  /* Submit */
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validate()) return;

    const ref = reference();
    const summary = buildSummary(ref);
    const submitBtn = form.querySelector('button[type="submit"]');

    if (cfg.formEndpoint) {
      submitBtn.disabled = true;
      submitBtn.querySelector(".label").textContent = "Sending";
      const data = new FormData(form);
      data.append("reference", ref);
      data.append("service", serviceName);
      data.append("summary", summary);
      try {
        const res = await fetch(cfg.formEndpoint, { method: "POST", body: data, headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        showConfirmation(ref, summary, true);
      } catch (err) {
        showConfirmation(ref, summary, false, true);
      } finally {
        submitBtn.disabled = false;
        submitBtn.querySelector(".label").textContent = submitBtn.dataset.label;
      }
    } else {
      showConfirmation(ref, summary, false);
    }
  });

  function showConfirmation(ref, summary, sent, failed) {
    const heading = confirmation.querySelector("[data-heading]");
    const intro = confirmation.querySelector("[data-intro]");
    const pre = confirmation.querySelector("pre");
    const waBtn = confirmation.querySelector("[data-send-whatsapp]");
    const mailBtn = confirmation.querySelector("[data-send-email]");

    pre.textContent = summary;
    if (sent) {
      heading.textContent = "Request sent. Reference " + ref;
      intro.textContent = noun === "booking"
        ? "We have your request and will contact you on " + form.elements.phone.value.trim() + " to confirm your booking and payment details."
        : "Thanks. We will get back to you on " + form.elements.phone.value.trim() + " or by email.";
      waBtn.hidden = true;
      mailBtn.hidden = true;
    } else {
      heading.textContent = "Your " + noun + " is ready to send. Reference " + ref;
      intro.textContent = failed
        ? "We could not send this online. Send it to us on WhatsApp or email instead."
        : noun === "booking"
          ? "Send this summary to us on WhatsApp or email to lock in your booking. Please share your audio files in the same chat or as a Google Drive or WeTransfer link."
          : "Send this to us on WhatsApp or email and we will get back to you.";
      waBtn.hidden = !cfg.contact.whatsapp;
      waBtn.href = "https://wa.me/" + cfg.contact.whatsapp + "?text=" + encodeURIComponent(summary);
      mailBtn.hidden = !cfg.contact.email;
      mailBtn.href = "mailto:" + cfg.contact.email + "?subject=" + encodeURIComponent("Booking request " + ref) + "&body=" + encodeURIComponent(summary);
    }
    confirmation.hidden = false;
    confirmation.scrollIntoView({ behavior: "smooth", block: "start" });
    confirmation.focus({ preventScroll: true });
  }

  const copyBtn = confirmation && confirmation.querySelector("[data-copy-summary]");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const pre = confirmation.querySelector("pre");
      const label = copyBtn.querySelector(".label");
      try {
        await navigator.clipboard.writeText(pre.textContent);
        label.textContent = "Copied";
      } catch (e) {
        const r = document.createRange();
        r.selectNodeContents(pre);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        label.textContent = "Selected, press Ctrl+C";
      }
      setTimeout(() => (label.textContent = "Copy summary"), 1800);
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();

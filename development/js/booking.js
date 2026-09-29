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
        '<label for="' + id + '">Track ' + i + ' title <span class="optional">(optional)</span></label>' +
        '<input type="text" id="' + id + '" name="' + id + '" autocomplete="off" placeholder="Working title is fine">';
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

  /* Hours left before closing for the chosen start time */
  function syncMaxHours() {
    if (!hoursInput) return;
    let max = cfg.maxSessionHours;
    if (timeSelect && timeSelect.value && cfg.closingTime) {
      const mins = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
      max = Math.min(max, Math.floor((mins(cfg.closingTime) - mins(timeSelect.value)) / 60));
    }
    hoursInput.max = Math.max(1, max);
    if (Number(hoursInput.value) > hoursInput.max) hoursInput.value = hoursInput.max;
  }
  if (timeSelect) timeSelect.addEventListener("change", () => { syncMaxHours(); calc(); });

  /* Payment methods */
  const payBox = $("#payment-options");
  if (payBox) {
    payBox.innerHTML = cfg.paymentMethods.map((p, i) =>
      '<div class="choice"><input type="radio" name="payment_method" id="pay-' + p.id + '" value="' + p.label + '"' + (i === 0 ? " required" : "") + '>' +
      '<label for="pay-' + p.id + '">' +
      (p.logo ? '<img class="pay-logo" src="' + p.logo + '" alt="" width="32" height="32">' : '<span class="material-symbols-rounded" aria-hidden="true">' + p.icon + '</span>') +
      '<span>' + p.label + '<small>' + p.note + '</small></span></label></div>'
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
  syncMaxHours();
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
      // A file, a link, or both. Links pasted without https:// (drive.google.com/..., we.tl/...) get it added.
      if (link && link.value.trim() && !/^[a-z]+:\/\//i.test(link.value.trim())) link.value = "https://" + link.value.trim();
      const hasFile = file && file.files.length > 0;
      const hasLink = link && link.value.trim().length > 0;
      let bad = !hasFile && !hasLink && !("optional" in group.dataset);
      if (hasFile && file.dataset.allowed) {
        const ok = file.dataset.allowed.split(",");
        bad = bad || Array.from(file.files).some((f) => !ok.some((ext) => f.name.toLowerCase().endsWith(ext)));
      }
      // Files over the upload limit: ask for a link instead. Only applies when files are uploaded to Supabase.
      const errorText = group.querySelector(".error-text");
      if (errorText && !errorText.dataset.text) errorText.dataset.text = errorText.textContent;
      const limit = (cfg.maxUploadMB || 50) * 1048576;
      const tooBig = sb && hasFile && Array.from(file.files).some((f) => f.size > limit);
      if (errorText) {
        errorText.textContent = tooBig
          ? "Files over " + (cfg.maxUploadMB || 50) + " MB are too large to upload here. Remove them and share a Google Drive or WeTransfer link instead."
          : errorText.dataset.text;
      }
      bad = bad || tooBig;
      if (hasLink && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(link.value.trim())) bad = true;
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
      form.querySelectorAll('#track-titles input').forEach((el, i) => { if (el.value.trim()) out.push("  " + (i + 1) + ". " + el.value.trim()); });
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

  /* Supabase: bookings table and booking-files bucket (see supabase/schema.sql).
     The client library is only downloaded once someone starts filling in the form. */
  const sb = cfg.supabase && cfg.supabase.url && cfg.supabase.anonKey ? cfg.supabase : null;
  let clientPromise = null;
  function supabaseClient() {
    if (!clientPromise) {
      clientPromise = import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm")
        .then(({ createClient }) => createClient(sb.url, sb.anonKey, { auth: { persistSession: false, autoRefreshToken: false } }))
        .catch((err) => { clientPromise = null; throw err; });
    }
    return clientPromise;
  }
  if (sb) form.addEventListener("focusin", () => supabaseClient().catch(() => {}), { once: true });

  function safeName(name) {
    return name.normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").slice(-120);
  }

  async function saveToSupabase(ref, summary, progress) {
    const client = await supabaseClient();
    const v = (name) => { const el = form.elements[name]; return el && el.value ? el.value.trim() : ""; };

    // The booking is saved first and lists its files. The database only accepts uploads
    // that a booking made in the last hour lists (see supabase/schema.sql).
    const uploads = [];
    form.querySelectorAll('input[type="file"]').forEach((input) => {
      Array.from(input.files).forEach((file) => uploads.push({ field: input.name, file }));
    });
    uploads.forEach((u, i) => (u.path = ref + "/" + u.field + "/" + (i + 1) + "-" + safeName(u.file.name)));
    const files = uploads.map((u) => ({ field: u.field, name: u.file.name, path: u.path, size: u.file.size }));

    const details = {};
    form.querySelectorAll("[data-summary-field]").forEach((el) => {
      if (el.value && el.value.trim()) details[el.dataset.summaryField] = el.value.trim();
    });
    form.querySelectorAll("[data-file-or-link]").forEach((group) => {
      const link = group.querySelector('input[type="url"]');
      if (link && link.value.trim()) details[group.dataset.fileOrLink + " link"] = link.value.trim();
    });
    const pay = form.querySelector('input[name="payment_method"]:checked');

    progress("Sending");
    const { error } = await client.from("bookings").insert({
      reference: ref,
      service: serviceName,
      kind: noun === "message" ? "message" : noun === "request" ? "request" : "booking",
      artist_name: v("artist_name"),
      email: v("email"),
      phone: v("phone"),
      session_date: v("session_date") || null,
      session_time: v("session_time") || null,
      hours: hoursInput ? clamp(hoursInput) : null,
      tracks: tracksInput ? clamp(tracksInput) : null,
      track_titles: Array.from(form.querySelectorAll("#track-titles input")).map((el) => el.value.trim()),
      payment_method: pay ? pay.value : null,
      estimated_total: mode === "quote" ? null : Math.round(calc().total),
      notes: v("notes") || null,
      details,
      files,
      summary
    });
    if (error) throw error;

    // Returns the names of any files that did not upload. The booking itself is already saved.
    const failed = [];
    for (let i = 0; i < uploads.length; i++) {
      progress("Uploading " + (i + 1) + " of " + uploads.length);
      const { error: upErr } = await client.storage.from("booking-files")
        .upload(uploads[i].path, uploads[i].file, { contentType: uploads[i].file.type || "application/octet-stream", upsert: false });
      if (upErr) { console.error("Upload failed", uploads[i].file.name, upErr); failed.push(uploads[i].file.name); }
    }
    // Files are up: send the studio's email now, with them attached. A timer also does this every 5 minutes.
    if (uploads.length) client.functions.invoke("booking-alert", { body: {} }).catch(() => {});
    return failed;
  }

  async function postToEndpoint(ref, summary) {
    const data = new FormData(form);
    data.append("reference", ref);
    data.append("service", serviceName);
    data.append("summary", summary);
    const res = await fetch(cfg.formEndpoint, { method: "POST", body: data, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
  }

  /* Submit */
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validate()) return;

    const ref = reference();
    const summary = buildSummary(ref);
    const submitBtn = form.querySelector('button[type="submit"]');
    const label = submitBtn.querySelector(".label");

    if (!sb && !cfg.formEndpoint) {
      showConfirmation(ref, summary, false);
      return;
    }
    submitBtn.disabled = true;
    label.textContent = "Sending";
    try {
      let failedFiles = [];
      if (sb) failedFiles = await saveToSupabase(ref, summary, (text) => (label.textContent = text));
      else await postToEndpoint(ref, summary);
      showConfirmation(ref, summary, true, false, failedFiles);
    } catch (err) {
      console.error("Booking could not be sent", err);
      showConfirmation(ref, summary, false, true);
    } finally {
      submitBtn.disabled = false;
      label.textContent = submitBtn.dataset.label;
    }
  });

  function showConfirmation(ref, summary, sent, failed, failedFiles) {
    const heading = confirmation.querySelector("[data-heading]");
    const intro = confirmation.querySelector("[data-intro]");
    const pre = confirmation.querySelector("pre");
    const waBtn = confirmation.querySelector("[data-send-whatsapp]");
    const mailBtn = confirmation.querySelector("[data-send-email]");

    pre.textContent = summary;
    if (sent) {
      heading.textContent = "Request sent. Reference " + ref;
      // Built from text nodes so nothing the client typed is treated as HTML.
      const clientPhone = form.elements.phone.value.trim();
      const clientEmail = form.elements.email.value.trim();
      const studioPhone = cfg.contact.phone;
      intro.textContent = (noun === "booking"
        ? "We have your request and will contact you on " + clientPhone + " or " + clientEmail + " to confirm your booking and payment details."
        : "Thanks. We will get back to you on " + clientPhone + " or " + clientEmail + ".");
      if (studioPhone) {
        const call = document.createElement("a");
        call.href = "tel:" + studioPhone.replace(/[^\d+]/g, "");
        call.textContent = studioPhone;
        intro.append(" If you don't hear from us within 24 hours, call or WhatsApp us on ", call, ".");
      }
      waBtn.hidden = !cfg.contact.whatsapp;
      waBtn.href = "https://wa.me/" + cfg.contact.whatsapp + "?text=" + encodeURIComponent("Hi, following up on my " + (noun === "booking" ? "booking" : noun) + " " + ref);
      mailBtn.hidden = true;
      if (failedFiles && failedFiles.length) {
        // Booking saved but some audio did not upload: offer WhatsApp so the files can be sent there.
        intro.append(" Some files did not upload (" + failedFiles.join(", ") + "). Please send them to us on WhatsApp or as a Google Drive or WeTransfer link, quoting reference " + ref + ".");
        waBtn.href = "https://wa.me/" + cfg.contact.whatsapp + "?text=" + encodeURIComponent("Files for booking " + ref);
      }
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

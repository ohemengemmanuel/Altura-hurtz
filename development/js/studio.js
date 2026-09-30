/* Studio dashboard: sign in, list bookings, update status and notes, download client files.
   Data lives in Supabase (see supabase/schema.sql). Only accounts listed in public.staff can read it. */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.AH_CONFIG || {};
const cur = cfg.currency || "GH₵";
const $ = (id) => document.getElementById(id);

const STATUSES = [
  { id: "new", label: "New", icon: "notifications_active" },
  { id: "confirmed", label: "Confirmed", icon: "event_available" },
  { id: "paid", label: "Paid", icon: "paid" },
  { id: "completed", label: "Completed", icon: "task_alt" },
  { id: "cancelled", label: "Cancelled", icon: "cancel" }
];
const statusLabel = (id) => (STATUSES.find((s) => s.id === id) || { label: id }).label;

const views = ["setup-view", "login-view", "reset-view", "denied-view", "dash-view"];
function show(view) {
  views.forEach((v) => ($(v).hidden = v !== view));
}

if (!cfg.supabase || !cfg.supabase.url || !cfg.supabase.anonKey) {
  show("setup-view");
  throw new Error("Supabase is not configured in js/config.js");
}

const supabase = createClient(cfg.supabase.url, cfg.supabase.anonKey);

/* State */
let bookings = [];
let filter = { status: "all", service: "", q: "", view: "list", upcoming: false };
let channel = null;
let unseen = 0;
let openId = null;

/* Formatting */
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => cur + Math.round(Number(n) || 0).toLocaleString("en-GH");
const hhmm = (t) => (t ? String(t).slice(0, 5) : "");
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = (iso, long) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", long
  ? { weekday: "long", day: "numeric", month: "long", year: "numeric" }
  : { weekday: "short", day: "numeric", month: "short" });
const fmtAgo = (ts) => {
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 604800) return Math.floor(s / 86400) + " d ago";
  return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
const endTime = (t, h) => {
  if (!t || !h) return "";
  const [hh, mm] = hhmm(t).split(":").map(Number);
  const m = hh * 60 + mm + h * 60;
  return String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
};
// Ghana numbers written as 024... become 23324... for WhatsApp.
const waNumber = (phone) => {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "233" + d.slice(1);
  else if (d.length === 9) d = "233" + d;
  return d;
};

/* Toast */
let toastTimer;
function toast(text, icon = "check_circle") {
  const el = $("toast");
  el.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">' + icon + "</span>" + esc(text);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

/* Auth */
let recovering = location.hash.includes("type=recovery");
async function start() {
  const { data } = await supabase.auth.getSession();
  if (recovering) return; // the reset link signs in first; show the new password form instead of the dashboard
  await enter(data.session);
}

async function enter(session) {
  if (!session) {
    stopLive();
    $("studio-user").hidden = true;
    show("login-view");
    return;
  }
  $("studio-email").textContent = session.user.email || "";
  $("studio-user").hidden = false;

  const { data: staff, error } = await supabase.from("staff").select("user_id").eq("user_id", session.user.id).maybeSingle();
  if (error || !staff) {
    show("denied-view");
    return;
  }
  show("dash-view");
  await load();
  openFromLink();
  startLive();
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") { recovering = true; show("reset-view"); return; }
  if (event === "SIGNED_OUT") enter(null);
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = $("login-message");
  const btn = form.querySelector('button[type="submit"]');
  msg.hidden = true;
  btn.disabled = true;
  const { data, error } = await supabase.auth.signInWithPassword({
    email: form.email.value.trim(),
    password: form.password.value
  });
  btn.disabled = false;
  if (error) {
    msg.textContent = error.message === "Invalid login credentials" ? "Wrong email or password." : error.message;
    msg.hidden = false;
    return;
  }
  form.password.value = "";
  enter(data.session);
});

$("forgot").addEventListener("click", async () => {
  const email = $("login-email").value.trim();
  const msg = $("login-message");
  if (!email) {
    msg.textContent = "Enter your email above first, then press Forgot password again.";
    msg.hidden = false;
    return;
  }
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  msg.textContent = error ? error.message : "If that email has studio access, a reset link is on its way.";
  msg.hidden = false;
});

$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("new-password").value;
  const msg = $("reset-message");
  if (pw.length < 8) { msg.textContent = "Use at least 8 characters."; msg.hidden = false; return; }
  const { data, error } = await supabase.auth.updateUser({ password: pw });
  if (error) { msg.textContent = error.message; msg.hidden = false; return; }
  history.replaceState(null, "", location.pathname);
  recovering = false;
  toast("Password updated");
  const { data: s } = await supabase.auth.getSession();
  enter(s.session || (data && data.session));
});

$("sign-out").addEventListener("click", () => supabase.auth.signOut());

/* Data */
async function load() {
  const list = $("booking-list");
  if (!bookings.length) list.innerHTML = '<p class="muted studio-loading">Loading bookings…</p>';
  const { data, error } = await supabase.from("bookings").select("*").order("created_at", { ascending: false }).limit(1000);
  if (error) {
    list.innerHTML = '<div class="empty-state"><span class="material-symbols-rounded" aria-hidden="true">error</span><p>Could not load bookings: ' + esc(error.message) + "</p></div>";
    return;
  }
  bookings = data;
  render();
}

function upsert(row) {
  const i = bookings.findIndex((b) => b.id === row.id);
  if (i === -1) bookings.unshift(row);
  else bookings[i] = row;
  bookings.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function startLive() {
  if (channel) return;
  channel = supabase.channel("bookings-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, (payload) => {
      if (payload.eventType === "DELETE") {
        bookings = bookings.filter((b) => b.id !== payload.old.id);
      } else {
        upsert(payload.new);
        if (payload.eventType === "INSERT") {
          toast("New " + payload.new.service.toLowerCase() + " from " + payload.new.artist_name, "notifications_active");
          if (document.hidden) { unseen++; updateTitle(); }
        }
      }
      render();
      // Keep the open booking current (for example "Payment details emailed" appearing).
      if (payload.new && payload.new.id === openId && !confirmDialog.open) refreshOpen();
    })
    .subscribe((status) => $("live").classList.toggle("is-on", status === "SUBSCRIBED"));
}

function stopLive() {
  if (channel) { supabase.removeChannel(channel); channel = null; }
  $("live").classList.remove("is-on");
}

function updateTitle() {
  document.title = (unseen ? "(" + unseen + ") " : "") + "Studio Bookings | Altura Hertz Productions";
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) { unseen = 0; updateTitle(); } });

/* Filters */
function matches(b) {
  if (filter.status !== "all" && b.status !== filter.status) return false;
  if (filter.service && b.service !== filter.service) return false;
  if (filter.upcoming) {
    const t = todayISO();
    if (!b.session_date || b.session_date < t || b.session_date > addDays(t, 7) || b.status === "cancelled") return false;
  }
  if (filter.q) {
    const q = filter.q.toLowerCase();
    const hay = [b.artist_name, b.phone, b.email, b.reference, b.payment_ref].join(" ").toLowerCase();
    const digits = q.replace(/\D/g, "");
    const phoneHit = digits.length >= 3 && String(b.phone).replace(/\D/g, "").includes(digits);
    if (!hay.includes(q) && !phoneHit) return false;
  }
  return true;
}

function renderTabs() {
  const counts = { all: bookings.length };
  STATUSES.forEach((s) => (counts[s.id] = bookings.filter((b) => b.status === s.id).length));
  const tabs = [{ id: "all", label: "All" }].concat(STATUSES);
  $("status-tabs").innerHTML = tabs.map((t) =>
    '<button type="button" role="tab" data-status="' + t.id + '" aria-selected="' + (filter.status === t.id) + '">' +
    esc(t.label) + '<span class="count">' + counts[t.id] + "</span></button>"
  ).join("");

  const select = $("service-filter");
  const services = [...new Set(bookings.map((b) => b.service))].sort();
  const current = select.value;
  select.innerHTML = '<option value="">All services</option>' + services.map((s) => '<option' + (s === current ? " selected" : "") + ">" + esc(s) + "</option>").join("");
}

function renderStats() {
  const t = todayISO(), week = addDays(t, 7);
  const month = t.slice(0, 7);
  $("stat-new").textContent = bookings.filter((b) => b.status === "new").length;
  $("stat-upcoming").textContent = bookings.filter((b) => b.session_date && b.session_date >= t && b.session_date <= week && b.status !== "cancelled").length;
  $("stat-confirmed").textContent = bookings.filter((b) => b.status === "confirmed").length;
  $("stat-month").textContent = money(bookings
    .filter((b) => (b.status === "paid" || b.status === "completed") && String(b.paid_at).slice(0, 7) === month)
    .reduce((sum, b) => sum + (Number(amountOf(b)) || 0), 0));
  document.querySelectorAll(".stat[data-stat]").forEach((el) => {
    const on = el.dataset.stat === "upcoming" ? filter.upcoming : !filter.upcoming && filter.status === el.dataset.stat;
    el.classList.toggle("is-active", on);
  });
}

function pill(status) {
  return '<span class="status-pill" data-status="' + status + '">' + esc(statusLabel(status)) + "</span>";
}

// What the client is asked to pay: the amount set when confirming, otherwise the website estimate.
const amountOf = (b) => (b.amount_due != null ? b.amount_due : b.estimated_total);
const fmtStamp = (ts) => new Date(ts).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtClock = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// A confirmed booking holds its slot until hold_expires_at (3 hours, set by the database).
function holdState(b) {
  if (b.status !== "confirmed" || !b.hold_expires_at) return null;
  return { active: new Date(b.hold_expires_at) > new Date(), until: b.hold_expires_at };
}
function holdBadge(b) {
  const h = holdState(b);
  if (!h) return "";
  return h.active
    ? '<span class="hold-badge">Held until ' + esc(fmtClock(h.until)) + "</span>"
    : '<span class="hold-badge is-expired">Hold expired</span>';
}

// Other bookings that already have this slot: paid, completed, or confirmed and still held.
function slotConflicts(b) {
  if (!b.session_date || !b.session_time) return [];
  const mins = (x) => { const [h, m] = hhmm(x.session_time).split(":").map(Number); return h * 60 + m; };
  const start = mins(b), end = start + (b.hours || 1) * 60;
  return bookings.filter((o) => {
    if (o.id === b.id || o.session_date !== b.session_date || !o.session_time) return false;
    const h = holdState(o);
    if (!(o.status === "paid" || o.status === "completed" || (h && h.active))) return false;
    const s = mins(o), e = s + (o.hours || 1) * 60;
    return s < end && start < e;
  });
}

function sessionText(b) {
  if (!b.session_date) return "";
  return fmtDate(b.session_date) + (b.session_time ? ", " + hhmm(b.session_time) : "") + (b.hours ? " · " + b.hours + (b.hours === 1 ? " hr" : " hrs") : "");
}

function renderList(rows) {
  const list = $("booking-list");
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state"><span class="material-symbols-rounded" aria-hidden="true">inbox</span><p>' +
      (bookings.length ? "No bookings match these filters." : "No bookings yet. New ones show up here as soon as clients send them.") + "</p></div>";
    return;
  }
  list.innerHTML = rows.map((b) => {
    const when = sessionText(b);
    const extra = b.tracks ? b.tracks + (b.tracks === 1 ? " track" : " tracks") : "";
    const files = (b.files || []).length;
    return '<button type="button" class="booking-row' + (b.status === "new" ? " is-new" : "") + '" data-id="' + b.id + '">' +
      '<span class="booking-who"><strong>' + esc(b.artist_name) + '</strong><span class="muted">' + esc(b.service) + "</span></span>" +
      '<span class="booking-when">' + (when ? '<span class="material-symbols-rounded" aria-hidden="true">event</span>' + esc(when) : '<span class="muted">' + (b.kind === "message" ? "Message" : b.kind === "request" ? "Quote request" : "No session") + "</span>") +
        (extra ? '<span class="muted">' + esc(extra) + "</span>" : "") + "</span>" +
      '<span class="booking-meta">' + (files ? '<span class="material-symbols-rounded" aria-hidden="true" title="' + files + ' files">attach_file</span>' : "") +
        '<span class="booking-total">' + (b.estimated_total != null ? money(b.estimated_total) : "Quote") + "</span></span>" +
      '<span class="booking-state">' + pill(b.status) + holdBadge(b) + '<span class="muted booking-ago" title="' + esc(new Date(b.created_at).toLocaleString("en-GB")) + '">' + fmtAgo(b.created_at) + "</span></span>" +
      "</button>";
  }).join("");
}

// Upcoming sessions grouped by day. Overlapping sessions on the same day are flagged.
function renderSchedule(rows) {
  const box = $("schedule");
  const t = todayISO();
  const sessions = rows.filter((b) => b.session_date && b.session_date >= t && b.status !== "cancelled")
    .sort((a, b) => (a.session_date + hhmm(a.session_time)).localeCompare(b.session_date + hhmm(b.session_time)));
  if (!sessions.length) {
    box.innerHTML = '<div class="empty-state"><span class="material-symbols-rounded" aria-hidden="true">event_busy</span><p>No upcoming sessions.</p></div>';
    return;
  }
  const days = {};
  sessions.forEach((b) => (days[b.session_date] = days[b.session_date] || []).push(b));
  const mins = (b) => { const [h, m] = hhmm(b.session_time || "00:00").split(":").map(Number); return h * 60 + m; };
  box.innerHTML = Object.keys(days).map((day) => {
    const list = days[day];
    const clash = new Set();
    list.forEach((a, i) => list.slice(i + 1).forEach((b) => {
      if (mins(a) < mins(b) + (b.hours || 1) * 60 && mins(b) < mins(a) + (a.hours || 1) * 60) { clash.add(a.id); clash.add(b.id); }
    }));
    const label = day === t ? "Today" : day === addDays(t, 1) ? "Tomorrow" : fmtDate(day);
    return '<section class="schedule-day"><h3>' + esc(label) + '<span class="muted">' + list.length + (list.length === 1 ? " session" : " sessions") + "</span></h3>" +
      list.map((b) =>
        '<button type="button" class="schedule-item' + (clash.has(b.id) ? " is-clash" : "") + '" data-id="' + b.id + '">' +
        '<span class="schedule-time">' + esc(hhmm(b.session_time)) + (b.hours ? "–" + esc(endTime(b.session_time, b.hours)) : "") + "</span>" +
        '<span class="booking-who"><strong>' + esc(b.artist_name) + '</strong><span class="muted">' + esc(b.service) + "</span></span>" +
        (clash.has(b.id) ? '<span class="clash-tag"><span class="material-symbols-rounded" aria-hidden="true">warning</span>Overlaps</span>' : "") +
        holdBadge(b) + pill(b.status) + "</button>"
      ).join("") + "</section>";
  }).join("");
}

function render() {
  renderTabs();
  renderStats();
  const rows = bookings.filter(matches);
  $("booking-list").hidden = filter.view !== "list";
  $("schedule").hidden = filter.view !== "schedule";
  if (filter.view === "list") renderList(rows);
  else renderSchedule(rows);
  document.querySelectorAll(".view-toggle button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === filter.view)));
}

$("status-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-status]");
  if (!tab) return;
  filter.status = tab.dataset.status;
  filter.upcoming = false;
  render();
});
$("service-filter").addEventListener("change", (e) => { filter.service = e.target.value; render(); });
$("search").addEventListener("input", (e) => { filter.q = e.target.value.trim(); render(); });
document.querySelector(".view-toggle").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (b) { filter.view = b.dataset.view; render(); }
});
document.querySelector(".stat-grid").addEventListener("click", (e) => {
  const s = e.target.closest("[data-stat]");
  if (!s) return;
  if (s.dataset.stat === "upcoming") {
    filter = { ...filter, status: "all", upcoming: !filter.upcoming };
  } else {
    filter = { ...filter, upcoming: false, status: filter.status === s.dataset.stat ? "all" : s.dataset.stat, view: "list" };
  }
  render();
});
$("refresh").addEventListener("click", load);
document.addEventListener("click", (e) => {
  const row = e.target.closest(".booking-row, .schedule-item");
  if (row) openBooking(row.dataset.id);
});

/* Booking detail */
const dialog = $("booking-dialog");

function clientMessage(b) {
  let text = "Hi " + b.artist_name + ", this is " + (cfg.studioName || "Altura Hertz Productions") + " about your " + b.service.toLowerCase() + " " + (b.kind === "booking" ? "booking" : "request") + " (" + b.reference + ").";
  if (b.session_date) text += " We have you down for " + fmtDate(b.session_date, true) + (b.session_time ? " at " + hhmm(b.session_time) : "") + (b.hours ? " for " + b.hours + (b.hours === 1 ? " hour" : " hours") : "") + ".";
  if (b.estimated_total != null) text += " The total is " + money(b.estimated_total) + ".";
  return text;
}

function row(label, value) {
  return value ? "<div><dt>" + esc(label) + "</dt><dd>" + value + "</dd></div>" : "";
}

function holdRow(b) {
  const h = holdState(b);
  if (!h) return "";
  return h.active
    ? "Held until " + esc(fmtStamp(h.until))
    : '<span class="hold-expired">Hold expired ' + esc(fmtStamp(h.until)) + "</span>. The slot is free on the website again.";
}

// The automatic email for the current status: sent, on its way, or failed.
function clientEmailRow(b) {
  const which = { confirmed: ["confirmed_email_at", "Payment details"], paid: ["paid_email_at", "Payment received"], cancelled: ["cancelled_email_at", "Cancellation"] }[b.status];
  if (!which) return "";
  const sentAt = b[which[0]];
  if (sentAt) return esc(which[1]) + " email sent " + esc(fmtStamp(sentAt));
  if ((b.client_email_attempts || 0) >= 3) return '<span class="hold-expired">' + esc(which[1]) + " email could not be sent.</span> Contact the client on WhatsApp.";
  return esc(which[1]) + " email sending…";
}

async function openBooking(id) {
  const b = bookings.find((x) => x.id === id);
  if (!b) return;
  openId = id;
  const wa = waNumber(b.phone);
  const msg = encodeURIComponent(clientMessage(b));
  const titles = (b.track_titles || []).map((t, i) => (t ? i + 1 + ". " + esc(t) : "")).filter(Boolean);
  const details = Object.entries(b.details || {}).map(([k, v]) =>
    row(k, /^https?:\/\//i.test(v) ? '<a href="' + esc(v) + '" target="_blank" rel="noopener noreferrer">' + esc(v) + "</a>" : esc(v))
  ).join("");
  const files = b.files || [];

  dialog.innerHTML =
    '<div class="dialog-head">' +
      '<div><p class="eyebrow">' + esc(b.reference) + '</p><h2 id="dialog-title">' + esc(b.artist_name) + "</h2>" +
      '<p class="muted">' + esc(b.service) + " · received " + esc(new Date(b.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })) + "</p></div>" +
      '<button type="button" class="icon-btn" data-close aria-label="Close"><span class="material-symbols-rounded" aria-hidden="true">close</span></button>' +
    "</div>" +
    '<div class="dialog-body">' +
      '<div class="contact-actions">' +
        '<a class="btn btn-primary btn-sm" href="https://wa.me/' + esc(wa) + "?text=" + msg + '" target="_blank" rel="noopener"><span class="material-symbols-rounded" aria-hidden="true">chat</span>WhatsApp</a>' +
        '<a class="btn btn-ghost btn-sm" href="tel:' + esc(b.phone.replace(/[^\d+]/g, "")) + '"><span class="material-symbols-rounded" aria-hidden="true">call</span>' + esc(b.phone) + "</a>" +
        '<a class="btn btn-ghost btn-sm" href="mailto:' + esc(b.email) + "?subject=" + encodeURIComponent("Your booking " + b.reference) + "&body=" + msg + '"><span class="material-symbols-rounded" aria-hidden="true">mail</span>' + esc(b.email) + "</a>" +
      "</div>" +

      '<div class="dialog-section"><h3>Status</h3><div class="status-picker" role="group" aria-label="Status">' +
        STATUSES.map((s) => '<button type="button" data-set-status="' + s.id + '" data-status="' + s.id + '" aria-pressed="' + (b.status === s.id) + '"><span class="material-symbols-rounded" aria-hidden="true">' + s.icon + "</span>" + s.label + "</button>").join("") +
      "</div></div>" +

      '<div class="dialog-section"><h3>Booking</h3><dl class="detail-list">' +
        row("Session", b.session_date ? esc(fmtDate(b.session_date, true)) + (b.session_time ? " at " + esc(hhmm(b.session_time)) + (b.hours ? "–" + esc(endTime(b.session_time, b.hours)) : "") : "") : "") +
        row("Hours", b.hours ? String(b.hours) : "") +
        row("Tracks", b.tracks ? String(b.tracks) + (titles.length ? '<span class="detail-sub">' + titles.join("<br>") + "</span>" : "") : "") +
        details +
        row("Payment method", esc(b.payment_method)) +
        row("Estimated total", b.estimated_total != null ? '<span class="detail-money">' + money(b.estimated_total) + "</span>" : "") +
        row("Amount due", b.amount_due != null ? '<span class="detail-money">' + money(b.amount_due) + "</span>" : "") +
        row("Slot hold", holdRow(b)) +
        row("Payment reference", esc(b.payment_ref)) +
        row("Client email", clientEmailRow(b)) +
      "</dl></div>" +

      (b.notes ? '<div class="dialog-section"><h3>Client notes</h3><p class="client-notes">' + esc(b.notes) + "</p></div>" : "") +

      (files.length ? '<div class="dialog-section"><h3>Files</h3><ul class="file-links" id="file-links">' +
        files.map((f) => '<li><span class="material-symbols-rounded" aria-hidden="true">audio_file</span><span class="file-name">' + esc(f.name) + '</span><span class="muted">' + fmtSize(f.size) + "</span>" +
          (b.files_purged_at ? '<span class="muted">Emailed</span>' : '<a class="btn btn-ghost btn-sm is-loading" data-path="' + esc(f.path) + '"><span class="material-symbols-rounded" aria-hidden="true">download</span>Download</a>') + "</li>").join("") +
      "</ul>" +
      (b.files_purged_at
        ? '<p class="muted file-note">These files were emailed to the studio and removed from storage on ' + esc(new Date(b.files_purged_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })) + ". Find them in the booking email.</p>"
        : '<p class="muted file-note">Also attached to the booking email. Removed from storage 14 days after that email.</p>') +
      "</div>" : "") +

      '<div class="dialog-section"><h3><label for="studio-notes">Studio notes</label></h3>' +
        '<textarea id="studio-notes" placeholder="Only the studio sees this. Deposit received, engineer, follow ups">' + esc(b.studio_notes || "") + "</textarea>" +
        '<div class="notes-actions"><button type="button" class="btn btn-primary btn-sm" data-save-notes><span class="material-symbols-rounded" aria-hidden="true">save</span><span class="label">Save notes</span></button></div>' +
      "</div>" +

      '<details class="dialog-section summary-raw"><summary>Full summary as sent</summary><pre>' + esc(b.summary || "") + "</pre>" +
        '<button type="button" class="btn btn-ghost btn-sm" data-copy><span class="material-symbols-rounded" aria-hidden="true">content_copy</span><span class="label">Copy</span></button></details>' +
    "</div>";

  if (!dialog.open) dialog.showModal();

  if (files.length && !b.files_purged_at) {
    const { data, error } = await supabase.storage.from("booking-files").createSignedUrls(files.map((f) => f.path), 3600, { download: true });
    dialog.querySelectorAll("#file-links a[data-path]").forEach((a) => {
      const hit = data && data.find((d) => d.path === a.dataset.path);
      a.classList.remove("is-loading");
      if (!error && hit && hit.signedUrl) a.href = hit.signedUrl;
      else { a.removeAttribute("href"); a.textContent = "Missing"; }
    });
  }
}

async function save(id, changes, done) {
  const { data, error } = await supabase.from("bookings").update(changes).eq("id", id).select().single();
  if (error) { toast("Could not save: " + error.message, "error"); return false; }
  upsert(data);
  render();
  if (done) toast(done);
  return true;
}

dialog.addEventListener("click", async (e) => {
  if (e.target === dialog || e.target.closest("[data-close]")) { dialog.close(); return; }

  const statusBtn = e.target.closest("[data-set-status]");
  if (statusBtn && openId) {
    const status = statusBtn.dataset.setStatus;
    const b = bookings.find((x) => x.id === openId);
    if (!b || b.status === status) return;
    // Confirmed, Paid and Cancelled email the client, so they ask first.
    if (status === "confirmed" || status === "paid" || status === "cancelled") { askStatus(b, status); return; }
    if (await save(openId, { status }, "Marked " + statusLabel(status).toLowerCase())) refreshOpen();
    return;
  }

  const notesBtn = e.target.closest("[data-save-notes]");
  if (notesBtn && openId) {
    notesBtn.disabled = true;
    await save(openId, { studio_notes: $("studio-notes").value.trim() || null }, "Notes saved");
    notesBtn.disabled = false;
    return;
  }

  const copyBtn = e.target.closest("[data-copy]");
  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(dialog.querySelector(".summary-raw pre").textContent);
      copyBtn.querySelector(".label").textContent = "Copied";
      setTimeout(() => (copyBtn.querySelector(".label").textContent = "Copy"), 1400);
    } catch (err) { /* clipboard blocked; the text is still selectable */ }
  }
});
dialog.addEventListener("close", () => { openId = null; });

// Re-draw the open booking without losing notes that haven't been saved yet.
function refreshOpen() {
  if (!openId || !dialog.open) return;
  const notes = $("studio-notes");
  const draft = notes ? notes.value : null;
  const focused = notes && document.activeElement === notes;
  openBooking(openId).then(() => {
    const n = $("studio-notes");
    if (n && draft !== null) { n.value = draft; if (focused) n.focus(); }
  });
}

/* Status confirmations */
const confirmDialog = $("confirm-dialog");

function askStatus(b, status) {
  const first = b.artist_name.split(" ")[0];
  const amount = amountOf(b);
  const holdHours = cfg.holdHours || 3;
  const holdUntil = new Date(Date.now() + holdHours * 3600000);
  const conflicts = status === "confirmed" ? slotConflicts(b) : [];
  const summary = '<p class="confirm-who"><strong>' + esc(b.artist_name) + "</strong> · " + esc(b.service) +
    (b.session_date ? "<br>" + esc(sessionText(b)) : "") + '<br><span class="muted">' + esc(b.reference) + "</span></p>";

  let title, body, action, danger = false;
  if (status === "confirmed") {
    title = "Confirm this booking?";
    body = summary +
      '<div class="field"><label for="confirm-amount">Amount due (' + esc(cur) + ')</label>' +
      '<input type="number" id="confirm-amount" min="1" step="1" inputmode="numeric" required value="' + (amount != null ? Math.round(amount) : "") + '">' +
      '<span class="hint">' + (b.estimated_total != null ? "Website estimate: " + money(b.estimated_total) + ". Change it if the price is different." : "Set the price for this request.") + "</span>" +
      '<span class="error-text">Enter the amount the client should pay.</span></div>' +
      (conflicts.length ? '<p class="confirm-warn"><span class="material-symbols-rounded" aria-hidden="true">warning</span>This overlaps ' +
        conflicts.map((o) => esc(o.artist_name) + " (" + esc(statusLabel(o.status).toLowerCase()) + ", " + esc(sessionText(o)) + ")").join(", ") + ".</p>" : "") +
      '<p class="confirm-note">' + esc(first) + " will be emailed the amount and payment details" +
      (b.session_date ? ", and this slot is held for " + holdHours + " hours, until <strong>" + esc(fmtClock(holdUntil)) + "</strong>. After that it opens up again on the website unless you mark it paid." : ".") + "</p>";
    action = "Confirm and email client";
  } else if (status === "paid") {
    title = "Mark as paid?";
    body = summary +
      '<p class="confirm-note">Check the payment has arrived first: <strong>' + (amount != null ? esc(money(amount)) : "the agreed amount") + "</strong>, with reference <strong>" + esc(b.reference) + "</strong> or from " + esc(b.phone) + ".</p>" +
      '<div class="field"><label for="confirm-ref">MoMo transaction ID or payment reference <span class="optional">(optional)</span></label>' +
      '<input type="text" id="confirm-ref" maxlength="100" autocomplete="off" value="' + esc(b.payment_ref || "") + '" placeholder="From the payment message">' +
      '<span class="hint">Saved on the booking so you can search for it later.</span></div>' +
      '<p class="confirm-note">' + esc(first) + " gets a “payment received” email" + (b.session_date ? " and this slot is blocked on the website." : ".") + "</p>";
    action = "Yes, mark as paid";
  } else {
    title = "Cancel this booking?";
    body = summary +
      '<label class="check"><input type="checkbox" id="confirm-email" checked><span>Email ' + esc(first) + " that it's cancelled</span></label>" +
      (b.session_date ? '<p class="confirm-note">The slot becomes free on the website.</p>' : "");
    action = "Cancel booking";
    danger = true;
  }

  confirmDialog.innerHTML =
    '<form class="confirm-form" novalidate>' +
      '<h2 id="confirm-title">' + esc(title) + "</h2>" + body +
      '<div class="confirm-actions">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-back>Back</button>' +
        '<button type="submit" class="btn btn-sm ' + (danger ? "btn-danger" : "btn-primary") + '"><span class="label">' + esc(action) + "</span></button>" +
      "</div>" +
    "</form>";
  confirmDialog.showModal();

  const form = confirmDialog.querySelector("form");
  confirmDialog.querySelector("[data-back]").addEventListener("click", () => confirmDialog.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const changes = { status };
    if (status === "confirmed") {
      const input = $("confirm-amount");
      const value = Number(input.value);
      if (!(value > 0)) { input.closest(".field").classList.add("has-error"); input.focus(); return; }
      changes.amount_due = value;
    } else if (status === "paid") {
      changes.payment_ref = $("confirm-ref").value.trim() || null;
    } else if (!$("confirm-email").checked) {
      changes.cancelled_email_at = new Date().toISOString(); // tells the database not to email the client
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const ok = await save(b.id, changes, status === "confirmed" ? "Confirmed. Payment details are on their way to " + first
      : status === "paid" ? "Marked paid. " + first + " is being emailed"
      : "Cancelled" + (changes.cancelled_email_at ? "" : ". " + first + " is being emailed"));
    btn.disabled = false;
    if (ok) { confirmDialog.close(); refreshOpen(); }
  });
}
confirmDialog.addEventListener("click", (e) => { if (e.target === confirmDialog) confirmDialog.close(); });

// Links in the alert emails end in #<reference>, for example studio.html#AH-260929-K3PQ.
function openFromLink() {
  const ref = decodeURIComponent(location.hash.slice(1));
  if (!ref || ref.includes("type=recovery")) return;
  const b = bookings.find((x) => x.reference === ref);
  if (b) openBooking(b.id);
}
window.addEventListener("hashchange", () => { if (bookings.length) openFromLink(); });

start();

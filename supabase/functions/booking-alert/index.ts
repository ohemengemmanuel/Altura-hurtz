// Supabase Edge Function "booking-alert": emails the studio about new bookings with the
// client's files attached, emails clients when the studio confirms, marks paid or cancels
// (see supabase/client-emails.sql), and deletes uploaded files from storage 14 days later.
//
// It is woken up when a booking is saved, by the website once uploads finish, and every
// 5 minutes by a timer (see supabase/email-alerts.sql). Each run handles everything that is
// due, so running it twice at once never sends two emails for the same booking.
//
// Deploy: Supabase > Edge Functions > Deploy a new function > Via Editor, name it
// booking-alert, paste this file, Deploy. Then in the function's settings turn OFF
// "Verify JWT" (the website and the database call it without a login).
// Nothing secret is stored here: the Resend key is read from the Vault.

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6";

const BUCKET = "booking-files";
const ATTACH_LIMIT = 25 * 1024 * 1024; // bytes attached per email; Resend allows 40 MB once encoded
const LINK_DAYS = 14;                   // download links last as long as the files are kept
const WAIT_FOR_UPLOADS_MIN = 15;        // after this, send without the files that never arrived

type FileStatus = { path: string; name: string; size: number; present: boolean };
type FileInfo = { name: string; size: number; status: "attached" | "link" | "missing"; url?: string };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// The server key Supabase gives every Edge Function (older and newer project styles).
function serverKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
  const first = Object.values(keys)[0];
  if (typeof first !== "string") throw new Error("No server key available to the function");
  return first;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, serverKey(), { auth: { persistSession: false } });
  const result: Record<string, number | string> = { sent: 0, waiting: 0, failed: 0, purged: 0, client_sent: 0, client_failed: 0 };

  try {
    const { data: cfg, error: cfgErr } = await db.rpc("alert_config");
    if (cfgErr) throw cfgErr;
    if (!cfg?.resend_api_key) throw new Error("resend_api_key is missing from the Vault");

    // 1. Emails that are due
    const { data: pending, error } = await db.rpc("pending_booking_alerts");
    if (error) throw error;
    for (const p of pending ?? []) {
      const files = (p.file_status ?? []) as FileStatus[];
      const ageMin = (Date.now() - new Date(p.created_at).getTime()) / 60000;
      if (files.some((f) => !f.present) && ageMin < WAIT_FOR_UPLOADS_MIN) { result.waiting++; continue; }

      const { data: claimed } = await db.rpc("claim_booking_alert", { p_id: p.id });
      if (!claimed) continue; // another run is already sending this one

      try {
        await sendAlert(db, cfg, p.id, files);
        (result.sent as number)++;
      } catch (e) {
        console.error("Alert failed for", p.reference, e);
        await db.rpc("release_booking_alert", { p_id: p.id });
        (result.failed as number)++;
      }
    }

    // 2. Emails to clients when the studio presses Confirmed, Paid or Cancelled
    await sendClientEmails(db, result);

    // 3. Files emailed more than 14 days ago
    const { data: old } = await db.rpc("purgeable_booking_files");
    for (const o of old ?? []) {
      const { error: rmErr } = await db.storage.from(BUCKET).remove(o.paths);
      if (rmErr) { console.error("Could not delete files for", o.id, rmErr); continue; }
      await db.rpc("mark_files_purged", { p_id: o.id });
      (result.purged as number)++;
    }
  } catch (e) {
    console.error(e);
    return json({ ...result, error: String((e as Error)?.message ?? e) }, 500);
  }
  return json(result);
});

// Client emails go out from the studio Gmail (app password in the Vault as gmail_app_password).
// deno-lint-ignore no-explicit-any
async function sendClientEmails(db: any, result: Record<string, number | string>) {
  const { data: pending, error } = await db.rpc("pending_client_emails");
  if (error) {
    // client-emails.sql hasn't been run yet
    result.client_emails = "not set up: " + error.message;
    return;
  }
  if (!pending?.length) return;

  const { data: mail, error: cfgErr } = await db.rpc("client_email_config");
  if (cfgErr || !mail?.gmail_user || !mail?.gmail_app_password) {
    result.client_emails = "not set up: add gmail_app_password to the Vault";
    return;
  }
  const smtp = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: mail.gmail_user, pass: String(mail.gmail_app_password).replace(/\s/g, "") },
  });

  for (const p of pending) {
    const { data: claimed } = await db.rpc("claim_client_email", { p_id: p.id, p_kind: p.kind });
    if (!claimed) continue; // already sent by another run, or the status changed again
    try {
      const { data: email, error: contentErr } = await db.rpc("client_email_for", { p_id: p.id, p_kind: p.kind });
      if (contentErr) throw contentErr;
      if (!email) throw new Error("Booking not found");
      await smtp.sendMail({
        from: { name: "Altura Hertz Productions", address: mail.gmail_user },
        to: email.to,
        replyTo: mail.gmail_user,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      (result.client_sent as number)++;
    } catch (e) {
      console.error("Client email failed for", p.reference, p.kind, e);
      await db.rpc("release_client_email", { p_id: p.id, p_kind: p.kind });
      (result.client_failed as number)++;
    }
  }
}

// deno-lint-ignore no-explicit-any
async function sendAlert(db: any, cfg: any, id: string, files: FileStatus[]) {
  // Attach what fits, link the rest. Resend downloads attachments from the links itself.
  let budget = ATTACH_LIMIT;
  const info: FileInfo[] = [];
  const attachments: { filename: string; path: string }[] = [];
  for (const f of files) {
    if (!f.present) { info.push({ name: f.name, size: f.size, status: "missing" }); continue; }
    const { data, error } = await db.storage.from(BUCKET)
      .createSignedUrl(f.path, LINK_DAYS * 86400, { download: f.name });
    if (error) throw error;
    if (f.size <= budget) {
      budget -= f.size;
      attachments.push({ filename: f.name, path: data.signedUrl });
      info.push({ name: f.name, size: f.size, status: "attached", url: data.signedUrl });
    } else {
      info.push({ name: f.name, size: f.size, status: "link", url: data.signedUrl });
    }
  }

  let res = await send(db, cfg, id, info, attachments);
  if (!res.ok && attachments.length) {
    // Attaching failed (for example a file Resend couldn't take): send links instead.
    console.error("Sending with attachments failed:", await res.text());
    info.forEach((i) => { if (i.status === "attached") i.status = "link"; });
    res = await send(db, cfg, id, info, []);
  }
  if (!res.ok) throw new Error("Resend " + res.status + ": " + (await res.text()));
}

// deno-lint-ignore no-explicit-any
async function send(db: any, cfg: any, id: string, info: FileInfo[], attachments: { filename: string; path: string }[]) {
  const { data: content, error } = await db.rpc("booking_alert_for", { p_id: id, file_info: info });
  if (error) throw error;
  if (!content) throw new Error("Booking not found");

  const email: Record<string, unknown> = {
    from: cfg.from_email,
    to: [cfg.notify_email],
    subject: content.subject,
    html: content.html,
    text: content.text,
  };
  if (content.reply_to) email.reply_to = content.reply_to;
  if (attachments.length) email.attachments = attachments;

  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + cfg.resend_api_key, "Content-Type": "application/json" },
    body: JSON.stringify(email),
  });
}

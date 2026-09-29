-- Altura Hertz Productions: email the studio about each booking, quote request or message,
-- with the client's uploaded files attached.
-- Run this in the Supabase SQL Editor after schema.sql. It is safe to run again.
--
-- How it works
--   1. A booking is saved. If it has no files, the email goes out straight away.
--   2. If it has files, the email waits until they have uploaded (the website says when),
--      then goes out with the files attached. Files too big to attach come as download links.
--      If an upload never finishes, the email goes out after 15 minutes with whatever arrived.
--   3. 14 days after the email, the files are deleted from Supabase to save space.
--      The studio keeps them in its inbox.
-- The sending is done by the Edge Function in supabase/functions/booking-alert/index.ts.
--
-- Before running this file:
--   1. Sign up at resend.com with the email address that should receive the alerts.
--   2. Resend > API Keys > Create API key (permission: Sending access). Copy it (starts with re_).
--   3. Supabase > Integrations > Vault > Add new secret
--        Name:  resend_api_key
--        Value: the key from step 2
--      The key stays encrypted in Supabase. Never paste it into the website code or into chat.
--   4. Deploy the booking-alert Edge Function (see the README).
--
-- Until the studio has its own domain verified in Resend, emails come from onboarding@resend.dev
-- and can only be delivered to the address you signed up to Resend with.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- Settings. One row only. Not readable from the website (no policies).
-- ---------------------------------------------------------------------------
create table if not exists public.notification_settings (
  id            boolean primary key default true check (id),
  notify_email  text not null,
  dashboard_url text,  -- the studio dashboard page; alert emails link to it
  from_email    text not null default 'Altura Hertz Bookings <onboarding@resend.dev>'
);
alter table public.notification_settings add column if not exists function_url text;
alter table public.notification_settings enable row level security;

insert into public.notification_settings (notify_email, dashboard_url, function_url)
values ('ohemengemmanuel104@gmail.com',
        'https://altura-hertz.netlify.app/studio.html',
        'https://bacqqxokyqhehqadnlcy.supabase.co/functions/v1/booking-alert')
on conflict (id) do update set
  notify_email = excluded.notify_email,
  dashboard_url = excluded.dashboard_url,
  function_url = excluded.function_url;

-- ---------------------------------------------------------------------------
-- Alert tracking on each booking
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'bookings' and column_name = 'alert_sent_at') then
    alter table public.bookings add column alert_sent_at timestamptz;
    -- Bookings made before this existed were already emailed; don't send them again.
    update public.bookings set alert_sent_at = created_at;
  end if;
end $$;
alter table public.bookings add column if not exists alert_attempts  smallint not null default 0;
alter table public.bookings add column if not exists files_purged_at timestamptz;  -- files deleted after emailing

-- Website visitors can't set these themselves.
create or replace function public.reset_alert_fields()
returns trigger language plpgsql as $$
begin
  new.alert_sent_at = null;
  new.alert_attempts = 0;
  new.files_purged_at = null;
  return new;
end;
$$;
drop trigger if exists bookings_alert_defaults on public.bookings;
create trigger bookings_alert_defaults
  before insert on public.bookings
  for each row execute function public.reset_alert_fields();

-- ---------------------------------------------------------------------------
-- Email building blocks. Everything a client typed goes through email_esc so it
-- can't break the layout or add links.
-- ---------------------------------------------------------------------------
create or replace function public.email_esc(t text)
returns text language sql immutable as $$
  select replace(replace(replace(replace(replace(coalesce(t, ''),
    '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');
$$;

-- One label/value line inside a section. Skipped when there is no value.
create or replace function public.email_row(label text, value_html text)
returns text language sql immutable as $$
  select case when coalesce(value_html, '') = '' then '' else
    '<tr><td style="padding:9px 12px 9px 0;border-bottom:1px solid #ecebf3;color:#6b6785;font-size:14px;width:130px;vertical-align:top">'
    || public.email_esc(label) || '</td>'
    || '<td style="padding:9px 0;border-bottom:1px solid #ecebf3;color:#1b1530;font-size:14px;vertical-align:top">'
    || value_html || '</td></tr>' end;
$$;

-- A titled group of rows. Skipped when all its rows are empty.
create or replace function public.email_section(title text, rows_html text)
returns text language sql immutable as $$
  select case when coalesce(rows_html, '') = '' then '' else
    '<p style="margin:26px 0 4px;font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#7a4fd0">'
    || public.email_esc(title) || '</p>'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">'
    || rows_html || '</table>' end;
$$;

-- A small rounded link button.
create or replace function public.email_pill(href text, label text)
returns text language sql immutable as $$
  select '<a href="' || public.email_esc(href) || '" style="display:inline-block;margin:0 6px 6px 0;padding:8px 14px;border:1px solid #d7d2ea;border-radius:999px;color:#3b2a8f;text-decoration:none;font-size:13px;font-weight:bold">'
    || public.email_esc(label) || '</a>';
$$;

create or replace function public.email_size(bytes bigint)
returns text language sql immutable as $$
  select case when coalesce(bytes, 0) >= 1048576 then round(bytes / 1048576.0, 1) || ' MB'
              else greatest(1, round(coalesce(bytes, 0) / 1024.0)) || ' KB' end;
$$;

-- ---------------------------------------------------------------------------
-- The email for one booking: { subject, html, text }.
-- file_info (from the Edge Function) says what happened to each file:
--   [{ "name", "size", "status": "attached" | "link" | "missing", "url" }]
-- Without it, the files the client listed are shown by name only.
--
-- Preview an email without sending anything:
--   select public.booking_alert_content(b, 'https://altura-hertz.netlify.app/studio.html')->>'text'
--   from public.bookings b order by created_at desc limit 1;
-- ---------------------------------------------------------------------------
drop function if exists public.booking_alert_content(public.bookings, text);

create or replace function public.booking_alert_content(b public.bookings, dashboard_url text, file_info jsonb default null)
returns jsonb
language plpgsql stable
set search_path = public
as $$
declare
  what        text;
  when_long   text;
  when_short  text;
  wa          text;
  money       text;
  link        text;
  received    text;
  titles_html text := '';
  titles_txt  text := '';
  extra_html  text := '';
  extra_txt   text := '';
  files_html  text := '';
  files_txt   text := '';
  files       jsonb;
  n_files     int;
  n_attached  int := 0;
  rec         record;
  subject     text;
  html        text;
  txt         text;
begin
  what := case b.kind when 'request' then 'Quote request' when 'message' then 'Message' else 'Booking' end;

  -- Session, for example "Wednesday 30 September 2026, 14:00–17:00 (3 hours)"
  if b.session_date is not null then
    when_long  := to_char(b.session_date, 'FMDay DD FMMonth YYYY');
    when_short := to_char(b.session_date, 'Dy DD Mon');
    if b.session_time is not null then
      when_long  := when_long || ', ' || to_char(b.session_time, 'HH24:MI');
      when_short := when_short || ' ' || to_char(b.session_time, 'HH24:MI');
      if b.hours is not null then
        when_long := when_long || '–' || to_char(b.session_time + make_interval(hours => b.hours), 'HH24:MI');
      end if;
    end if;
    if b.hours is not null then
      when_long := when_long || ' (' || b.hours || case when b.hours = 1 then ' hour)' else ' hours)' end;
    end if;
  end if;

  -- WhatsApp number: Ghana numbers written as 024... become 23324...
  wa := regexp_replace(b.phone, '\D', '', 'g');
  if left(wa, 2) = '00' then wa := substr(wa, 3); end if;
  if left(wa, 1) = '0' then wa := '233' || substr(wa, 2);
  elsif length(wa) = 9 then wa := '233' || wa; end if;

  if b.estimated_total is not null then
    money := 'GH₵' || to_char(b.estimated_total, 'FM999,999,990');
  end if;
  if dashboard_url is not null then link := dashboard_url || '#' || b.reference; end if;
  received := to_char(b.created_at at time zone 'Africa/Accra', 'FMDay DD Mon YYYY, HH24:MI');

  for rec in select t, n from unnest(b.track_titles) with ordinality as x(t, n) loop
    if coalesce(trim(rec.t), '') <> '' then
      titles_html := titles_html || '<br><span style="color:#6b6785">' || rec.n || '. ' || email_esc(rec.t) || '</span>';
      titles_txt  := titles_txt || E'\n              ' || rec.n || '. ' || rec.t;
    end if;
  end loop;

  for rec in select key, value from jsonb_each_text(coalesce(b.details, '{}'::jsonb)) loop
    extra_html := extra_html || email_row(rec.key,
      case when rec.value ~* '^https?://\S+$'
           then '<a href="' || email_esc(rec.value) || '" style="color:#3b2a8f">' || email_esc(rec.value) || '</a>'
           else email_esc(rec.value) end);
    extra_txt := extra_txt || E'\n' || rpad(rec.key || ':', 14) || rec.value;
  end loop;

  -- Files: attached, sent as a link, or never uploaded
  files := coalesce(file_info,
    (select coalesce(jsonb_agg(jsonb_build_object('name', f->>'name', 'size', (f->>'size')::bigint, 'status', 'listed')), '[]'::jsonb)
     from jsonb_array_elements(coalesce(b.files, '[]'::jsonb)) f));
  n_files := jsonb_array_length(files);
  for rec in select f->>'name' as name, (f->>'size')::bigint as size, f->>'status' as status, f->>'url' as url
             from jsonb_array_elements(files) f loop
    if rec.status = 'attached' then n_attached := n_attached + 1; end if;
    files_html := files_html || email_row(
      case rec.status when 'attached' then 'Attached' when 'link' then 'Download' when 'missing' then 'Not uploaded' else email_size(rec.size) end,
      case when rec.status = 'link' and rec.url is not null
           then '<a href="' || email_esc(rec.url) || '" style="color:#3b2a8f;font-weight:bold">' || email_esc(rec.name) || '</a>'
           else email_esc(rec.name) end
      || case when rec.status in ('attached', 'link') then ' <span style="color:#6b6785">&middot; ' || email_size(rec.size) || '</span>' else '' end);
    files_txt := files_txt || E'\n- ' || rec.name
      || case rec.status
           when 'attached' then ' (attached, ' || email_size(rec.size) || ')'
           when 'link'     then ' (too big to attach, ' || email_size(rec.size) || '): ' || coalesce(rec.url, 'see dashboard')
           when 'missing'  then ' (did not upload)'
           else '' end;
  end loop;

  subject := 'New ' || lower(what) || ': ' || b.service || ' · ' || b.artist_name
    || coalesce(' · ' || when_short, '') || ' [' || b.reference || ']';

  -- HTML version
  html :=
    '<div style="display:none;max-height:0;overflow:hidden">'
      || email_esc(b.artist_name || coalesce(' · ' || when_short, '') || coalesce(' · ' || money, '')) || '</div>'
    || '<div style="background:#f4f3f8;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#1b1530">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border-collapse:collapse">'

    -- Header: what came in, which service, when
    || '<tr><td style="background:#16043f;padding:22px 26px;color:#ffffff">'
    ||   '<div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#c9b8f5">New ' || lower(what) || ' &middot; ' || email_esc(b.reference) || '</div>'
    ||   '<div style="font-size:22px;font-weight:bold;margin-top:6px">' || email_esc(b.service) || '</div>'
    ||   '<div style="font-size:15px;color:#ded8f5;margin-top:4px">' || email_esc(b.artist_name)
    ||     coalesce(' &middot; ' || email_esc(when_long), '') || '</div>'
    || '</td></tr>'

    || '<tr><td style="padding:22px 26px 8px">'

    -- Main action
    || case when link is null then '' else
         '<a href="' || email_esc(link) || '" style="display:inline-block;background:#9d3de3;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px;font-size:15px">Open in studio dashboard</a>'
       end

    -- Client
    || email_section('Client',
         email_row('Name', email_esc(b.artist_name))
      || email_row('Phone', '<a href="tel:' || email_esc(regexp_replace(b.phone, '[^\d+]', '', 'g')) || '" style="color:#3b2a8f">' || email_esc(b.phone) || '</a>')
      || email_row('Email', '<a href="mailto:' || email_esc(b.email) || '" style="color:#3b2a8f">' || email_esc(b.email) || '</a>'))
    || '<div style="margin-top:12px">'
    ||   email_pill('tel:' || regexp_replace(b.phone, '[^\d+]', '', 'g'), 'Call')
    ||   email_pill('https://wa.me/' || wa, 'WhatsApp')
    ||   email_pill('mailto:' || b.email || '?subject=' || replace('Your booking ' || b.reference, ' ', '%20'), 'Email')
    || '</div>'

    -- Booking
    || email_section(case when b.kind = 'booking' then 'Booking' else 'Request' end,
         email_row('Session', email_esc(when_long))
      || email_row('Tracks', case when b.tracks is null then '' else b.tracks || titles_html end)
      || email_row('Payment', email_esc(b.payment_method))
      || email_row('Estimated total', case when money is null then '' else '<strong style="font-size:16px">' || email_esc(money) || '</strong>' end))

    -- Extra form answers (genre, BPM, links)
    || email_section('Details', extra_html)

    -- Files
    || case when n_files = 0 then '' else
         email_section('Files (' || n_files || ')', files_html)
         || '<p style="margin:8px 0 0;font-size:13px;color:#6b6785;line-height:1.5">'
         || case when n_attached > 0 then 'Attached files are at the bottom of this email. ' else '' end
         || 'Save them to your project folders: uploaded files are deleted from the website''s storage 14 days after this email.</p>'
       end

    -- Client notes
    || case when coalesce(trim(b.notes), '') = '' then '' else
         '<p style="margin:26px 0 6px;font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#7a4fd0">Client notes</p>'
         || '<div style="background:#f4f3f8;border-left:3px solid #9d3de3;border-radius:6px;padding:12px 14px;font-size:14px;line-height:1.5;white-space:pre-wrap">'
         || email_esc(b.notes) || '</div>'
       end

    || '</td></tr>'

    -- Footer
    || '<tr><td style="padding:18px 26px 24px;font-size:12px;color:#8a86a3;line-height:1.6">'
    ||   'Received ' || email_esc(received) || ' &middot; Reference ' || email_esc(b.reference) || '<br>'
    ||   'Reply to this email to answer ' || email_esc(b.artist_name) || ' directly.'
    || '</td></tr>'
    || '</table></div>';

  -- Plain text version, for mail apps that don't show formatting
  txt :=
       upper('New ' || what) || ' · ' || b.reference || E'\n'
    || b.service || E'\n'
    || coalesce(when_long || E'\n', '')
    || coalesce(E'\nOpen in studio dashboard:\n' || link || E'\n', '')
    || E'\nCLIENT'
    || E'\nName:         ' || b.artist_name
    || E'\nPhone:        ' || b.phone
    || E'\nWhatsApp:     https://wa.me/' || wa
    || E'\nEmail:        ' || b.email
    || E'\n\n' || upper(case when b.kind = 'booking' then 'Booking' else 'Request' end)
    || coalesce(E'\nSession:      ' || when_long, '')
    || coalesce(E'\nTracks:       ' || b.tracks || titles_txt, '')
    || coalesce(E'\nPayment:      ' || b.payment_method, '')
    || coalesce(E'\nEstimated:    ' || money, '')
    || case when extra_txt = '' then '' else E'\n\nDETAILS' || extra_txt end
    || case when n_files = 0 then '' else
         E'\n\nFILES (' || n_files || ')' || files_txt
         || E'\nSave them to your project folders: uploaded files are deleted from the website''s storage 14 days after this email.' end
    || case when coalesce(trim(b.notes), '') = '' then '' else E'\n\nCLIENT NOTES\n' || b.notes end
    || E'\n\n--\nReceived ' || received
    || E'\nReply to this email to answer ' || b.artist_name || ' directly.';

  return jsonb_build_object('subject', left(subject, 250), 'html', html, 'text', txt);
end;
$$;

-- ---------------------------------------------------------------------------
-- Helpers for the Edge Function. Only the function (service_role) may call them.
-- ---------------------------------------------------------------------------

-- Where to send, and the Resend key from the Vault.
create or replace function public.alert_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'notify_email', s.notify_email,
    'from_email', s.from_email,
    'resend_api_key', (select decrypted_secret from vault.decrypted_secrets where name = 'resend_api_key' limit 1))
  from public.notification_settings s limit 1;
$$;

-- Bookings still waiting for their email, with each file's upload state and real size.
create or replace function public.pending_booking_alerts()
returns table (id uuid, reference text, created_at timestamptz, file_status jsonb)
language sql stable security definer set search_path = public as $$
  select b.id, b.reference, b.created_at,
    (select coalesce(jsonb_agg(jsonb_build_object(
              'path', f->>'path',
              'name', f->>'name',
              'size', coalesce((o.metadata->>'size')::bigint, (f->>'size')::bigint, 0),
              'present', o.id is not null)), '[]'::jsonb)
     from jsonb_array_elements(b.files) f
     left join storage.objects o on o.bucket_id = 'booking-files' and o.name = f->>'path')
  from public.bookings b
  where b.alert_sent_at is null
    and b.alert_attempts < 3
    and b.created_at > now() - interval '2 days'
  order by b.created_at;
$$;

-- Marks a booking as being emailed. Returns false if another run got there first.
create or replace function public.claim_booking_alert(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.bookings
     set alert_sent_at = now(), alert_attempts = alert_attempts + 1
   where id = p_id and alert_sent_at is null and alert_attempts < 3;
  return found;
end;
$$;

-- Sending failed: let the next run try again (up to 3 attempts in total).
create or replace function public.release_booking_alert(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.bookings set alert_sent_at = null where id = p_id;
$$;

-- The email for one booking, plus who to reply to.
create or replace function public.booking_alert_for(p_id uuid, file_info jsonb default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  b public.bookings;
  s public.notification_settings;
  c jsonb;
begin
  select * into b from public.bookings where id = p_id;
  if not found then return null; end if;
  select * into s from public.notification_settings limit 1;
  c := public.booking_alert_content(b, s.dashboard_url, file_info);
  if b.email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    c := c || jsonb_build_object('reply_to', b.email);
  end if;
  return c;
end;
$$;

-- Files emailed more than 14 days ago that are still in storage.
create or replace function public.purgeable_booking_files()
returns table (id uuid, paths text[])
language sql stable security definer set search_path = public as $$
  select b.id, array(select f->>'path' from jsonb_array_elements(b.files) f)
  from public.bookings b
  where b.files_purged_at is null
    and b.alert_sent_at < now() - interval '14 days'
    and jsonb_array_length(b.files) > 0
  limit 50;
$$;

create or replace function public.mark_files_purged(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.bookings set files_purged_at = now() where id = p_id;
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.email_esc(text)', 'public.email_row(text, text)', 'public.email_section(text, text)',
    'public.email_pill(text, text)', 'public.email_size(bigint)',
    'public.booking_alert_content(public.bookings, text, jsonb)',
    'public.alert_config()', 'public.pending_booking_alerts()', 'public.claim_booking_alert(uuid)',
    'public.release_booking_alert(uuid)', 'public.booking_alert_for(uuid, jsonb)',
    'public.purgeable_booking_files()', 'public.mark_files_purged(uuid)'] loop
    execute 'revoke all on function ' || fn || ' from public, anon, authenticated';
    execute 'grant execute on function ' || fn || ' to service_role';
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Wake the Edge Function: when a booking is saved, and every 5 minutes as a backup
-- (emails whose uploads never finished, retries, and deleting old files).
-- ---------------------------------------------------------------------------
create or replace function public.notify_new_booking()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  target text;
begin
  select function_url into target from public.notification_settings limit 1;
  if target is not null then
    -- pg_net sends in the background, so this never holds up the booking.
    perform net.http_post(url := target, body := '{}'::jsonb, timeout_milliseconds := 60000);
  end if;
  return new;
exception when others then
  raise warning 'Booking email alert failed: %', sqlerrm;
  return new;
end;
$$;

revoke all on function public.notify_new_booking() from public, anon, authenticated;

drop trigger if exists bookings_notify_new on public.bookings;
create trigger bookings_notify_new
  after insert on public.bookings
  for each row execute function public.notify_new_booking();

select cron.unschedule(jobid) from cron.job where jobname = 'booking-alerts';
select cron.schedule(
  'booking-alerts',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := (select function_url from public.notification_settings limit 1),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000)
  $cron$
);

-- Checking it works
--   Recent calls to the Edge Function and their answers:
--     select status_code, content, created from net._http_response order by created desc limit 5;
--   The function answers with counts, for example {"sent":1,"waiting":0,"failed":0,"purged":0}.
--   Bookings still waiting for their email:
--     select reference, alert_attempts from public.bookings where alert_sent_at is null;

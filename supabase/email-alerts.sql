-- Altura Hertz Productions: email the studio when a booking, quote request or message arrives.
-- Run this in the Supabase SQL Editor after schema.sql. It is safe to run again.
--
-- Emails are sent through Resend (https://resend.com). Before running this file:
--   1. Sign up at resend.com with the email address that should receive the alerts.
--   2. Resend > API Keys > Create API key (permission: Sending access). Copy it (starts with re_).
--   3. Supabase > Integrations > Vault > Add new secret
--        Name:  resend_api_key
--        Value: the key from step 2
--      The key stays encrypted in Supabase. Never paste it into the website code or into chat.
--
-- Until the studio has its own domain verified in Resend, emails come from onboarding@resend.dev
-- and can only be delivered to the address you signed up to Resend with.

create extension if not exists pg_net;

-- Who gets the alerts. One row only. Not readable from the website (no policies).
create table if not exists public.notification_settings (
  id            boolean primary key default true check (id),
  notify_email  text not null,
  dashboard_url text,  -- the studio dashboard page; alert emails link to it
  from_email    text not null default 'Altura Hertz Bookings <onboarding@resend.dev>'
);
alter table public.notification_settings enable row level security;

insert into public.notification_settings (notify_email, dashboard_url)
values ('ohemengemmanuel104@gmail.com', 'https://altura-hertz.netlify.app/studio.html')
on conflict (id) do update set notify_email = excluded.notify_email, dashboard_url = excluded.dashboard_url;

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

-- ---------------------------------------------------------------------------
-- The email for one booking: { subject, html, text }.
-- Try it without sending anything:
--   select public.booking_alert_content(b, 'https://altura-hertz.netlify.app/studio.html')->>'text'
--   from public.bookings b order by created_at desc limit 1;
-- ---------------------------------------------------------------------------
create or replace function public.booking_alert_content(b public.bookings, dashboard_url text)
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
  n_files     int  := coalesce(jsonb_array_length(b.files), 0);
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

  for rec in select f->>'name' as name, coalesce((f->>'size')::bigint, 0) as size
             from jsonb_array_elements(coalesce(b.files, '[]'::jsonb)) f loop
    files_html := files_html || email_row(
      case when rec.size >= 1048576 then round(rec.size / 1048576.0, 1) || ' MB'
           else greatest(1, round(rec.size / 1024.0)) || ' KB' end,
      email_esc(rec.name));
    files_txt := files_txt || E'\n- ' || rec.name;
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
         || '<p style="margin:8px 0 0;font-size:13px;color:#6b6785">Download them from the studio dashboard.</p>'
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
    || case when n_files = 0 then '' else E'\n\nFILES (' || n_files || ')' || files_txt || E'\nDownload them from the studio dashboard.' end
    || case when coalesce(trim(b.notes), '') = '' then '' else E'\n\nCLIENT NOTES\n' || b.notes end
    || E'\n\n--\nReceived ' || received
    || E'\nReply to this email to answer ' || b.artist_name || ' directly.';

  return jsonb_build_object('subject', left(subject, 250), 'html', html, 'text', txt);
end;
$$;

revoke all on function public.booking_alert_content(public.bookings, text) from public, anon, authenticated;
revoke all on function public.email_esc(text) from public, anon, authenticated;
revoke all on function public.email_row(text, text) from public, anon, authenticated;
revoke all on function public.email_section(text, text) from public, anon, authenticated;
revoke all on function public.email_pill(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Send the email when a booking is saved
-- ---------------------------------------------------------------------------
create or replace function public.notify_new_booking()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  s        public.notification_settings%rowtype;
  api_key  text;
  content  jsonb;
  payload  jsonb;
begin
  select * into s from public.notification_settings limit 1;
  if not found then return new; end if;

  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
  if api_key is null then return new; end if;

  content := public.booking_alert_content(new, s.dashboard_url);
  payload := jsonb_build_object(
    'from', s.from_email,
    'to', jsonb_build_array(s.notify_email),
    'subject', content->>'subject',
    'html', content->>'html',
    'text', content->>'text'
  );
  if new.email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    payload := payload || jsonb_build_object('reply_to', new.email);
  end if;

  -- pg_net sends in the background, so a slow or failed email never holds up the booking.
  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || api_key, 'Content-Type', 'application/json'),
    body := payload
  );
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

-- Checking it works: after a test booking, run
--   select status_code, content, created from net._http_response order by created desc limit 5;
-- 200 means Resend accepted the email. Anything else shows Resend's error message.

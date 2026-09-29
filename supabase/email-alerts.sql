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
  dashboard_url text,  -- for example https://alturahertz.netlify.app/studio.html, added once the site is live
  from_email    text not null default 'Altura Hertz Bookings <onboarding@resend.dev>'
);
alter table public.notification_settings enable row level security;

insert into public.notification_settings (notify_email)
values ('ohemengemmanuel104@gmail.com')
on conflict (id) do update set notify_email = excluded.notify_email;

create or replace function public.notify_new_booking()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  s        public.notification_settings%rowtype;
  api_key  text;
  what     text;
  subject  text;
  body     text;
  payload  jsonb;
begin
  select * into s from public.notification_settings limit 1;
  if not found then return new; end if;

  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
  if api_key is null then return new; end if;

  what := case new.kind when 'request' then 'quote request' when 'message' then 'message' else 'booking' end;
  subject := 'New ' || what || ': ' || new.service || ', ' || new.artist_name
    || coalesce(', ' || to_char(new.session_date, 'Dy DD Mon') || coalesce(' ' || to_char(new.session_time, 'HH24:MI'), ''), '');

  body := coalesce(new.summary, 'Reference: ' || new.reference)
    || E'\n\n'
    || case when jsonb_array_length(new.files) > 0
            then jsonb_array_length(new.files) || ' file(s) attached. Download them from the studio dashboard.' || E'\n'
            else '' end
    || coalesce('Open the studio dashboard: ' || s.dashboard_url || E'\n', '')
    || E'\nReply to this email to answer the client directly.';

  payload := jsonb_build_object(
    'from', s.from_email,
    'to', jsonb_build_array(s.notify_email),
    'subject', left(subject, 200),
    'text', body
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

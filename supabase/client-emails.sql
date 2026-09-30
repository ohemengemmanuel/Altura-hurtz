-- Altura Hertz Productions: automatic emails to clients, and slot holds.
-- Run this in the Supabase SQL Editor after schema.sql and email-alerts.sql. Safe to run again.
--
-- What it does
--   Studio presses Confirmed  -> the client is emailed the session, amount due and payment
--                                details, and the slot is held for 3 hours.
--   Studio presses Paid       -> the client is emailed "payment received"; the slot is blocked for good.
--   Studio presses Cancelled  -> the client is emailed that the booking is cancelled (optional).
--   The booking form greys out times that are paid, or confirmed and still inside their hold.
--
-- Emails go out from the studio Gmail through the booking-alert Edge Function.
-- Before running this file:
--   1. Google account > Security > turn on 2-Step Verification.
--   2. https://myaccount.google.com/apppasswords > create an app password (name it "Supabase").
--   3. Supabase > Integrations > Vault > Add new secret
--        Name:  gmail_app_password
--        Value: the 16-letter app password
--
-- Payment details shown to clients: fill them in once, for example
--   update public.notification_settings set payment_instructions =
--   'MTN MoMo: 024 000 0000 (Name on account)
--   Telecel Cash: 050 000 0000 (Name on account)';
-- Until then the email says the payment details will follow on WhatsApp.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
alter table public.notification_settings add column if not exists gmail_user text;
alter table public.notification_settings add column if not exists payment_instructions text;
alter table public.notification_settings add column if not exists studio_phone text;
alter table public.notification_settings add column if not exists hold_hours numeric not null default 3;
alter table public.notification_settings add column if not exists site_url text;

update public.notification_settings set
  gmail_user   = coalesce(gmail_user, 'ohemengemmanuel104@gmail.com'),
  studio_phone = coalesce(studio_phone, '+233 50 174 4564'),
  site_url     = coalesce(site_url, 'https://altura-hertz.netlify.app');

-- ---------------------------------------------------------------------------
-- New booking columns
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'bookings' and column_name = 'confirmed_email_at') then
    alter table public.bookings
      add column confirmed_email_at timestamptz,
      add column paid_email_at      timestamptz,
      add column cancelled_email_at timestamptz;
    -- Bookings from before this existed never get these emails.
    update public.bookings set confirmed_email_at = now(), paid_email_at = now(), cancelled_email_at = now();
  end if;
end $$;
alter table public.bookings add column if not exists amount_due            numeric(10, 2);  -- what the client is asked to pay
alter table public.bookings add column if not exists hold_expires_at       timestamptz;     -- confirmed slot is reserved until this time
alter table public.bookings add column if not exists payment_ref           text check (char_length(payment_ref) <= 100); -- MoMo transaction ID
alter table public.bookings add column if not exists client_email_attempts smallint not null default 0;

-- Website visitors can't set these themselves.
create or replace function public.reset_client_fields()
returns trigger language plpgsql as $$
begin
  new.amount_due = null;
  new.hold_expires_at = null;
  new.payment_ref = null;
  new.confirmed_email_at = null;
  new.paid_email_at = null;
  new.cancelled_email_at = null;
  new.client_email_attempts = 0;
  return new;
end;
$$;
drop trigger if exists bookings_client_defaults on public.bookings;
create trigger bookings_client_defaults
  before insert on public.bookings
  for each row execute function public.reset_client_fields();

-- ---------------------------------------------------------------------------
-- Status changes: start or end the hold, and line up the right client email.
-- ---------------------------------------------------------------------------
create or replace function public.on_booking_status_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  hrs numeric;
begin
  if new.status is distinct from old.status then
    new.client_email_attempts = 0;
    if new.status = 'confirmed' then
      select hold_hours into hrs from public.notification_settings limit 1;
      new.hold_expires_at = now() + (coalesce(hrs, 3) || ' hours')::interval;
      new.amount_due = coalesce(new.amount_due, new.estimated_total);
      new.confirmed_email_at = null;
    elsif new.status = 'paid' then
      new.hold_expires_at = null;
      new.paid_email_at = null;
    elsif new.status = 'cancelled' then
      new.hold_expires_at = null;
      -- The dashboard sets cancelled_email_at itself when the studio chooses not to email the client.
      if new.cancelled_email_at is not distinct from old.cancelled_email_at then
        new.cancelled_email_at = null;
      end if;
    else
      new.hold_expires_at = null;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists bookings_status_change on public.bookings;
create trigger bookings_status_change
  before update of status on public.bookings
  for each row execute function public.on_booking_status_change();

-- Wake the Edge Function so the email goes out straight away (the 5-minute timer is the backup).
create or replace function public.wake_on_status_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target text;
begin
  if new.status is distinct from old.status then
    select function_url into target from public.notification_settings limit 1;
    if target is not null then
      perform net.http_post(url := target, body := '{}'::jsonb, timeout_milliseconds := 60000);
    end if;
  end if;
  return new;
exception when others then
  raise warning 'Could not wake booking-alert: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists bookings_wake_on_status on public.bookings;
create trigger bookings_wake_on_status
  after update of status on public.bookings
  for each row execute function public.wake_on_status_change();

-- ---------------------------------------------------------------------------
-- Taken slots. Public: only dates and times, no names or contact details.
-- ---------------------------------------------------------------------------
create or replace function public.taken_slots(from_date date, to_date date)
returns table (session_date date, session_time time, hours smallint)
language sql stable security definer set search_path = public as $$
  select b.session_date, b.session_time, b.hours
  from public.bookings b
  where b.session_date between from_date and least(to_date, from_date + 62)
    and b.session_time is not null
    and (b.status in ('paid', 'completed')
         or (b.status = 'confirmed' and b.hold_expires_at > now()));
$$;
revoke all on function public.taken_slots(date, date) from public;
grant execute on function public.taken_slots(date, date) to anon, authenticated, service_role;

-- Refuse a new booking for a time that is already taken (two clients booking at once).
create or replace function public.check_booking_slot()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.session_date is not null and new.session_time is not null and exists (
    select 1 from public.taken_slots(new.session_date, new.session_date) t
    where t.session_time < new.session_time + make_interval(hours => coalesce(new.hours, 1))
      and new.session_time < t.session_time + make_interval(hours => coalesce(t.hours, 1))) then
    raise exception 'SLOT_TAKEN: That time was just booked. Please pick another time.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists bookings_check_slot on public.bookings;
create trigger bookings_check_slot
  before insert on public.bookings
  for each row execute function public.check_booking_slot();

-- ---------------------------------------------------------------------------
-- Client email content: { to, subject, html, text }
-- kind is 'confirmed', 'paid' or 'cancelled'.
-- Preview one without sending anything:
--   select public.client_email_for(id, 'confirmed')->>'text' from public.bookings order by created_at desc limit 1;
-- ---------------------------------------------------------------------------
create or replace function public.client_email_for(p_id uuid, p_kind text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  b        public.bookings;
  s        public.notification_settings;
  first_name text;
  when_txt text;
  amount   text;
  hold_txt text;
  wa       text;
  tel      text;
  title    text;
  intro    text;
  subject  text;
  body     text := '';
  txt      text := '';
  html     text;
  contact_html text;
  contact_txt  text;
begin
  select * into b from public.bookings where id = p_id;
  if not found then return null; end if;
  select * into s from public.notification_settings limit 1;

  first_name := split_part(trim(b.artist_name), ' ', 1);

  if b.session_date is not null then
    when_txt := to_char(b.session_date, 'FMDay DD FMMonth YYYY');
    if b.session_time is not null then
      when_txt := when_txt || ', ' || to_char(b.session_time, 'HH24:MI');
      if b.hours is not null then
        when_txt := when_txt || '–' || to_char(b.session_time + make_interval(hours => b.hours), 'HH24:MI')
          || ' (' || b.hours || case when b.hours = 1 then ' hour)' else ' hours)' end;
      end if;
    end if;
  end if;

  amount := case when coalesce(b.amount_due, b.estimated_total) is not null
                 then 'GH₵' || to_char(coalesce(b.amount_due, b.estimated_total), 'FM999,999,990') end;
  hold_txt := to_char(b.hold_expires_at at time zone 'Africa/Accra', 'HH24:MI "on" FMDay DD Mon');

  tel := regexp_replace(coalesce(s.studio_phone, ''), '[^\d+]', '', 'g');
  wa  := regexp_replace(coalesce(s.studio_phone, ''), '\D', '', 'g');
  if left(wa, 1) = '0' then wa := '233' || substr(wa, 2); end if;

  contact_html := '<div style="margin-top:14px">'
    || case when tel <> '' then email_pill('tel:' || tel, 'Call ' || s.studio_phone) || email_pill('https://wa.me/' || wa, 'WhatsApp us') else '' end
    || '</div>';
  contact_txt := coalesce(E'\nCall or WhatsApp: ' || s.studio_phone, '') || E'\nOr just reply to this email.';

  -- Session rows shared by all three emails
  body := email_section(case when b.kind = 'booking' then 'Your session' else 'Your request' end,
            email_row('Service', email_esc(b.service))
         || email_row('Date and time', email_esc(when_txt))
         || email_row('Tracks', case when b.tracks is null then '' else b.tracks::text end)
         || email_row('Reference', '<strong>' || email_esc(b.reference) || '</strong>'));
  txt := E'\n' || b.service || coalesce(E'\n' || when_txt, '') || E'\nReference: ' || b.reference;

  if p_kind = 'confirmed' then
    title   := 'Your session is confirmed';
    intro   := 'Hi ' || first_name || ', good news: we have your slot. Please pay to secure it.';
    subject := 'Confirmed: please pay to secure your ' || lower(b.service)
               || coalesce(' on ' || to_char(b.session_date, 'Dy DD Mon') || coalesce(', ' || to_char(b.session_time, 'HH24:MI'), ''), '')
               || ' [' || b.reference || ']';

    body := body || email_section('Payment',
         email_row('Amount due', case when amount is null then '' else '<strong style="font-size:18px">' || email_esc(amount) || '</strong>' end)
      || email_row('Pay to', case when s.payment_instructions is null
                                  then 'We will send our payment details to you on WhatsApp shortly.'
                                  else '<div style="white-space:pre-wrap">' || email_esc(s.payment_instructions) || '</div>' end)
      || email_row('Payment reference', '<strong>' || email_esc(b.reference) || '</strong><br><span style="color:#6b6785">Please use this as the reference or description when you pay, so we can match your payment.</span>'));

    if b.hold_expires_at is not null and b.session_date is not null then
      body := body || '<div style="margin-top:18px;background:#fff6e0;border-left:3px solid #e0a400;border-radius:6px;padding:12px 14px;font-size:14px;line-height:1.5">'
        || '<strong>We are holding this slot for you until ' || email_esc(hold_txt) || '.</strong><br>'
        || 'If your payment has not reached us by then, the slot may be given to someone else.</div>';
    end if;
    body := body || '<p style="margin:18px 0 0;font-size:14px;line-height:1.5">Payments are non-refundable. Once your payment arrives we will email you to confirm you are booked.</p>';

    txt := txt
      || E'\n\nPAYMENT'
      || coalesce(E'\nAmount due: ' || amount, '')
      || E'\nPay to: ' || coalesce(E'\n' || s.payment_instructions, 'We will send our payment details to you on WhatsApp shortly.')
      || E'\nPayment reference: ' || b.reference || ' (use this when you pay so we can match your payment)'
      || case when b.hold_expires_at is not null and b.session_date is not null
              then E'\n\nWe are holding this slot for you until ' || hold_txt || E'.\nIf your payment has not reached us by then, the slot may be given to someone else.'
              else '' end
      || E'\n\nPayments are non-refundable. Once your payment arrives we will email you to confirm you are booked.';

  elsif p_kind = 'paid' then
    title   := 'Payment received, you''re booked';
    intro   := 'Hi ' || first_name || ', thank you. We have received your payment'
               || case when b.session_date is not null then ' and your session is booked.' else '.' end;
    subject := 'Payment received: you''re booked'
               || coalesce(' for ' || to_char(b.session_date, 'Dy DD Mon') || coalesce(', ' || to_char(b.session_time, 'HH24:MI'), ''), '')
               || ' [' || b.reference || ']';

    body := body || email_section('Payment',
         email_row('Amount paid', case when amount is null then '' else '<strong>' || email_esc(amount) || '</strong>' end)
      || email_row('Payment reference', email_esc(b.payment_ref)));
    if b.session_date is not null then
      body := body || email_section('Before your session',
           email_row('Arrive', '10 to 20 minutes before your session starts.')
        || email_row('Guests', 'No more than 2 people who are not part of the recording.'));
    end if;

    txt := txt
      || coalesce(E'\n\nAmount paid: ' || amount, '')
      || coalesce(E'\nPayment reference: ' || b.payment_ref, '')
      || case when b.session_date is not null
              then E'\n\nBEFORE YOUR SESSION\n- Arrive 10 to 20 minutes before your session starts.\n- No more than 2 people who are not part of the recording.'
              else '' end;

  elsif p_kind = 'cancelled' then
    title   := 'Your booking has been cancelled';
    intro   := 'Hi ' || first_name || ', your ' || case when b.kind = 'booking' then 'booking' else 'request' end
               || ' below has been cancelled. If you think this is a mistake, or you would like to book another time, get in touch.';
    subject := 'Your booking ' || b.reference || ' has been cancelled';
    if s.site_url is not null then
      body := body || '<p style="margin:18px 0 0"><a href="' || email_esc(s.site_url) || '" style="color:#3b2a8f;font-weight:bold">Book another time</a></p>';
      txt := txt || E'\n\nBook another time: ' || s.site_url;
    end if;
  else
    return null;
  end if;

  html :=
    '<div style="display:none;max-height:0;overflow:hidden">' || email_esc(intro) || '</div>'
    || '<div style="background:#f4f3f8;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#1b1530">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border-collapse:collapse">'
    || '<tr><td style="background:#16043f;padding:22px 26px;color:#ffffff">'
    ||   '<div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#c9b8f5">Altura Hertz Productions</div>'
    ||   '<div style="font-size:22px;font-weight:bold;margin-top:6px">' || email_esc(title) || '</div>'
    || '</td></tr>'
    || '<tr><td style="padding:22px 26px 8px">'
    ||   '<p style="margin:0;font-size:15px;line-height:1.5">' || email_esc(intro) || '</p>'
    ||   body
    ||   '<p style="margin:26px 0 4px;font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#7a4fd0">Questions?</p>'
    ||   '<p style="margin:0;font-size:14px;line-height:1.5">Reply to this email, or call or WhatsApp us.</p>'
    ||   contact_html
    || '</td></tr>'
    || '<tr><td style="padding:18px 26px 24px;font-size:12px;color:#8a86a3;line-height:1.6">Altura Hertz Productions &middot; Reference ' || email_esc(b.reference) || '</td></tr>'
    || '</table></div>';

  txt := upper(title) || E'\n\n' || intro || E'\n' || txt || E'\n\nQUESTIONS?' || contact_txt || E'\n\nAltura Hertz Productions';

  return jsonb_build_object('to', b.email, 'subject', left(subject, 250), 'html', html, 'text', txt);
end;
$$;

-- ---------------------------------------------------------------------------
-- Helpers for the Edge Function (service_role only)
-- ---------------------------------------------------------------------------
create or replace function public.client_email_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'gmail_user', s.gmail_user,
    'gmail_app_password', (select decrypted_secret from vault.decrypted_secrets where name = 'gmail_app_password' limit 1))
  from public.notification_settings s limit 1;
$$;

-- Bookings whose status email hasn't gone out yet.
create or replace function public.pending_client_emails()
returns table (id uuid, reference text, kind text)
language sql stable security definer set search_path = public as $$
  select b.id, b.reference, v.kind
  from public.bookings b
  cross join lateral (select case
      when b.status = 'confirmed' and b.confirmed_email_at is null then 'confirmed'
      when b.status = 'paid'      and b.paid_email_at      is null then 'paid'
      when b.status = 'cancelled' and b.cancelled_email_at is null then 'cancelled'
    end as kind) v
  where v.kind is not null
    and b.client_email_attempts < 3
    and b.updated_at > now() - interval '2 days'
    and b.email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
  order by b.updated_at;
$$;

-- Marks the email as being sent. Returns false if another run got there first or the status changed.
create or replace function public.claim_client_email(p_id uuid, p_kind text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.bookings set
    confirmed_email_at = case when p_kind = 'confirmed' then now() else confirmed_email_at end,
    paid_email_at      = case when p_kind = 'paid'      then now() else paid_email_at end,
    cancelled_email_at = case when p_kind = 'cancelled' then now() else cancelled_email_at end,
    client_email_attempts = client_email_attempts + 1
  where id = p_id and status = p_kind and client_email_attempts < 3
    and ((p_kind = 'confirmed' and confirmed_email_at is null)
      or (p_kind = 'paid'      and paid_email_at      is null)
      or (p_kind = 'cancelled' and cancelled_email_at is null));
  return found;
end;
$$;

-- Sending failed: let the next run try again (up to 3 attempts).
create or replace function public.release_client_email(p_id uuid, p_kind text)
returns void language sql security definer set search_path = public as $$
  update public.bookings set
    confirmed_email_at = case when p_kind = 'confirmed' then null else confirmed_email_at end,
    paid_email_at      = case when p_kind = 'paid'      then null else paid_email_at end,
    cancelled_email_at = case when p_kind = 'cancelled' then null else cancelled_email_at end
  where id = p_id;
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.client_email_for(uuid, text)', 'public.client_email_config()', 'public.pending_client_emails()',
    'public.claim_client_email(uuid, text)', 'public.release_client_email(uuid, text)'] loop
    execute 'revoke all on function ' || fn || ' from public, anon, authenticated';
    execute 'grant execute on function ' || fn || ' to service_role';
  end loop;
end $$;

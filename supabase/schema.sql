-- Altura Hertz Productions: bookings backend on Supabase.
-- Run this once in the Supabase dashboard: SQL Editor > New query > paste > Run.
-- It is safe to run again; existing tables, data and policies are kept.
--
-- Who can do what:
--   Website visitors (anon)  can submit bookings and upload files. They can never read them back.
--   Studio staff             can read, update and delete bookings and download files.
--   A signed-in user is staff only if their user id is in public.staff (see the end of this file).

-- ---------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------
create table if not exists public.staff (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  name       text,
  created_at timestamptz not null default now()
);
alter table public.staff enable row level security;

drop policy if exists "Staff can see their own row" on public.staff;
create policy "Staff can see their own row" on public.staff
  for select to authenticated using (user_id = auth.uid());

grant select on public.staff to authenticated;

-- security definer so the check works inside other tables' policies without exposing the staff list.
create or replace function public.is_staff()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.staff where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Bookings (also holds quote requests and contact messages; see "kind")
-- ---------------------------------------------------------------------------
create table if not exists public.bookings (
  id              uuid primary key default gen_random_uuid(),
  reference       text not null unique check (char_length(reference) <= 40),
  service         text not null check (char_length(service) <= 80),
  kind            text not null default 'booking' check (kind in ('booking', 'request', 'message')),
  status          text not null default 'new'
                  check (status in ('new', 'confirmed', 'paid', 'completed', 'cancelled')),

  artist_name     text not null check (char_length(artist_name) <= 200),
  email           text not null check (char_length(email) <= 320),
  phone           text not null check (char_length(phone) <= 40),

  session_date    date,
  session_time    time,
  hours           smallint check (hours between 1 and 24),
  tracks          smallint check (tracks between 1 and 100),
  track_titles    text[] not null default '{}',

  payment_method  text check (char_length(payment_method) <= 80),
  estimated_total numeric(10, 2),
  notes           text check (char_length(notes) <= 5000),
  details         jsonb not null default '{}'::jsonb,  -- extra form answers: genre, BPM, links
  files           jsonb not null default '[]'::jsonb,  -- [{ field, name, path, size }] in the booking-files bucket
  summary         text check (char_length(summary) <= 20000),

  studio_notes    text,
  paid_at         timestamptz,                         -- set automatically when the status becomes paid or completed
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists bookings_created_at_idx   on public.bookings (created_at desc);
create index if not exists bookings_session_date_idx on public.bookings (session_date);
create index if not exists bookings_status_idx       on public.bookings (status);

-- Older installs: add columns introduced after the first version of this file.
alter table public.bookings add column if not exists paid_at timestamptz;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  if new.status in ('paid', 'completed') and new.paid_at is null then
    new.paid_at = now();
  elsif new.status not in ('paid', 'completed') then
    new.paid_at = null;
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_touch_updated_at on public.bookings;
create trigger bookings_touch_updated_at
  before update on public.bookings
  for each row execute function public.touch_updated_at();

alter table public.bookings enable row level security;

-- Visitors can only create brand new bookings. They cannot set a status or studio notes.
drop policy if exists "Anyone can submit a booking" on public.bookings;
create policy "Anyone can submit a booking" on public.bookings
  for insert to anon, authenticated
  with check (status = 'new' and studio_notes is null and paid_at is null);

drop policy if exists "Staff can read bookings" on public.bookings;
create policy "Staff can read bookings" on public.bookings
  for select to authenticated using (public.is_staff());

drop policy if exists "Staff can update bookings" on public.bookings;
create policy "Staff can update bookings" on public.bookings
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists "Staff can delete bookings" on public.bookings;
create policy "Staff can delete bookings" on public.bookings
  for delete to authenticated using (public.is_staff());

-- Spam protection for new bookings:
--   at most 3 per email or phone number in 10 minutes, 60 in total per hour, 10 files each.
--   created_at is always set by the database, so it can't be faked to get around the limits.
create or replace function public.check_new_booking()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  new.created_at = now();
  new.updated_at = now();

  if jsonb_typeof(new.files) <> 'array' or jsonb_array_length(new.files) > 10 then
    raise exception 'Too many files. Please share the rest as a link.' using errcode = 'P0001';
  end if;

  if (select count(*) from public.bookings
      where created_at > now() - interval '10 minutes'
        and (lower(email) = lower(new.email)
             or regexp_replace(phone, '\D', '', 'g') = regexp_replace(new.phone, '\D', '', 'g'))) >= 3 then
    raise exception 'Too many requests from this contact. Please wait a few minutes or message us on WhatsApp.' using errcode = 'P0001';
  end if;

  if (select count(*) from public.bookings where created_at > now() - interval '1 hour') >= 60 then
    raise exception 'The booking form is busy. Please message us on WhatsApp.' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_check_new on public.bookings;
create trigger bookings_check_new
  before insert on public.bookings
  for each row execute function public.check_new_booking();

grant insert on public.bookings to anon, authenticated;
grant select, update, delete on public.bookings to authenticated;

-- Live updates on the studio dashboard. Row level security still applies, so only staff receive them.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bookings'
  ) then
    alter publication supabase_realtime add table public.bookings;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Uploaded files (instrumentals, stems). Private bucket, 50 MB per file.
-- The Supabase free plan caps uploads at 50 MB. On a paid plan, raise both this
-- limit and maxUploadMB in development/js/config.js.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('booking-files', 'booking-files', false, 52428800)
on conflict (id) do nothing;

-- A file can only be uploaded if a booking made in the last hour lists it (the website saves the
-- booking first, then uploads). This stops the bucket being used as free storage by strangers.
create or replace function public.can_upload_booking_file(object_name text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bookings b
    where b.reference = split_part(object_name, '/', 1)
      and b.created_at > now() - interval '1 hour'
      and b.files @> jsonb_build_array(jsonb_build_object('path', object_name))
  );
$$;

drop policy if exists "Anyone can upload booking files" on storage.objects;
create policy "Anyone can upload booking files" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'booking-files' and public.can_upload_booking_file(name));

drop policy if exists "Staff can read booking files" on storage.objects;
create policy "Staff can read booking files" on storage.objects
  for select to authenticated
  using (bucket_id = 'booking-files' and public.is_staff());

drop policy if exists "Staff can delete booking files" on storage.objects;
create policy "Staff can delete booking files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'booking-files' and public.is_staff());

-- ---------------------------------------------------------------------------
-- Adding a staff member
-- 1. Authentication > Users > Add user > Create new user (email + password, tick Auto Confirm).
-- 2. Run the line below with their email address:
--
--   insert into public.staff (user_id, name)
--   select id, 'Studio' from auth.users where email = 'bookings@alturahertz.com'
--   on conflict do nothing;
--
-- Also turn off public sign ups: Authentication > Sign In / Providers > Allow new users to sign up (off).
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;
create extension if not exists pg_cron;

create type public.app_role as enum ('neighbor', 'admin');
create type public.sport_type as enum ('tennis', 'football');
create type public.booking_status as enum ('open', 'full', 'checked_in', 'no_show', 'cancelled');
create type public.notification_kind as enum ('booking_cancelled', 'waitlist_promoted');

create table public.homes (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  home_id uuid not null references public.homes(id) on delete restrict,
  full_name text not null,
  role public.app_role not null default 'neighbor',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  sport public.sport_type not null,
  slot_start timestamptz not null,
  local_date date not null,
  status public.booking_status not null default 'open',
  creator_user_id uuid not null references public.profiles(id) on delete restrict,
  creator_home_id uuid not null references public.homes(id) on delete restrict,
  first_checked_in_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.booking_participants (
  booking_id uuid not null references public.bookings(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (booking_id, user_id)
);

create table public.booking_waitlist (
  booking_id uuid not null references public.bookings(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (booking_id, user_id)
);

create table public.checkins (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  checked_in_at timestamptz not null default now(),
  unique (booking_id, user_id)
);

create table public.notification_events (
  id uuid primary key default gen_random_uuid(),
  kind public.notification_kind not null,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index bookings_slot_start_idx on public.bookings(slot_start);
create index bookings_status_slot_idx on public.bookings(status, slot_start);
create index booking_waitlist_order_idx on public.booking_waitlist(booking_id, joined_at);
create index notification_events_pending_idx on public.notification_events(created_at) where processed_at is null;

create unique index bookings_one_active_per_slot_idx
  on public.bookings(slot_start)
  where status in ('open', 'full', 'checked_in');

create unique index bookings_one_active_created_per_home_day_idx
  on public.bookings(creator_home_id, local_date)
  where status in ('open', 'full', 'checked_in');

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

create trigger bookings_touch_updated_at
  before update on public.bookings
  for each row execute function public.touch_updated_at();

create or replace function public.set_booking_local_date()
returns trigger
language plpgsql
as $$
begin
  new.local_date = (new.slot_start at time zone 'Europe/Madrid')::date;
  return new;
end;
$$;

create trigger bookings_set_local_date
  before insert or update of slot_start on public.bookings
  for each row execute function public.set_booking_local_date();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.sport_capacity(p_sport public.sport_type)
returns integer
language sql
immutable
as $$
  select case when p_sport = 'tennis' then 4 else 15 end;
$$;

create or replace function public.is_valid_madrid_slot(p_slot_start timestamptz)
returns boolean
language sql
stable
as $$
  select
    extract(minute from p_slot_start at time zone 'Europe/Madrid') = 0
    and extract(second from p_slot_start at time zone 'Europe/Madrid') = 0
    and extract(hour from p_slot_start at time zone 'Europe/Madrid') between 9 and 21;
$$;

create or replace function public.create_booking(p_sport public.sport_type, p_slot_start timestamptz)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_home_id uuid;
  v_booking_id uuid;
begin
  if v_user_id is null then
    raise exception 'Debes iniciar sesión para reservar.';
  end if;

  select home_id into v_home_id
  from public.profiles
  where id = v_user_id;

  if v_home_id is null then
    raise exception 'Tu usuario no está asignado a ningún piso.';
  end if;

  if p_slot_start < now() then
    raise exception 'No puedes reservar un slot que ya ha empezado.';
  end if;

  if p_slot_start > now() + interval '48 hours' then
    raise exception 'Solo puedes reservar con hasta 48 horas de antelación.';
  end if;

  if not public.is_valid_madrid_slot(p_slot_start) then
    raise exception 'El horario debe estar entre las 09:00 y las 21:00 en slots de 60 minutos.';
  end if;

  insert into public.bookings (sport, slot_start, creator_user_id, creator_home_id)
  values (p_sport, p_slot_start, v_user_id, v_home_id)
  returning id into v_booking_id;

  insert into public.booking_participants (booking_id, user_id)
  values (v_booking_id, v_user_id);

  return v_booking_id;
exception
  when unique_violation then
    raise exception 'Ese slot ya está reservado o tu piso ya tiene una reserva ese día.';
end;
$$;

create or replace function public.join_booking(p_booking_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_booking public.bookings%rowtype;
  v_count integer;
  v_waitlist_count integer;
  v_capacity integer;
begin
  if v_user_id is null then
    raise exception 'Debes iniciar sesión para apuntarte.';
  end if;

  select * into v_booking
  from public.bookings
  where id = p_booking_id
  for update;

  if not found or v_booking.status not in ('open', 'full') then
    raise exception 'Esta reserva no admite participantes.';
  end if;

  if v_booking.slot_start <= now() then
    raise exception 'No puedes apuntarte a una reserva que ya ha empezado.';
  end if;

  if exists (
    select 1 from public.booking_participants
    where booking_id = p_booking_id and user_id = v_user_id
  ) then
    return 'already_joined';
  end if;

  if exists (
    select 1 from public.booking_waitlist
    where booking_id = p_booking_id and user_id = v_user_id
  ) then
    return 'already_waitlisted';
  end if;

  select count(*) into v_count
  from public.booking_participants
  where booking_id = p_booking_id;

  v_capacity := public.sport_capacity(v_booking.sport);

  if v_count >= v_capacity then
    select count(*) into v_waitlist_count
    from public.booking_waitlist
    where booking_id = p_booking_id;

    if v_waitlist_count >= 10 then
      raise exception 'La lista de espera está completa.';
    end if;

    insert into public.booking_waitlist (booking_id, user_id)
    values (p_booking_id, v_user_id);

    return 'waitlisted';
  end if;

  insert into public.booking_participants (booking_id, user_id)
  values (p_booking_id, v_user_id);

  select count(*) into v_count
  from public.booking_participants
  where booking_id = p_booking_id;

  update public.bookings
  set status = case when v_count >= v_capacity then 'full'::public.booking_status else 'open'::public.booking_status end
  where id = p_booking_id;

  return 'joined';
exception
  when unique_violation then
    return 'already_joined';
end;
$$;

create or replace function public.leave_booking(p_booking_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_booking public.bookings%rowtype;
  v_capacity integer;
  v_next_user_id uuid;
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'Debes iniciar sesión para salir de una reserva.';
  end if;

  select * into v_booking
  from public.bookings
  where id = p_booking_id
  for update;

  if not found or v_booking.status not in ('open', 'full') then
    raise exception 'Esta reserva no permite cambios.';
  end if;

  if v_booking.slot_start <= now() then
    raise exception 'No puedes salir de una reserva que ya ha empezado.';
  end if;

  if v_booking.creator_user_id = v_user_id then
    raise exception 'El creador debe cancelar la reserva completa.';
  end if;

  delete from public.booking_participants
  where booking_id = p_booking_id and user_id = v_user_id;

  if not found then
    delete from public.booking_waitlist
    where booking_id = p_booking_id and user_id = v_user_id;

    if found then
      return 'left_waitlist';
    end if;

    return 'not_joined';
  end if;

  v_capacity := public.sport_capacity(v_booking.sport);

  select user_id into v_next_user_id
  from public.booking_waitlist
  where booking_id = p_booking_id
  order by joined_at
  limit 1;

  if v_next_user_id is not null then
    delete from public.booking_waitlist
    where booking_id = p_booking_id and user_id = v_next_user_id;

    insert into public.booking_participants (booking_id, user_id)
    values (p_booking_id, v_next_user_id);

    insert into public.notification_events (kind, booking_id, recipient_user_id, payload)
    values ('waitlist_promoted', p_booking_id, v_next_user_id, jsonb_build_object('slot_start', v_booking.slot_start));
  end if;

  select count(*) into v_count
  from public.booking_participants
  where booking_id = p_booking_id;

  update public.bookings
  set status = case when v_count >= v_capacity then 'full'::public.booking_status else 'open'::public.booking_status end
  where id = p_booking_id;

  return 'left';
end;
$$;

create or replace function public.cancel_booking(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_booking public.bookings%rowtype;
  v_is_admin boolean;
begin
  if v_user_id is null then
    raise exception 'Debes iniciar sesión para cancelar.';
  end if;

  select * into v_booking
  from public.bookings
  where id = p_booking_id
  for update;

  if not found or v_booking.status = 'cancelled' then
    raise exception 'Reserva no encontrada.';
  end if;

  v_is_admin := public.is_admin();

  if not v_is_admin then
    if v_booking.creator_user_id <> v_user_id then
      raise exception 'Solo el creador o un admin puede cancelar esta reserva.';
    end if;

    if v_booking.slot_start < now() + interval '1 hour' then
      raise exception 'Solo puedes cancelar hasta 1 hora antes del inicio.';
    end if;
  end if;

  update public.bookings
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = v_user_id
  where id = p_booking_id;

  insert into public.notification_events (kind, booking_id, recipient_user_id, payload)
  select 'booking_cancelled', p_booking_id, bp.user_id, jsonb_build_object('slot_start', v_booking.slot_start)
  from public.booking_participants bp
  where bp.booking_id = p_booking_id and bp.user_id <> v_user_id;
end;
$$;

create or replace function public.check_in_booking()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_booking public.bookings%rowtype;
begin
  if v_user_id is null then
    raise exception 'Debes iniciar sesión para hacer check-in.';
  end if;

  select b.* into v_booking
  from public.bookings b
  join public.booking_participants bp on bp.booking_id = b.id and bp.user_id = v_user_id
  where b.status in ('open', 'full', 'checked_in')
    and now() between b.slot_start - interval '15 minutes' and b.slot_start + interval '15 minutes'
  order by b.slot_start
  limit 1
  for update of b;

  if not found then
    raise exception 'No tienes ninguna reserva en ventana de check-in.';
  end if;

  insert into public.checkins (booking_id, user_id)
  values (v_booking.id, v_user_id)
  on conflict (booking_id, user_id) do nothing;

  if v_booking.status in ('open', 'full') then
    update public.bookings
    set status = 'checked_in',
        first_checked_in_at = coalesce(first_checked_in_at, now())
    where id = v_booking.id;
  end if;

  return v_booking.id;
end;
$$;

create or replace function public.mark_expired_no_shows()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.bookings b
  set status = 'no_show'
  where b.status in ('open', 'full')
    and now() > b.slot_start + interval '15 minutes'
    and not exists (
      select 1 from public.checkins c
      where c.booking_id = b.id
    );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

select cron.schedule(
  'reserphoenix-mark-no-shows',
  '* * * * *',
  $$select public.mark_expired_no_shows();$$
)
where not exists (
  select 1 from cron.job where jobname = 'reserphoenix-mark-no-shows'
);

alter table public.homes enable row level security;
alter table public.profiles enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_participants enable row level security;
alter table public.booking_waitlist enable row level security;
alter table public.checkins enable row level security;
alter table public.notification_events enable row level security;

create policy "authenticated can read homes"
  on public.homes for select
  to authenticated
  using (true);

create policy "admins manage homes"
  on public.homes for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "authenticated can read profiles"
  on public.profiles for select
  to authenticated
  using (true);

create policy "admins manage profiles"
  on public.profiles for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "authenticated can read bookings"
  on public.bookings for select
  to authenticated
  using (true);

create policy "admins manage bookings"
  on public.bookings for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "authenticated can read participants"
  on public.booking_participants for select
  to authenticated
  using (true);

create policy "admins manage participants"
  on public.booking_participants for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "authenticated can read waitlist"
  on public.booking_waitlist for select
  to authenticated
  using (true);

create policy "admins manage waitlist"
  on public.booking_waitlist for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "users read own checkins"
  on public.checkins for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy "admins manage checkins"
  on public.checkins for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "users read own notifications"
  on public.notification_events for select
  to authenticated
  using (recipient_user_id = auth.uid() or public.is_admin());

create policy "admins manage notifications"
  on public.notification_events for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant usage on schema public to authenticated;
grant all on public.homes, public.profiles, public.bookings, public.booking_participants, public.booking_waitlist to authenticated;
grant all on public.checkins, public.notification_events to authenticated;
grant execute on function public.create_booking(public.sport_type, timestamptz) to authenticated;
grant execute on function public.join_booking(uuid) to authenticated;
grant execute on function public.leave_booking(uuid) to authenticated;
grant execute on function public.cancel_booking(uuid) to authenticated;
grant execute on function public.check_in_booking() to authenticated;

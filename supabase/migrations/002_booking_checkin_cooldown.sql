create table if not exists public.booking_cooldowns (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  blocked_until timestamptz not null,
  last_booking_id uuid references public.bookings(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists booking_cooldowns_blocked_until_idx
  on public.booking_cooldowns(blocked_until);

alter table public.booking_cooldowns enable row level security;

create policy "users read own booking cooldowns"
  on public.booking_cooldowns for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy "admins manage booking cooldowns"
  on public.booking_cooldowns for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.booking_cooldowns to authenticated;

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
  v_blocked_until timestamptz;
begin
  if v_user_id is null then
    raise exception 'Debes iniciar sesión para apuntarte.';
  end if;

  select blocked_until into v_blocked_until
  from public.booking_cooldowns
  where user_id = v_user_id;

  if v_blocked_until is not null and v_blocked_until > now() then
    raise exception 'Has salido de una reserva. Espera 5 minutos antes de unirte a otro deporte.';
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
  v_blocked_until timestamptz := now() + interval '5 minutes';
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

  if found then
    insert into public.booking_cooldowns (user_id, blocked_until, last_booking_id, updated_at)
    values (v_user_id, v_blocked_until, p_booking_id, now())
    on conflict (user_id) do update
      set blocked_until = greatest(public.booking_cooldowns.blocked_until, excluded.blocked_until),
          last_booking_id = excluded.last_booking_id,
          updated_at = now();
  else
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

  return 'left_with_cooldown';
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

create or replace function public.check_in_booking(p_booking_id uuid)
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
  where b.id = p_booking_id
    and b.status in ('open', 'full', 'checked_in')
    and now() between b.slot_start - interval '15 minutes' and b.slot_start + interval '15 minutes'
  for update of b;

  if not found then
    raise exception 'No tienes acceso a esta reserva o no está en ventana de check-in.';
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

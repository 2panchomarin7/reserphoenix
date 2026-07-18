-- Track late cancellations per user
create table if not exists public.late_cancellations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  cancelled_at timestamptz not null default now()
);

alter table public.late_cancellations enable row level security;

create policy "users read own late cancellations"
  on public.late_cancellations for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy "admins manage late cancellations"
  on public.late_cancellations for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.late_cancellations to authenticated;

-- Replace leave_booking to handle 3-strike late cancellation rule
drop function if exists public.leave_booking(uuid);
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
  v_is_late boolean;
  v_late_count integer;
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

  v_is_late := v_booking.slot_start < now() + interval '1 hour';

  delete from public.booking_participants
  where booking_id = p_booking_id and user_id = v_user_id;

  if found then
    if v_is_late then
      insert into public.late_cancellations (user_id, booking_id)
      values (v_user_id, p_booking_id);

      select count(*) into v_late_count
      from public.late_cancellations
      where user_id = v_user_id;

      if v_late_count >= 3 then
        v_blocked_until := now() + interval '3 days';
        delete from public.late_cancellations where user_id = v_user_id;
      end if;
    end if;

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

  if v_is_late and v_late_count >= 3 then
    return 'left_with_3day_block';
  elsif v_is_late then
    return 'left_with_late_warning';
  end if;

  return 'left_with_cooldown';
end;
$$;

-- Replace cancel_booking to allow late cancellation but apply penalty
drop function if exists public.cancel_booking(uuid);
create or replace function public.cancel_booking(p_booking_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_booking public.bookings%rowtype;
  v_is_admin boolean;
  v_is_late boolean;
  v_late_count integer;
  v_blocked_until timestamptz := now() + interval '5 minutes';
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

    if v_booking.slot_start <= now() then
      raise exception 'No puedes cancelar una reserva que ya ha empezado.';
    end if;
  end if;

  v_is_late := v_booking.slot_start < now() + interval '1 hour';

  update public.bookings
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = v_user_id
  where id = p_booking_id;

  insert into public.notification_events (kind, booking_id, recipient_user_id, payload)
  select 'booking_cancelled', p_booking_id, bp.user_id, jsonb_build_object('slot_start', v_booking.slot_start)
  from public.booking_participants bp
  where bp.booking_id = p_booking_id and bp.user_id <> v_user_id;

  if not v_is_admin and v_is_late then
    insert into public.late_cancellations (user_id, booking_id)
    values (v_user_id, p_booking_id);

    select count(*) into v_late_count
    from public.late_cancellations
    where user_id = v_user_id;

    if v_late_count >= 3 then
      v_blocked_until := now() + interval '3 days';
      delete from public.late_cancellations where user_id = v_user_id;
    end if;

    insert into public.booking_cooldowns (user_id, blocked_until, last_booking_id, updated_at)
    values (v_user_id, v_blocked_until, p_booking_id, now())
    on conflict (user_id) do update
      set blocked_until = greatest(public.booking_cooldowns.blocked_until, excluded.blocked_until),
          last_booking_id = excluded.last_booking_id,
          updated_at = now();

    if v_late_count >= 3 then
      return 'cancelled_with_3day_block';
    else
      return 'cancelled_with_late_warning';
    end if;
  end if;

  return 'cancelled';
end;
$$;

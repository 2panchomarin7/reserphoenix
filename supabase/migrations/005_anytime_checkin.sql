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
  order by b.slot_start
  limit 1
  for update of b;

  if not found then
    raise exception 'No tienes ninguna reserva válida para hacer check-in en este momento.';
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
  for update of b;

  if not found then
    raise exception 'No tienes acceso a esta reserva o no está en un estado válido para check-in.';
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

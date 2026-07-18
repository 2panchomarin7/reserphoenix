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

  if (p_slot_start at time zone 'Europe/Madrid')::date > (now() at time zone 'Europe/Madrid')::date + 2 then
    raise exception 'Solo puedes reservar con hasta 2 días de antelación.';
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

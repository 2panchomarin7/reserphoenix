-- Add unique sequential booking number to the bookings table
alter table public.bookings add column if not exists booking_number serial unique;

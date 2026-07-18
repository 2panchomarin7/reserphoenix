# Reserphoenix

Web app para reservar una pista comunitaria compartida entre tenis y fútbol.

## Incluye

- Login por email con Supabase Auth.
- Reservas en slots fijos de 60 minutos entre 09:00 y 22:00, zona `Europe/Madrid`.
- Límite de 1 reserva creada por piso y día, con ventana máxima de 48h.
- Cupos: tenis 4, fútbol 15.
- Lista de espera automática de hasta 10 vecinos.
- QR fijo en `/check-in`.
- Migración SQL con RLS, constraints parciales, triggers, RPCs transaccionales y cron de no-show.

## Configuración

1. Crea un proyecto Supabase.
2. Copia `.env.example` a `.env.local` y rellena:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

3. Aplica la migración:

```bash
supabase db push
```

También puedes pegar el SQL de `supabase/migrations/001_initial_schema.sql` en el SQL editor de Supabase.

## Alta inicial y vecinos

El login de vecinos usa:

- Usuario: el piso, por ejemplo `3º A`.
- Password: la contraseña aleatoria que genera un admin.

Un admin puede dar de alta vecinos desde el panel de la app. La ruta server-side usa `SUPABASE_SERVICE_ROLE_KEY` para crear el usuario en Supabase Auth, crear el piso si no existe y vincular el perfil.

Para el primer admin, crea/invita el usuario desde Supabase Auth y añade su perfil manualmente. Supabase Auth crea usuarios en `auth.users`, pero la app necesita una fila en `profiles` y un piso en `homes`.

Ejemplo mínimo tras invitar/crear un usuario:

```sql
insert into public.homes (label)
values ('3º A')
on conflict (label) do nothing;

insert into public.profiles (id, home_id, full_name, role)
select
  'USER_UUID_DE_AUTH',
  h.id,
  'Nombre Vecino',
  'admin'
from public.homes h
where h.label = '3º A';
```

Después de crear el primer admin, el resto de vecinos se gestionan desde el panel de administración.

## Desarrollo

```bash
npm install
npm run dev
```

Abre `http://localhost:3000`.

## Verificación

```bash
npm run typecheck
npm run build
```

## Notas

- La tabla `notification_events` registra emails pendientes para cancelaciones y promociones desde waitlist. El envío real puede conectarse después con una Edge Function o proveedor externo.
- El QR fijo sirve como auditoría básica de asistencia, no como prueba fuerte de presencia física.

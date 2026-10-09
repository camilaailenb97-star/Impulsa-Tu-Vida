-- ============================================================
-- Impulsa Tu Vida — solo los compradores pueden crear una cuenta
--
-- PROBLEMA QUE RESUELVE
--   La app revisa la tabla "compradores" ANTES de registrar, pero esa revisión
--   ocurre en el navegador. Cualquiera con conocimientos técnicos puede llamar
--   directamente a Supabase Auth (signup) con la clave pública y saltearla.
--
-- SOLUCIÓN
--   Un "Auth Hook" de Supabase (Before User Created): Supabase ejecuta esta
--   función en el SERVIDOR cada vez que se intenta crear un usuario, y rechaza
--   el alta si el email no está en public.compradores. No se puede saltear desde
--   el navegador.
--
-- QUÉ NO HACE
--   - No modifica, mueve ni borra ninguna fila (ni de compradores, ni de gastos,
--     ingresos, config_meses ni auth.users).
--   - No toca las políticas RLS existentes.
--   - No afecta a los usuarios que YA tienen cuenta: solo controla altas nuevas.
--
-- CÓMO USARLO (lo hace la dueña del proyecto, desde el panel de Supabase)
--   PASO 1 — SQL Editor → New query → pegar la SECCIÓN 1 → Run.
--   PASO 2 — Authentication → Hooks → "Before User Created" → Add hook
--            → tipo "Postgres" → esquema "public" → función
--            "hook_solo_compradores" → Create/Enable.
--   PASO 3 — (opcional, solo lectura) pegar la SECCIÓN 2 para ver si hay
--            cuentas existentes cuyo email no figura en compradores.
-- ============================================================


-- ===================== SECCIÓN 1: crear la función =====================
create or replace function public.hook_solo_compradores(event jsonb)
returns jsonb
language plpgsql
security definer          -- puede leer compradores aunque la tabla tenga RLS
set search_path = public
as $$
declare
  correo text := lower(trim(coalesce(event -> 'user' ->> 'email', '')));
begin
  if correo = '' or not exists (
    select 1 from public.compradores c where lower(trim(c.email)) = correo
  ) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Este correo no tiene acceso. Comprá Impulsa Tu Vida para registrarte.'
      )
    );
  end if;
  return '{}'::jsonb;   -- permitido
end;
$$;

-- Solo el servicio de Auth de Supabase puede ejecutarla; nadie desde la app/API.
revoke all on function public.hook_solo_compradores(jsonb) from public, anon, authenticated;
grant execute on function public.hook_solo_compradores(jsonb) to supabase_auth_admin;


-- ===================== SECCIÓN 2: revisión (solo lectura) =====================
-- Cuentas existentes cuyo email NO está en compradores (no modifica nada).
-- select u.email, u.created_at, u.last_sign_in_at
-- from auth.users u
-- left join public.compradores c on lower(trim(c.email)) = lower(trim(u.email))
-- where c.email is null
-- order by u.created_at;


-- ===================== CÓMO DESHACERLO =====================
-- 1) Authentication → Hooks → "Before User Created" → desactivar/eliminar el hook.
-- 2) Luego (opcional):
-- drop function if exists public.hook_solo_compradores(jsonb);

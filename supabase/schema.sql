-- ============================================================
-- Impulsa Tu Vida — esquema de Supabase
--
-- Cómo usarlo:
--   1. Entra a tu proyecto en https://supabase.com/dashboard
--   2. Menú izquierdo → SQL Editor → New query
--   3. Pega TODO este archivo y presiona Run
--
-- Qué hace:
--   - Crea las 3 tablas donde vive la app: gastos, ingresos y config_meses
--     (presupuesto + meta de ahorro por mes).
--   - Activa Row Level Security (RLS) y una política por tabla que hace
--     que cada usuario solo pueda leer, crear, editar o borrar SUS PROPIAS
--     filas (las que tienen user_id = auth.uid()). Ni siquiera con la
--     Publishable/anon key se puede ver o tocar datos de otro usuario.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.gastos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  monto numeric not null check (monto > 0),
  categoria text not null,
  nota text default '',
  fecha date not null,
  creado_en bigint not null
);

create table if not exists public.ingresos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  monto numeric not null check (monto > 0),
  concepto text default '',
  fecha date not null,
  creado_en bigint not null
);

create table if not exists public.config_meses (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  anio int not null,
  mes int not null check (mes between 1 and 12),
  presupuesto numeric not null default 0,
  meta_ahorro numeric not null default 0,
  primary key (user_id, anio, mes)
);

alter table public.gastos enable row level security;
alter table public.ingresos enable row level security;
alter table public.config_meses enable row level security;

drop policy if exists "gastos_propios" on public.gastos;
create policy "gastos_propios" on public.gastos
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "ingresos_propios" on public.ingresos;
create policy "ingresos_propios" on public.ingresos
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "config_propia" on public.config_meses;
create policy "config_propia" on public.config_meses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists gastos_user_fecha_idx on public.gastos(user_id, fecha);
create index if not exists ingresos_user_fecha_idx on public.ingresos(user_id, fecha);

-- ============================================================
-- Impulsa Tu Vida — revisión de la tabla "compradores" (SOLO LECTURA)
--
-- No crea, modifica ni borra nada. Supabase → SQL Editor → New query →
-- pegar TODO → Run. Muestra una sola fila con los resultados.
--
-- Qué tiene que dar para activar la carga automática:
--   email_unico                 = true   (sin esto, ignore-duplicates no funciona)
--   duplicados_por_mayusculas   = 0
--   emails_con_mayus_o_espacios = 0      (si no es 0, conviene pasarlos a minúsculas)
--   rls_activo                  = true
--   politicas_publicas          = 0      (nadie puede leer/escribir con la clave pública)
--   hook_existe                 = true   (el hook "Before User Created")
-- ============================================================
select
  exists (
    select 1 from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = 'public.compradores'::regclass
      and i.indisunique and i.indnatts = 1 and a.attname = 'email'
  ) as email_unico,
  (select count(*) from (
     select lower(trim(email)) from public.compradores group by 1 having count(*) > 1
   ) d) as duplicados_por_mayusculas,
  (select count(*) from public.compradores where email <> lower(trim(email))) as emails_con_mayus_o_espacios,
  (select count(*) from public.compradores) as total_compradores,
  (select relrowsecurity from pg_class where oid = 'public.compradores'::regclass) as rls_activo,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'compradores'
      and (roles && array['anon','authenticated','public']::name[])) as politicas_publicas,
  exists (select 1 from pg_proc where proname = 'hook_solo_compradores') as hook_existe;

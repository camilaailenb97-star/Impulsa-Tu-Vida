-- ============================================================
-- Impulsa Tu Vida — ejecutar "mercadopago-compradores" cada 10 minutos
--
-- Usa pg_cron (programador) y pg_net (llamadas HTTP) de Supabase. La clave que
-- protege la función se guarda cifrada en Vault con el nombre "mp_cron_secret"
-- (se crea aparte; nunca se escribe en este archivo).
--
-- No crea, modifica ni borra filas de ninguna tabla de la app.
-- ============================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'mercadopago-compradores',          -- si ya existe con este nombre, se reemplaza
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://fxdqlihzxbkrciroomkb.supabase.co/functions/v1/mercadopago-compradores',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mp_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- CÓMO VER SI CORRE (solo lectura):
-- select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'mercadopago-compradores') order by start_time desc limit 5;
-- select status_code, left(content::text, 300) from net._http_response order by created desc limit 5;

-- CÓMO DESACTIVARLO:
-- select cron.unschedule('mercadopago-compradores');

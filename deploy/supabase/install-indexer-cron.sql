-- Milvance — schedule the indexer tick.
--
-- This is the free deployment's replacement for an always-running worker. Once
-- a minute Supabase calls the Milvance API, which indexes a bounded amount of
-- real Stellar history through exactly the same code the CLI worker runs.
--
-- THIS FILE CONTAINS NO SECRET AND MUST NEVER CONTAIN ONE.
--
-- It reads two values from Supabase Vault at run time. Create them first, in
-- the dashboard under Project Settings → Vault, or by running:
--
--   select vault.create_secret('https://milvance-api.onrender.com', 'milvance_api_url');
--   select vault.create_secret('<the INDEXER_CRON_SECRET from Render>', 'milvance_indexer_cron_secret');
--
-- Run those two statements in a query window and do not save them into a file
-- or a migration: a secret pasted into version control is a secret published.
-- To rotate, update the Vault secret; the job below picks it up on its next
-- run with no change here.
--
-- Then run this file in the Supabase SQL editor.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replacing an existing job rather than stacking a second one. Two schedulers
-- would not corrupt anything — the tick takes a lease and the second caller is
-- told the stream is busy — but it would double the requests for nothing.
select cron.unschedule('milvance-indexer-tick')
where exists (select 1 from cron.job where jobname = 'milvance-indexer-tick');

select cron.schedule(
  'milvance-indexer-tick',
  '* * * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'milvance_api_url'
      ) || '/api/internal/indexer/tick',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'milvance_indexer_cron_secret'
        )
      ),
      -- The endpoint takes no input. It cannot be told which ledgers to read,
      -- and it will not accept an event from a caller: everything it indexes
      -- comes from the configured Stellar RPC. The empty body is deliberate.
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $job$
);

-- Check it afterwards:
--
--   select jobid, jobname, schedule, active from cron.job
--    where jobname = 'milvance-indexer-tick';
--
--   select status, return_message, start_time
--     from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'milvance-indexer-tick')
--    order by start_time desc limit 5;
--
-- `job_run_details` records whether the REQUEST was made. For what the tick
-- actually did, read the response:
--
--   select id, status_code, content::text
--     from net._http_response order by created desc limit 5;
--
-- A healthy response looks like {"status":"ran", ... ,"caughtUp":true}.
-- `already_running` is normal while a backfill is in progress. A 401 means the
-- Vault secret and the Render environment variable have drifted apart.

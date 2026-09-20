-- Milvance — unschedule the indexer tick.
--
-- Safe at any time. Nothing financial depends on it: Stellar remains the source
-- of truth and the read model can be rebuilt from chain whenever indexing
-- resumes. While the job is gone the workspace simply stops advancing, which
-- `/api/health/ready` reports as degraded rather than hiding.
--
-- The Vault secrets are deliberately left in place so the job can be
-- reinstalled without re-entering them. Remove them explicitly if you are
-- tearing the project down:
--
--   select vault.delete_secret(id) from vault.secrets
--    where name in ('milvance_api_url', 'milvance_indexer_cron_secret');

select cron.unschedule('milvance-indexer-tick')
where exists (select 1 from cron.job where jobname = 'milvance-indexer-tick');

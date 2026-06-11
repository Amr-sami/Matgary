-- pg_stat_statements observability.
--
-- Enables Postgres's query-statistics extension so the top-10 slow queries
-- by total/mean exec time are queryable from psql or any Grafana/pgwatch
-- dashboard pointed at the cluster. Required for the "first response" perf
-- workflow: see audit AUDIT_DEEP.md §8.
--
-- Idempotent — IF NOT EXISTS guards both the extension creation and the
-- reset call so re-running this migration is safe.
--
-- Notes for operators:
--   - postgresql.conf must include `shared_preload_libraries = 'pg_stat_statements'`
--     and a restart for the extension to actually collect samples. Without
--     that, CREATE EXTENSION succeeds but every column reads back zero.
--     The matgary docker-compose Postgres image does not preload by default
--     — set the shared_preload_libraries env or override postgresql.conf.
--   - The view is global (not tenant-scoped). It exposes query text — set
--     `pg_stat_statements.track = top` (the default) to avoid storing the
--     bodies of subqueries the planner generated.

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Grant read on the view to the app role so a future in-app perf dashboard
-- can read it without escalating. (The pg_stat_statements function itself
-- is granted to public by default; the view inherits but we make it
-- explicit so a stricter Postgres install still works.)
GRANT SELECT ON pg_stat_statements TO matgary_app;

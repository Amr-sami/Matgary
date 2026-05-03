-- Runs once on container init (mounted via docker-compose).
-- Creates a non-superuser application role so RLS policies actually fire
-- against application traffic. The owner role (`matgary`) stays superuser
-- and is used only for running migrations.

CREATE ROLE matgary_app WITH LOGIN PASSWORD 'matgary_app' NOSUPERUSER NOBYPASSRLS;

-- The app user needs schema usage and read/write on every table the migrations create.
-- We grant on the schema; default privileges below propagate to future tables.
GRANT USAGE ON SCHEMA public TO matgary_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO matgary_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO matgary_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO matgary_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO matgary_app;

#!/bin/sh
# Runs once, on a fresh Postgres data volume (docker-entrypoint-initdb.d).
#
# Production twin of init-postgres.sql. That file hardcodes the matgary_app
# password, which is fine for a laptop and unacceptable on a public host, so
# this variant reads it from the environment instead. The owner role
# (`matgary`) is created by the postgres image itself from POSTGRES_PASSWORD;
# matgary_admin is provisioned later by lib/db/migrate.ts using
# ADMIN_DB_PASSWORD.
#
# The point of matgary_app is that it is NOSUPERUSER + NOBYPASSRLS, so the
# row-level-security policies actually fire against application traffic.
# lib/db/index.ts silently falls back to DATABASE_URL when APP_DATABASE_URL is
# unset — which would run every tenant query as superuser with RLS bypassed
# and no error — so this role existing is load-bearing, not cosmetic.
set -e

if [ -z "$APP_DB_PASSWORD" ]; then
  echo "[init] APP_DB_PASSWORD is not set — refusing to create matgary_app with a default password."
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE matgary_app WITH LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS;

  GRANT USAGE ON SCHEMA public TO matgary_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO matgary_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO matgary_app;

  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO matgary_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO matgary_app;
EOSQL

echo "[init] matgary_app role created (NOSUPERUSER, NOBYPASSRLS)."

-- Dinner Bell's Postgres schema (see PgBackend in src/server/store.ts).
-- One JSONB document per entity, plus the columns that need an index or a constraint.
-- Idempotent: safe to run on every deploy.

CREATE TABLE IF NOT EXISTS households (
  id   text PRIMARY KEY,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id       text PRIMARY KEY,
  username text UNIQUE NOT NULL,
  data     jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id           text PRIMARY KEY,
  household_id text NOT NULL,
  share_slug   text UNIQUE,
  status       text NOT NULL,
  updated_at   bigint NOT NULL,
  data         jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_household_idx ON plans (household_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS tokens (
  access_hash        text PRIMARY KEY,
  refresh_hash       text UNIQUE NOT NULL,
  refresh_expires_at bigint NOT NULL,
  data               jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      text PRIMARY KEY,
  expires_at bigint NOT NULL,
  data       jsonb NOT NULL
);

-- 002_roles: writer and reader roles (design §6.2). Q0 draft; lane A owns sql/* from Q1 on.
-- Run as the owner after 001_init.sql. NO PASSWORDS HERE: migrate sets them at runtime (ALTER ROLE ... PASSWORD) from
-- a file. Roles created by SQL are not in neon_superuser, so every privilege below is explicit.
--   brain_writer  CI publish only (BRAIN_WRITER_URL): SELECT + INSERT, UPDATE (valid_to) on revision / fact tables,
--                 UPDATE (status, stage, error, finished_at) on attempt. No DELETE, TRUNCATE, DDL, TEMPORARY.
--   brain_reader  laptops and agents (BRAIN_READER_URL): SELECT only. read-only and 15s timeout by default; the
--                 GRANTs are what stops writes (a session can turn default_transaction_read_only off).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'brain_writer') THEN CREATE ROLE brain_writer LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'brain_reader') THEN CREATE ROLE brain_reader LOGIN; END IF;
  -- by default PUBLIC may create temporary tables: a reader that turns read-only off could write there
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO brain_writer, brain_reader', current_database());
END $$;

ALTER ROLE brain_reader SET default_transaction_read_only = on;
ALTER ROLE brain_reader SET statement_timeout = '15s';

-- Known limits the owner cannot close on Neon (not a superuser; checked on a Neon branch, PostgreSQL 18.7):
-- - large objects: PUBLIC may run lo_create / lo_from_bytea, and REVOKE on those pg_catalog functions is a no-op for
--   the owner. A reader that turns read-only off can store bytes in pg_largeobject. Nothing in schema brain changes.
-- - any role may ALTER ROLE itself SET ... and change its own password. A reader can turn its own read-only default
--   off or lock the team out by changing the shared password; the owner resets it (design §6.2 rotation).

REVOKE ALL ON SCHEMA brain FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA brain FROM PUBLIC;

GRANT USAGE ON SCHEMA brain TO brain_writer, brain_reader;

GRANT SELECT ON ALL TABLES IN SCHEMA brain TO brain_reader;

GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA brain TO brain_writer;
GRANT UPDATE (valid_to) ON brain.node_rev, brain.item_rev, brain.edge, brain.unresolved, brain.link, brain.ref_link TO brain_writer;
GRANT UPDATE (status, stage, error, finished_at) ON brain.attempt TO brain_writer;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA brain TO brain_writer;

-- tables a later migration creates get the same base privileges (column UPDATE grants stay explicit per migration)
ALTER DEFAULT PRIVILEGES IN SCHEMA brain GRANT SELECT ON TABLES TO brain_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA brain GRANT SELECT, INSERT ON TABLES TO brain_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA brain GRANT USAGE ON SEQUENCES TO brain_writer;

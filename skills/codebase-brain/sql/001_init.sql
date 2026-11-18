-- 001_init: schema brain (design docs/phase2-design.md §6.1–§6.2). Q0 draft; lane A owns sql/* from Q1 on.
-- Applied by src/pg/migrate.mjs as the owner (neondb_owner), in one transaction with its ledger row. Never edit an
-- applied file: add sql/NNN_*.sql instead.
-- Column meanings and the SQLite -> server mapping: src/pg/contract.mjs COLUMN_MAP.
--
-- Table shapes:
--   identity   node, item, binding          written once, never changed (a key that reappears reuses its row)
--   revision   node_rev, item_rev           a new row only when the content hash changes; old rows only get valid_to once
--              chunk, ref                    written with their revision, never changed
--   fact       edge, unresolved, link, ref_link   one row per fact; closed by valid_to, reopened as a new row
--   record     run, sync_state              inserted by the publish transaction only
--   execution  attempt                      status moves once, from running to an end state
-- Visible at run R: valid_from <= R AND (valid_to IS NULL OR valid_to > R); chunk / ref follow their revision.
--
-- Guards (triggers, for every role including the owner; a retention migration disables them explicitly):
--   - no DELETE, no TRUNCATE anywhere (attempt included)
--   - UPDATE only on revision / fact rows, only valid_to NULL -> the run being published, every other column equal
--   - every new revision / fact / identity / chunk / ref / sync_state row belongs to the run inserted by the SAME
--     transaction (brain.publishing_run()); revisions get rev_no = previous + 1
--   - a run row takes the publish advisory lock itself (contract.PUBLISH_LOCK_KEY = 2026111601, exclusive, held to
--     COMMIT), needs a running attempt and a run_id above every earlier one, is the only run of its transaction and is
--     inserted at the transaction's top level (not inside a SAVEPOINT); run ids therefore follow commit order
--   - attempt: inserted as running; status changes once; 'ok' only in the transaction that inserted its run

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;   -- R14
CREATE SCHEMA brain;

-- execution record: one row per Actions attempt (R2)
CREATE TABLE brain.attempt (
  attempt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gha_run_id bigint NOT NULL,
  gha_attempt int NOT NULL,
  source_sha text NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40}$'),
  base_run bigint,                         -- latest run when the attempt started; null on an empty server
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed', 'abandoned', 'skipped')),
  stage text,                              -- the failed stage
  error text,                              -- kind only, no secret
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (gha_run_id, gha_attempt)
);

-- version = one successful publish (§5.3)
CREATE TABLE brain.run (
  run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id bigint NOT NULL UNIQUE REFERENCES brain.attempt,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  mode text NOT NULL CHECK (mode IN ('normal', 'bootstrap')),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),   -- after the lock, so it follows run_id order
  tool_version text NOT NULL,
  sanitize_version int NOT NULL,           -- code.db meta.sanitize_version
  meta jsonb NOT NULL,                     -- code.db meta without repo / worktree (R16)
  checksum jsonb NOT NULL                  -- contract.checksum of the visible state
);
ALTER TABLE brain.attempt ADD FOREIGN KEY (base_run) REFERENCES brain.run;

-- per-run source state: 'github' = github.db sync_state row + collection ledger (contract.githubSyncState)
CREATE TABLE brain.sync_state (
  run_id bigint NOT NULL REFERENCES brain.run,
  source text NOT NULL CHECK (source IN ('github', 'git')),
  state jsonb NOT NULL,
  PRIMARY KEY (run_id, source)
);

-- the source repo this database belongs to (R1). One row, written once
CREATE TABLE brain.binding (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  source_repo_id bigint NOT NULL,          -- GitHub numeric repo id
  source_repo text NOT NULL,               -- owner/name, display only
  ops_repo text NOT NULL,
  workflow text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- files, dirs, symbols. key: path | dir:path | path#keyName@kind (contract.canonicalNodeKey)
CREATE TABLE brain.node (
  node_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL UNIQUE,
  node_kind text NOT NULL CHECK (node_kind IN ('file', 'dir', 'symbol')),
  path text NOT NULL,                      -- Phase 0 nodes.path
  file_id bigint REFERENCES brain.node,    -- the symbol's file
  CHECK ((node_kind = 'symbol') = (file_id IS NOT NULL))
);

CREATE TABLE brain.node_rev (
  rev_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node_id bigint NOT NULL REFERENCES brain.node,
  rev_no int NOT NULL CHECK (rev_no >= 1),
  valid_from bigint NOT NULL REFERENCES brain.run,
  valid_to bigint REFERENCES brain.run,
  hash bytea NOT NULL CHECK (length(hash) = 32),   -- contract.nodeHash
  p0_key text NOT NULL,                    -- Phase 0 nodes.key (display, mirror)
  kind text NOT NULL,
  name text NOT NULL,
  line int,
  end_line int,
  parent_id bigint REFERENCES brain.node,
  exported boolean NOT NULL,
  lang text,
  flags text,
  UNIQUE (node_id, rev_no),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX node_rev_current ON brain.node_rev (node_id) WHERE valid_to IS NULL;

CREATE TABLE brain.edge (
  edge_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fact_key bytea NOT NULL CHECK (length(fact_key) = 32),   -- contract.edgeTuple
  src_id bigint NOT NULL REFERENCES brain.node,
  dst_id bigint NOT NULL REFERENCES brain.node,
  kind text NOT NULL,
  site_file_id bigint REFERENCES brain.node,   -- Phase 0 edges.path (the site file)
  line int,
  col int,
  valid_from bigint NOT NULL REFERENCES brain.run,
  valid_to bigint REFERENCES brain.run,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX edge_current ON brain.edge (fact_key) WHERE valid_to IS NULL;
CREATE INDEX edge_dst ON brain.edge (dst_id, kind) WHERE valid_to IS NULL;
CREATE INDEX edge_src ON brain.edge (src_id, kind) WHERE valid_to IS NULL;

CREATE TABLE brain.unresolved (
  unresolved_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fact_key bytea NOT NULL CHECK (length(fact_key) = 32),   -- contract.unresolvedTuple
  path text,
  line int,
  spec text,
  local int,
  valid_from bigint NOT NULL REFERENCES brain.run,
  valid_to bigint REFERENCES brain.run,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX unresolved_current ON brain.unresolved (fact_key) WHERE valid_to IS NULL;

-- memory items. ptr: pr:123 issue:45 review:9 rc:7 ic:8 | doc:<path> change:<path> changelog:<path> | commit:<sha40>
CREATE TABLE brain.item (
  item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ptr text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('pr', 'issue', 'review', 'review_comment', 'issue_comment', 'doc', 'change', 'changelog', 'commit')),
  origin text NOT NULL CHECK (origin IN ('github', 'repo')),
  CHECK ((origin = 'github') = (kind IN ('pr', 'issue', 'review', 'review_comment', 'issue_comment')))
);

CREATE TABLE brain.item_rev (
  rev_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES brain.item,
  rev_no int NOT NULL CHECK (rev_no >= 1),
  valid_from bigint NOT NULL REFERENCES brain.run,
  valid_to bigint REFERENCES brain.run,
  hash bytea NOT NULL CHECK (length(hash) = 32),   -- contract.itemHash
  title text,                              -- GitHub items only (repo items keep their text in chunk)
  body text,
  state text,
  author text,
  source_updated_at text,                  -- GitHub updated_at exactly as fetched (text: the round trip is byte-exact)
  meta jsonb,                              -- GitHub items: contract.ITEM_META_COLUMNS
  sanitize_version int NOT NULL,
  UNIQUE (item_id, rev_no),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX item_rev_current ON brain.item_rev (item_id) WHERE valid_to IS NULL;
CREATE INDEX item_rev_title_trgm ON brain.item_rev USING gin (title public.gin_trgm_ops);

-- text pieces of a revision: repo sections / commit message; one copy of title + body for a GitHub item (ord 0)
CREATE TABLE brain.chunk (
  chunk_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rev_id bigint NOT NULL REFERENCES brain.item_rev,
  ord int NOT NULL CHECK (ord >= 0),       -- contract.orderChunks index
  start_line int,
  end_line int,
  title text,
  body text,
  sha text,
  date text,
  prs text,
  body_line int,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(body, '')), 'B')) STORED,
  UNIQUE (rev_id, ord)
);
CREATE INDEX chunk_tsv ON brain.chunk USING gin (tsv);
CREATE INDEX chunk_body_trgm ON brain.chunk USING gin (body public.gin_trgm_ops);

-- raw references of a GitHub item revision (ord = contract.orderRefs index). Lookups by rev_id use ref_rev_id_ord_key.
CREATE TABLE brain.ref (
  ref_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rev_id bigint NOT NULL REFERENCES brain.item_rev,
  ord int NOT NULL CHECK (ord >= 0),
  kind text NOT NULL,                      -- file | dir | symbol | commit | item | route | name
  target text NOT NULL,
  origin text NOT NULL,                    -- pr-files | merge-sha | inline | text
  UNIQUE (rev_id, ord),
  UNIQUE (rev_id, kind, target, origin)
);
CREATE INDEX ref_target ON brain.ref (target);

CREATE TABLE brain.ref_link (
  ref_link_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fact_key bytea NOT NULL CHECK (length(fact_key) = 32),   -- contract.refLinkTuple
  ref_id bigint NOT NULL REFERENCES brain.ref,
  status text NOT NULL CHECK (status IN ('pending', 'linked', 'ambiguous', 'unlinked')),
  reason text,
  resolved jsonb,                          -- canonical node keys or pointers, max 10 (display evidence, not a FK)
  resolved_raw text,                       -- Phase 1 refs.resolved as stored
  valid_from bigint NOT NULL REFERENCES brain.run,
  valid_to bigint REFERENCES brain.run,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX ref_link_current ON brain.ref_link (fact_key) WHERE valid_to IS NULL;

-- memory -> code
CREATE TABLE brain.link (
  link_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fact_key bytea NOT NULL CHECK (length(fact_key) = 32),   -- contract.linkTuple
  chunk_id bigint NOT NULL REFERENCES brain.chunk,
  node_id bigint NOT NULL REFERENCES brain.node,
  kind text NOT NULL,
  evidence text,
  valid_from bigint NOT NULL REFERENCES brain.run,
  valid_to bigint REFERENCES brain.run,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX link_current ON brain.link (fact_key) WHERE valid_to IS NULL;
CREATE INDEX link_node ON brain.link (node_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- Guards

-- the run inserted by the current transaction, or null. The GUC alone proves nothing (any session may set it): the
-- run row's xmin must be this transaction and it must be the newest run (so a wrapped-around xid never matches an old run).
CREATE FUNCTION brain.publishing_run() RETURNS bigint LANGUAGE sql AS $$
  SELECT r.run_id FROM brain.run r
  WHERE r.run_id = nullif(pg_catalog.current_setting('brain.publishing_run', true), '')::bigint
    AND r.xmin = pg_catalog.pg_current_xact_id()::xid
    AND r.run_id = (SELECT max(run_id) FROM brain.run)
$$;

CREATE FUNCTION brain.refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'brain.%: % is not allowed (rows are never overwritten or removed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION brain.guard_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The guard takes the publish lock itself, exclusive and transaction-level: it cannot be shared or released before
  -- COMMIT, so no other run row can commit between this check and this transaction's end (re-taking a lock the caller
  -- already holds is a no-op).
  PERFORM pg_catalog.pg_advisory_xact_lock(2026111601);
  -- one run per transaction, checked on the rows as well: the session setting alone can be reset by the caller, and a
  -- multi-row INSERT reaches this check before mark (an AFTER trigger) ran for its first row
  IF brain.publishing_run() IS NOT NULL OR EXISTS (SELECT 1 FROM brain.run WHERE xmin = pg_catalog.pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'brain.run: one run per transaction' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.run_id <= (SELECT coalesce(max(run_id), 0) FROM brain.run) THEN
    RAISE EXCEPTION 'brain.run: run_id % is not above every earlier run', NEW.run_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM brain.attempt WHERE attempt_id = NEW.attempt_id AND status = 'running') THEN
    RAISE EXCEPTION 'brain.run: attempt % is not running', NEW.attempt_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION brain.mark_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_catalog.set_config('brain.publishing_run', NEW.run_id::text, true);   -- transaction-local
  -- inside a SAVEPOINT the row's xmin is the subtransaction's id, so publishing_run() could never see it: refuse now,
  -- not at the first guarded insert after it
  IF brain.publishing_run() IS DISTINCT FROM NEW.run_id THEN
    RAISE EXCEPTION 'brain.run: insert the run row at the top level of its transaction, not inside a SAVEPOINT'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $$;

-- INSERT on every table the publish transaction writes
CREATE FUNCTION brain.guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r bigint := brain.publishing_run();
BEGIN
  IF r IS NULL THEN
    RAISE EXCEPTION 'brain.%: insert only inside a publish (after its run row)', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  CASE TG_TABLE_NAME
  WHEN 'node', 'item' THEN NULL;
  WHEN 'sync_state' THEN
    IF NEW.run_id IS DISTINCT FROM r THEN
      RAISE EXCEPTION 'brain.sync_state: run_id must be the run being published' USING ERRCODE = 'insufficient_privilege';
    END IF;
  WHEN 'chunk', 'ref' THEN
    IF NOT EXISTS (SELECT 1 FROM brain.item_rev WHERE rev_id = NEW.rev_id AND valid_from = r AND valid_to IS NULL) THEN
      RAISE EXCEPTION 'brain.%: only a revision written by this publish gets rows', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF NEW.valid_from IS DISTINCT FROM r OR NEW.valid_to IS NOT NULL THEN
      RAISE EXCEPTION 'brain.%: new rows are open and start at the run being published', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_TABLE_NAME = 'node_rev' THEN
      IF NEW.rev_no <> 1 + coalesce((SELECT max(rev_no) FROM brain.node_rev WHERE node_id = NEW.node_id), 0) THEN
        RAISE EXCEPTION 'brain.node_rev: rev_no must follow the last revision' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF TG_TABLE_NAME = 'item_rev' THEN
      IF NEW.rev_no <> 1 + coalesce((SELECT max(rev_no) FROM brain.item_rev WHERE item_id = NEW.item_id), 0) THEN
        RAISE EXCEPTION 'brain.item_rev: rev_no must follow the last revision' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END CASE;
  RETURN NEW;
END $$;

-- UPDATE / DELETE on revision and fact tables: only closing an open row, once, in the run being published
CREATE FUNCTION brain.guard_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'brain.%: rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL OR NEW.valid_to IS DISTINCT FROM brain.publishing_run()
     OR (pg_catalog.to_jsonb(NEW) - 'valid_to') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'valid_to') THEN
    RAISE EXCEPTION 'brain.%: only valid_to changes, once, from null to the run being published', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION brain.guard_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'brain.attempt: rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'running' OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'brain.attempt: a new attempt is running' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'running' OR NEW.status = 'running'
     OR (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'stage', 'error', 'finished_at'])
        IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'stage', 'error', 'finished_at']) THEN
    RAISE EXCEPTION 'brain.attempt: status moves once, from running to an end state' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'ok' AND NOT EXISTS (SELECT 1 FROM brain.run WHERE attempt_id = NEW.attempt_id AND run_id = brain.publishing_run()) THEN
    RAISE EXCEPTION 'brain.attempt: ok only inside the publish that inserted its run' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON brain.attempt FOR EACH ROW EXECUTE FUNCTION brain.guard_attempt();
CREATE TRIGGER guard BEFORE INSERT ON brain.run FOR EACH ROW EXECUTE FUNCTION brain.guard_run();
CREATE TRIGGER mark AFTER INSERT ON brain.run FOR EACH ROW EXECUTE FUNCTION brain.mark_run();
CREATE TRIGGER guard BEFORE INSERT ON brain.sync_state FOR EACH ROW EXECUTE FUNCTION brain.guard_insert();
CREATE TRIGGER guard BEFORE INSERT ON brain.node FOR EACH ROW EXECUTE FUNCTION brain.guard_insert();
CREATE TRIGGER guard BEFORE INSERT ON brain.item FOR EACH ROW EXECUTE FUNCTION brain.guard_insert();
CREATE TRIGGER guard BEFORE INSERT ON brain.chunk FOR EACH ROW EXECUTE FUNCTION brain.guard_insert();
CREATE TRIGGER guard BEFORE INSERT ON brain.ref FOR EACH ROW EXECUTE FUNCTION brain.guard_insert();
CREATE TRIGGER refuse BEFORE UPDATE OR DELETE ON brain.run FOR EACH ROW EXECUTE FUNCTION brain.refuse();
CREATE TRIGGER refuse BEFORE UPDATE OR DELETE ON brain.sync_state FOR EACH ROW EXECUTE FUNCTION brain.refuse();
CREATE TRIGGER refuse BEFORE UPDATE OR DELETE ON brain.binding FOR EACH ROW EXECUTE FUNCTION brain.refuse();
CREATE TRIGGER refuse BEFORE UPDATE OR DELETE ON brain.node FOR EACH ROW EXECUTE FUNCTION brain.refuse();
CREATE TRIGGER refuse BEFORE UPDATE OR DELETE ON brain.item FOR EACH ROW EXECUTE FUNCTION brain.refuse();
CREATE TRIGGER refuse BEFORE UPDATE OR DELETE ON brain.chunk FOR EACH ROW EXECUTE FUNCTION brain.refuse();
CREATE TRIGGER refuse BEFORE UPDATE OR DELETE ON brain.ref FOR EACH ROW EXECUTE FUNCTION brain.refuse();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['node_rev', 'item_rev', 'edge', 'unresolved', 'link', 'ref_link'] LOOP
    EXECUTE format('CREATE TRIGGER guard BEFORE INSERT ON brain.%I FOR EACH ROW EXECUTE FUNCTION brain.guard_insert()', t);
    EXECUTE format('CREATE TRIGGER close BEFORE UPDATE OR DELETE ON brain.%I FOR EACH ROW EXECUTE FUNCTION brain.guard_close()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['attempt', 'run', 'sync_state', 'binding', 'node', 'node_rev', 'edge', 'unresolved', 'item',
                           'item_rev', 'chunk', 'ref', 'ref_link', 'link'] LOOP
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON brain.%I FOR EACH STATEMENT EXECUTE FUNCTION brain.refuse()', t);
  END LOOP;
END $$;

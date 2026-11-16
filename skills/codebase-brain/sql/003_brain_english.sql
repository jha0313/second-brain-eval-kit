-- 003: full-text search stems as SQLite FTS5 (porter unicode61) does. Postgres's english config drops stop words, so
-- a search made only of them ("further more same") found nothing on the server and the same chunk on a local index;
-- and its stemmer is Porter2 (Snowball english), which stems ~1 word in 7 of test/pg/fts.test.mjs's list otherwise
-- than FTS5's original Porter (general / generate: one stem in FTS5, two on the server). brain.brain_english is
-- english with one change: the word token types go to Snowball's original Porter stemmer, without a StopWords file.
-- chunk.tsv is computed again with it; the search query uses the same config (src/store/pg.mjs). Both objects live
-- in schema brain, so dropping the schema drops them too.
-- No row changes: a generated column added back is filled by the table rewrite, which fires no row trigger.

CREATE TEXT SEARCH DICTIONARY brain.porter_stem (TEMPLATE = snowball, Language = porter);
CREATE TEXT SEARCH CONFIGURATION brain.brain_english (COPY = pg_catalog.english);
ALTER TEXT SEARCH CONFIGURATION brain.brain_english
  ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH brain.porter_stem;

ALTER TABLE brain.chunk DROP COLUMN tsv;                -- drops chunk_tsv with it
ALTER TABLE brain.chunk ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('brain.brain_english'::regconfig, coalesce(title, '')), 'A') ||
  setweight(to_tsvector('brain.brain_english'::regconfig, coalesce(body, '')), 'B')) STORED;
CREATE INDEX chunk_tsv ON brain.chunk USING gin (tsv);

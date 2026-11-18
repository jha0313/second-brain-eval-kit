-- 003: server full-text search finds what SQLite FTS5 finds (src/db.mjs: tokenize = "porter unicode61 tokenchars '_'").
-- Postgres's english config differs in four ways, each changing which chunks a search finds:
-- 1. It drops stop words: a search made only of them ("further more same") found nothing on the server and the
--    chunk on a local index.
-- 2. Its stemmer is Porter2 (Snowball english), which stems 14 of the ~100 words of test/pg/fts.test.mjs's list
--    otherwise than FTS5's original Porter (general / generate: one stem in FTS5, two on the server). Snowball's
--    original Porter stemmer (brain.porter_stem) is used instead. After it takes -ed / -ing off, it undoubles only
--    b d f g m n p r t; FTS5 any consonant but l s z, a digit and '_' included (trekking: trek in FTS5, trekk in
--    Snowball), so brain.fts_text takes that step itself for the others before Snowball sees the word (when the stem
--    has a vowel: a e i o u, or a y after its first letter, which is Porter's rule for y).
-- 3. Its parser makes one token of a path (src/lib/credits.ts), a host (next.js), a number (12.34), splits foo_bar,
--    and keeps diacritics; unicode61 splits at every character but letters, digits and '_' and removes diacritics.
-- 4. It stems every word; FTS5's porter passes a token under 3 or over 64 bytes through ("ts" stemmed to "t" found
--    the t of "don't").
-- brain.fts_text does what FTS5 does, before Postgres's parser sees the text: unaccent, lower case, split at
-- [^[:alnum:]_]+, Porter (with that step) for a token of 3..64 bytes; then it encodes each stem so the parser keeps it whole
-- (q -> qq, '_' -> qz: injective, and after stemming, so it changes no stem). The vectors are built with the simple
-- config (no stop words, no stemming); the query side runs each term through the same function (src/store/pg.mjs).
-- unaccent: made in schema brain, or used where it already is (nothing goes in public; that schema must be usable by
-- brain_reader and brain_writer, as public is). Left as they are (docs/phase2-design.md §10): unaccent spells ß æ œ
-- and some symbols (© ™ ½) out in letters; rare Unicode (combining joiners, private-use characters, the byte length
-- of a folded letter) splits or measures otherwise; Postgres drops a lexeme over 2047 bytes; ranking. Every object
-- 003 makes lives in schema brain, so dropping the schema drops them too. No row changes: a generated column added
-- back is filled by the table rewrite, which fires no row trigger (it holds ACCESS EXCLUSIVE on brain.chunk while it
-- runs).

CREATE TEXT SEARCH DICTIONARY brain.porter_stem (TEMPLATE = snowball, Language = porter);

DO $$
DECLARE s name := (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'unaccent');
BEGIN
  IF s IS NULL THEN
    CREATE EXTENSION unaccent SCHEMA brain;
    s := 'brain';
  END IF;
  EXECUTE format($f$
    CREATE FUNCTION brain.fts_text(t text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    BEGIN ATOMIC
      SELECT coalesce(string_agg(replace(replace(
          CASE WHEN octet_length(w) BETWEEN 3 AND 64 THEN coalesce((ts_lexize('brain.porter_stem'::regdictionary,
            CASE WHEN w ~ E'([chjkqvwxy0-9_])\\1(ing|ed)s?$' AND regexp_replace(w, '(ing|ed)s?$', '') ~ '[aeiou]|.y'
              THEN regexp_replace(w, E'([chjkqvwxy0-9_])\\1(ing|ed)s?$', E'\\1') ELSE w END))[1], w) ELSE w END,
          'q', 'qq'), '_', 'qz'), ' ' ORDER BY i), '')
        FROM regexp_split_to_table(lower(%1$I.unaccent(%2$L::regdictionary, t)), '[^[:alnum:]_]+') WITH ORDINALITY AS x (w, i)
        WHERE w <> '';
    END$f$, s, format('%I.%I', s, 'unaccent'));
END $$;

ALTER TABLE brain.chunk DROP COLUMN tsv;                -- drops chunk_tsv with it
ALTER TABLE brain.chunk ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple'::regconfig, brain.fts_text(coalesce(title, ''))), 'A') ||
  setweight(to_tsvector('simple'::regconfig, brain.fts_text(coalesce(body, ''))), 'B')) STORED;
CREATE INDEX chunk_tsv ON brain.chunk USING gin (tsv);

-- 004: a trigram index on chunk.title. The trigram lists (src/store/pg.mjs chunks_tri, items_tri) match
-- `title ILIKE x OR body ILIKE x`; with chunk_body_trgm (001) alone, the title side made each Korean term a sequential
-- scan of brain.chunk (Q9: about 50 ms a term, 20-25 terms in a long question). No row changes. CREATE INDEX holds a
-- SHARE lock on brain.chunk while it builds: reads go on, a publish waits.

CREATE INDEX chunk_title_trgm ON brain.chunk USING gin (title public.gin_trgm_ops);

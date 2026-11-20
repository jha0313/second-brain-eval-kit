// Search ties (read.mjs rank, src/store/pg.mjs ranked): groups with one final score and one date. Each term has two
// syllables (a LIKE list on both stores, which order alike) and matches at most one GitHub item and one chunk, so every
// hit is first in its list and scores 1 / 61, and every row has the date D. PAGE is the order the logical keys give
// (common.mjs Candidate): commits by their whole SHA (both start abcdef12; no path, no lines), then docs by path bytes
// (B before a, the other way in a collation that folds case; ～ U+FF5E before 😀 U+1F600, the other way in UTF-16; 과일
// last), sections of one doc by start line, then end line, as numbers (2-9, 2-20, 10-11: as text 10 and 12 would come
// first, by end line alone 10-11 would), four sections with the same lines by title bytes (B, a, ～, 😀; their bodies
// the other way), three with the same lines and title by body bytes (B, ～, 😀: in UTF-16 😀 before ～, in a linguistic
// collation symbols before letters); then doc:z.md (by its source-qualified path: z.md alone would sort after the
// items), issue:10 before issue:9 (bytes), then pr:3, which only its children hit: it sorts by its own ptr, not theirs (ic:21
// would sort first), and shows the first three of its four children. Titles run against the commit and line order, so
// a key left out falls to content and fails; the rows are planted last to first, so ids run against PAGE too; and
// QUERY_BACK (the terms the other way) puts the lists, so first sightings, in the other order.
export const D = '2026-10-01T00:00:00Z';
const TERMS = ['포도', '딸기', '대추', '오이', '감자', '참외', '자두', '앵두', '수박', '사과', '살구', '모과', '호두', '양파', '마늘', '머루'];
export const QUERY = TERMS.join(' ');
export const QUERY_BACK = [...TERMS].reverse().join(' ');
const sha = (c) => `abcdef12${'0'.repeat(31)}${c}`;
const doc = (path, a, b, title, body) => ({ source: 'doc', path, a, b, title, body });

// in PAGE order
export const CHUNKS = [
  { source: 'commit', title: '포도 커밋', body: '포도 커밋', sha: sha(1) },
  { source: 'commit', title: '딸기 커밋', body: '딸기 커밋', sha: sha(2) },
  doc('docs/B.md', 1, 2, '하늘', '대추 한 알'),
  doc('docs/a/～.md', 1, 2, '물결', '오이 한 개'),
  doc('docs/a/😀.md', 1, 2, '웃음', '감자 한 알'),
  doc('docs/과일.md', 2, 9, '참외', '참외'),
  doc('docs/과일.md', 2, 20, '자두', '자두'),
  doc('docs/과일.md', 10, 11, '앵두', '앵두'),
  doc('docs/과일.md', 12, 13, 'B', '수박 한 통'),
  doc('docs/과일.md', 12, 13, 'a', '사과 한 봉지'),
  doc('docs/과일.md', 12, 13, '～', '살구 한 알'),
  doc('docs/과일.md', 12, 13, '😀', '모과 한 알'),
  doc('docs/과일.md', 14, 15, '과일', 'B 호두'),
  doc('docs/과일.md', 14, 15, '과일', '～ 양파'),
  doc('docs/과일.md', 14, 15, '과일', '😀 마늘'),
  doc('z.md', 1, 2, '끝', '머루 한 송이'),
];
// a doc with a date that is not ASCII: a search that finds it gets the server's lists, and it sorts first
export const FALLBACK = { query: `${QUERY} 호박`, chunk: { ...doc('docs/호박.md', 1, 2, '호박', '호박 한 개'), date: '\u{10000}' } };
// a vault note (local only) on its own term: vault:<path> sorts after every other group
export const VAULT = { query: `${QUERY} 고추`, chunk: { source: 'vault', path: 'vault:notes/메모.md', a: 1, b: 2, title: '메모', body: '고추 한 줌' } };

// [id, ptr, kind, parent / number, title, body]: planted in this order (ids run against PAGE and the children's order)
const ITEMS = [[500, 'pr:3', 'pr', 3, 'Fruit basket', 'none'], [501, 'review:24', 'review', 3, null, '참외'], [502, 'rc:23', 'review_comment', 3, null, '자두'],
  [503, 'ic:22', 'issue_comment', 3, null, '딸기'], [504, 'ic:21', 'issue_comment', 3, null, '수박'], [505, 'issue:9', 'issue', 9, 'Basket one', '사과'],
  [506, 'issue:10', 'issue', 10, 'Basket two', '포도']];

/** a search row as PAGE lists it: [ptr without its @build / @r<n>, title, snippet, matched] */
export const rowOf = (r) => [r.ptr.replace(/@(r\d+|[0-9a-z]{8})$/, ''), r.untrusted.title, r.untrusted.snippet, r.matched];
const chunkRow = (c) => [c.source === 'commit' ? `commit:${c.sha.slice(0, 8)}` : `${c.source}:${c.path.replace(/^vault:/, '')}:${c.a}-${c.b}`, c.title, c.body, []];
export const PAGE = [...CHUNKS.map(chunkRow), ['issue:10', 'Basket two', '포도', []], ['issue:9', 'Basket one', '사과', []],
  ['pr:3', 'Fruit basket', 'none', ['ic:21', 'ic:22', 'rc:23']]];
export const FALLBACK_ROW = chunkRow(FALLBACK.chunk);
export const VAULT_ROW = chunkRow(VAULT.chunk);
/** item ptrs and chunk bodies in PAGE order (and the children of pr:3 in their order): each one's id is lower than the one before */
export const ID_ORDER = { items: ['issue:10', 'issue:9', 'pr:3'], children: ['ic:21', 'ic:22', 'rc:23', 'review:24'], chunks: CHUNKS.map((c) => c.body) };
// the chunks a publish numbers by local id, as pairs (it numbers a doc's sections by start line first): commits, docs,
// sections with one start line (2-9, 2-20), those with the same lines
export const ID_PAIRS = [[0, 1], [2, 3], [3, 4], [5, 6], [8, 9, 10, 11], [12, 13, 14]].map((p) => p.map((i) => CHUNKS[i].body));

const sq = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
const insertChunk = (c) => `INSERT INTO chunks (source, path, start_line, end_line, title, body, sha, date)
  VALUES (${[c.source, c.path, c.a, c.b, c.title, c.body, c.sha, c.date ?? D].map(sq).join(', ')});`;
/** code.db SQL: CHUNKS last to first, then the extra chunks, then the FTS tables rebuilt */
export const codeSql = (extra = []) => [...[...CHUNKS].reverse(), ...extra].map(insertChunk).join('\n')
  + "\nINSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild'); INSERT INTO chunks_tri(chunks_tri) VALUES ('rebuild');";
/** github.db SQL: ITEMS in order, with their FTS rows */
export const ghSql = () => ITEMS.map(([id, ptr, kind, n, title, body]) => {
  const parent = kind !== 'pr' && kind !== 'issue';
  return `INSERT INTO items (id, ptr, kind, number, parent_number, review_id, state, title, body, url, path, line, created_at, updated_at, submitted_at)
    VALUES (${[id, ptr, kind, parent ? null : n, parent ? n : null, kind === 'review_comment' ? 24 : null, kind === 'review' ? 'COMMENTED' : parent ? null : 'open',
    title, body, `https://github.com/o/r/${kind === 'issue' ? 'issues' : 'pull'}/${n}#${ptr}`, kind === 'review_comment' ? 'src/lib/credits.ts' : null,
    kind === 'review_comment' ? 1 : null, D, D, kind === 'review' ? D : null].map(sq).join(', ')});
    INSERT INTO items_fts(rowid, title, body) VALUES (${id}, ${sq(title ?? '')}, ${sq(body)}); INSERT INTO items_tri(rowid, title, body) VALUES (${id}, ${sq(title ?? '')}, ${sq(body)});`;
}).join('\n');

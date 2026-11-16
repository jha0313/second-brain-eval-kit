// DTO -> text lines for search / get / source / sync (design §6.5 L3–L7, §6.7, §6.8). Lane E1 owns this file.
// Pure functions: no I/O, no color, no database. Every value under `untrusted` goes through ext() (quoted) or safe();
// every line starts with brain's own words (a pointer, a label, indentation before a quote), so nothing a person
// wrote can start a line or pass for the footer. Each answer ends with the two footer lines.
import { ext, safe, ident, cut, width, plural, COLS } from './fmt.mjs';
import { footer } from './answer.mjs';

const day = (iso) => (iso ? safe(iso).slice(0, 10) : '—');
const sha8 = (s) => safe(s ?? '').slice(0, 8);
// stored states closed_unmerged, CHANGES_REQUESTED -> closed-unmerged, changes-requested
const label = (state) => safe(state).toLowerCase().replace(/_/g, '-');
const who = (author, assoc) => (author ? `@${cut(safe(author), 24)}${assoc ? ` ${safe(assoc)}` : ''}` : '—');

const PTR_COL = 20;   // a pointer is never cut: a longer one (doc:…@build) goes whole on its own line under its row

/** @param {import('./read.mjs').SearchResult} res @param {{ coverage, freshness, now? }} ans @returns {string[]} */
export function renderSearch(res, ans, { cursor = 0, cols = COLS } = {}) {
  const lines = [];
  if (!res.rows.length) lines.push(`  no matches for ${ext(res.query, 80)}`);
  else {
    const head = ['#', 'POINTER', 'STATE', 'DATE', 'WHO'];
    const ptrs = res.rows.map((r) => ident(r.ptr));
    const cells = res.rows.map((r, i) => [String(cursor + i + 1), width(ptrs[i]) > PTR_COL ? '↓' : ptrs[i], r.state ? label(r.state) : '—', day(r.date), who(r.untrusted.author, r.assoc)]);
    const w = head.map((h, i) => Math.max(width(h), ...cells.map((r) => width(r[i]))));
    const lead = (row) => '  ' + row.map((v, i) => (i ? v + ' '.repeat(w[i] - width(v)) : ' '.repeat(w[i] - width(v)) + v)).join('  ') + '  ';
    const under = ' '.repeat(width(lead(head)));
    const room = Math.max(40, cols - under.length);
    lines.push(lead(head) + 'TITLE · SNIPPET');
    res.rows.forEach((r, i) => {
      const title = ext(r.untrusted.title, Math.min(room, 72));
      const rest = room - width(title) - 3;
      const snip = r.untrusted.snippet ? safe(r.untrusted.snippet) : '';
      lines.push(lead(cells[i]) + title + (snip && rest >= 24 ? ' · ' + ext(snip, Math.min(rest, 162)) : ''));
      if (cells[i][1] === '↓') lines.push('    ' + ptrs[i]);
      if (snip && rest < 24) lines.push(under + ext(snip, Math.min(room, 162)));
      if (r.matched?.length) lines.push(under + 'matched: ' + r.matched.slice(0, 3).map(safe).join(', '));
    });
    lines.push(`  rows ${cursor + 1}–${cursor + res.rows.length} · ${plural(res.total, 'hit')}` + (res.next != null ? ` · next: --cursor ${res.next}` : ''));
  }
  return [...lines, ...footer(ans)];
}

const KEY = 9;   // label column of a get block: "thread   "
const kv = (k, v) => `  ${k.padEnd(KEY)}${v}`;
const cont = (v) => ' '.repeat(2 + KEY) + v;

// parts joined by ' · ', wrapped to the width; every continuation line is indented under the label
function wrapped(k, parts, cols) {
  const room = cols - 2 - KEY, out = [];
  for (const p of parts) {
    if (out.length && width(out[out.length - 1] + ' · ' + p) <= room) out[out.length - 1] += ' · ' + p;
    else out.push(p);
  }
  return out.map((v, i) => (i ? cont(v) : kv(k, v)));
}

const range = (a, b) => (a && b && a !== b ? `${a}-${b}` : `${b ?? a ?? '?'}`);
function position(t) {
  const p = t.position, path = cut(safe(t.untrusted.path ?? '?'), 60);
  if (p.outdated) return `${path} outdated (was :${range(p.originalStart, p.originalEnd)}${p.originalCommit ? ` @${sha8(p.originalCommit)}` : ''})`;
  const side = p.startSide && p.side && p.startSide !== p.side ? `${safe(p.startSide)}→${safe(p.side)}` : safe(p.side ?? p.startSide ?? '');
  const tail = [side, p.commit ? `@${sha8(p.commit)}` : ''].filter(Boolean).join(', ');
  return `${path}:${range(p.start, p.end)}${tail ? ` (${tail})` : ''}`;
}

function threadLines(thread, cols) {
  if (!thread.length) return [kv('thread', 'none')];
  const rows = thread.map((t) => [(t.depth ? '  ' : '') + safe(t.ptr), who(t.untrusted.author, t.assoc),
    t.position ? position(t) : t.state ? safe(t.state) : '', day(t.date)]);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => width(r[i]))));
  return rows.map((r, i) => {
    const lead = r.map((v, j) => v + ' '.repeat(w[j] - width(v))).join('  ') + '  ';
    const text = lead + ext(thread[i].untrusted.firstLine, Math.max(30, cols - 2 - KEY - width(lead)));
    return i ? cont(text) : kv('thread', text);
  });
}

const LINKS = ['files', 'dirs', 'symbols', 'commits', 'items', 'routes', 'names'];
const LINKS_SHOWN = 10;
function linkPart(l) {
  const to = l.resolved?.length ? ` → ${l.resolved.slice(0, 3).map(ident).join(', ')}${l.resolved.length > 3 ? ', …' : ''}` : '';
  return `${ext(l.untrusted.target, 60)}${to} (${safe(l.status)}${l.reason ? `: ${safe(l.reason)}` : ''})`;
}

function headLine(it) {
  const u = it.untrusted, d = it.dates ?? {};
  const parts = [ident(it.ptr), it.state ? label(it.state) + (it.draft ? ' (draft)' : '') : safe(it.type)];
  if (u.title) parts.push(ext(u.title, 90));
  if (u.author) parts.push(`@${cut(safe(u.author), 24)}${it.assoc ? ` (${safe(it.assoc)})` : ''}`);
  if (it.origin === 'github') {
    if (d.created) parts.push(`${['pr', 'issue'].includes(it.type) ? 'opened' : 'created'} ${day(d.created)}`);
    if (d.submitted) parts.push(`submitted ${day(d.submitted)}`);
    if (d.merged) parts.push(`merged ${day(d.merged)}`);
    else if (d.closed) parts.push(`closed ${day(d.closed)}`);
  } else if (d.created || d.updated) parts.push(day(d.created ?? d.updated));
  return '  ' + parts.join(' · ');
}

function getBlock(it, cols) {
  const u = it.untrusted, lines = [headLine(it)];
  const thread = ['pr', 'issue'].includes(it.type) && it.origin === 'github';
  if (u.url || u.base || u.head) {
    const branches = u.base || u.head ? `base ${ext(u.base ?? '?', 40)} ← head ${ext(u.head ?? '?', 40)}` : '';
    lines.push(kv('url', [u.url ? cut(safe(u.url), 100) : '', branches].filter(Boolean).join(' · ')));
  }
  if (it.type === 'pr' && (it.merge?.commitPtr || it.merge?.sha)) lines.push(kv('merge', it.merge.commitPtr ? safe(it.merge.commitPtr) : sha8(it.merge.sha)));
  if (it.merge?.prPtr) lines.push(kv('merged', `in ${safe(it.merge.prPtr)}`));
  if (it.path) lines.push(kv('path', `${ident(it.path)}${it.lines ? `:${it.lines.a}-${it.lines.b}` : ''}`));
  if (u.firstLine) lines.push(kv('first', ext(u.firstLine, cols - 2 - KEY)));
  if (thread) {
    lines.push(...threadLines(it.thread ?? [], cols));
    if (it.type === 'pr') lines.push(cont(it.reviewsAt ? `reviews checked ${day(it.reviewsAt)}${it.state !== 'open' ? ' (closed PR: later review edits need --full)' : ''}` : 'reviews not fetched yet'));
  }
  for (const k of LINKS) {
    const list = it.links?.[k] ?? [];
    if (!list.length && !(k === 'routes' && thread)) continue;
    const parts = list.slice(0, LINKS_SHOWN).map(linkPart);
    if (list.length > LINKS_SHOWN) parts.push(`+${list.length - LINKS_SHOWN} more (--json)`);
    lines.push(...wrapped(k, parts.length ? parts : ['none'], cols));
    if (k === 'routes' && thread) lines.push(cont('extracted from URLs, code spans and paths of 2+ segments only'));
  }
  const flags = [...(it.flags ?? []).map(safe), ...(it.redactions ? [plural(it.redactions, 'redaction')] : [])];
  if (flags.length) lines.push(kv('flags', flags.join(' · ')));
  return lines;
}

/** @param {import('./read.mjs').GetResult} res @returns {string[]} one block per item, a blank line between, then the footer */
export function renderGet(res, ans, { cols = COLS } = {}) {
  const blocks = res.items.map((it) => getBlock(it, cols));
  return [...blocks.flatMap((b, i) => (i ? ['', ...b] : b)), ...footer(ans)];
}

/**
 * The quote envelope comes from read.envelope (lane E2); each of its lines is made one safe line again here, so a
 * line break inside a stored line can never open an unquoted line.
 * @param {import('./read.mjs').SourceResult} src @param {(src) => string[]} envelope
 */
export function renderSource(src, ans, envelope) {
  return [...envelope(src).map(safe), ...footer(ans)];
}

function relinkPart(x) {
  if (!x) return '';
  if (x.error) return ` · relink failed (${ext(x.error, 80)})`;
  return ` · relink: ${x.linked ?? 0} linked, ${x.ambiguous ?? 0} ambiguous, ${x.unlinked ?? 0} unlinked, ${x.pending ?? 0} pending`;
}

/** @param {import('./gh-sync.mjs').SyncResult} r @returns {string} the one summary line (the footer follows it) */
export function renderSync(r) {
  if (r.status === 'busy') return `brain sync: busy${r.error ? ` (${ext(r.error, 100)})` : ''} — another brain write holds the lock; run it again when that ends`;
  const c = r.counts ?? {};
  const n = [plural(c.prs ?? 0, 'PR'), plural(c.issues ?? 0, 'issue'), plural(c.reviews ?? 0, 'review'), plural(c.reviewComments ?? 0, 'review comment'),
    plural(c.issueComments ?? 0, 'issue comment'), plural(c.files ?? 0, 'file'), plural(c.requests ?? 0, 'request')].join(' · ');
  const lock = r.staleLock ? ' · cleared a stale lock (the previous run died)' : '';
  if (r.status === 'ok') return `brain sync: ok · ${n} · data as of ${safe(r.cursor ?? '?')}${relinkPart(r.relink)}${lock}`;
  return `brain sync: FAILED ${ext(r.error ?? 'unknown error', 120)} · cursor unchanged (${r.cursor ? `data as of ${safe(r.cursor)}` : 'no complete sync yet'})`
    + ` · stored before the failure: ${n}${relinkPart(r.relink)}${lock}`;
}

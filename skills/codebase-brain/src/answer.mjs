// Every answer ends with coverage + freshness (design §6.8). Lane E1 owns this file.
import { freshness as codeFreshness } from './query.mjs';
import { git } from './files.mjs';
import { SANITIZE_VERSION } from './sanitize.mjs';
import { GuardError } from './errors.mjs';
import { ext, plural } from './fmt.mjs';

/**
 * @typedef {{ state: 'complete'|'truncated'|'partial', reasons: string[] }} Coverage
 * @typedef {{
 *   code: { state: 'fresh'|'stale'|'unknown', commit: string|null, head: string|null, behind: number|null, diverged: boolean, changed: number, files: string[] },
 *   github: { state: 'never'|'ok'|'stale'|'failed'|'interrupted'|'running', asOf: string|null, syncedAt: string|null, fullAt: string|null,
 *             runAt: string|null, pid: number|null, error: string|null }
 * }} Freshness
 * @typedef {{ truncated?: boolean, unresolvedLocal?: number, lines?: { from: number, to: number, total: number } } & Partial<import('./read.mjs').ReadFacts>} CoverageFacts
 *   githubPresent (ReadFacts) marks an answer that reads GitHub memory: only then does the sync state count.
 *   lines: the page `source` printed.
 */

const DAY = 24 * 3600e3;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// sync_state -> one state. A 'running' row whose pid is gone is a run that died (the next sync marks it interrupted)
function githubState(s, now) {
  if (!s) return 'never';
  if (s.run_status === 'running') return s.run_pid && alive(s.run_pid) ? 'running' : 'interrupted';
  if (s.run_status === 'failed' || s.run_status === 'interrupted') return s.run_status;
  if (!s.cursor) return 'never';
  return now - Date.parse(s.last_ok_at ?? s.cursor) > DAY ? 'stale' : 'ok';
}

/** Precedence partial > truncated > complete; reasons list every fact that applies. @param {import('./context.mjs').Ctx} ctx @param {CoverageFacts} facts @returns {Coverage} */
export function coverage(ctx, facts = {}) {
  const partial = [], cut = [];
  if (facts.githubPresent !== undefined) {
    const s = ctx.sync;
    const g = githubState(s, Date.now());
    if (g === 'failed' || g === 'interrupted') partial.push(`last github sync ${g}`);
    else if (!s?.cursor) partial.push('github not synced');
  }
  // a --path query matches refs.target strings: a PR whose file list was cut, or refs not resolved yet, may be missing
  if (facts.pathQuery && facts.filesTruncated) partial.push(`${facts.filesTruncated} PRs have >3000 files`);
  if (facts.pathQuery && facts.pathRefsPending) partial.push(`${facts.pathRefsPending} refs not linked yet`);
  if (facts.unresolvedLocal) partial.push(plural(facts.unresolvedLocal, 'unresolved local import'));
  for (const l of facts.truncatedLists ?? []) cut.push(`candidate cap hit (${l})`);
  const l = facts.lines;
  if (l) cut.push(l.total ? `lines ${l.from}–${l.to} of ${l.total}${l.to < l.total ? ` · next: --from ${l.to + 1}` : ''}` : 'empty text');
  const truncated = facts.truncated || (facts.truncatedLists ?? []).length > 0 || (l && l.to < l.total);
  return { state: partial.length ? 'partial' : truncated ? 'truncated' : 'complete', reasons: [...partial, ...cut] };
}

// the code part: Phase 0 freshness (query.mjs) plus commits behind / diverged
function codePart(ctx, f) {
  if (!ctx.code) return { state: 'unknown', commit: null, head: null, behind: null, diverged: false, changed: 0, files: [] };
  f ??= codeFreshness(ctx.code, ctx.checkout);
  let behind = null, diverged = false;
  if (f.head && f.commit && f.head !== f.commit) {
    try {
      git(f.repo, ['merge-base', '--is-ancestor', f.commit, f.head]);
      behind = Number(git(f.repo, ['rev-list', '--count', `${f.commit}..${f.head}`]).trim());
    } catch (e) { diverged = e.status === 1; }   // 1 = not an ancestor; anything else: we do not know
  }
  return { state: f.state, commit: f.commit, head: f.head, behind, diverged, changed: f.changed.length, files: f.changed.slice(0, 20) };
}

/**
 * @param {import('./context.mjs').Ctx} ctx
 * @param {{ now?: number, phase0?: ReturnType<typeof codeFreshness> }} [opts] phase0: a query.mjs freshness already computed for ctx
 * @returns {Freshness}
 */
export function freshness(ctx, { now = Date.now(), phase0 } = {}) {
  const s = ctx.sync;
  const state = githubState(s, now);
  return {
    code: codePart(ctx, phase0),
    github: { state, asOf: s?.cursor ?? null, syncedAt: s?.last_ok_at ?? null, fullAt: s?.last_full_at ?? null,
      runAt: s?.run_started_at ?? null, pid: s?.run_pid ?? null, error: ['failed', 'interrupted'].includes(state) ? s?.last_error ?? null : null },
  };
}

const at = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z` : '?');
function age(iso, now) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (Number.isNaN(m)) return '?';
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

function codeLine(c) {
  const a = c.commit ? `code @${c.commit.slice(0, 8)}` : 'code: no index';
  if (!c.commit) return a;
  if (c.state === 'fresh') return `${a} = HEAD (up to date)`;
  const changed = c.changed ? ` · ${plural(c.changed, 'file')} changed` : '';
  if (!c.head) return `${a} · HEAD unknown`;
  if (c.head === c.commit) return `${a} = HEAD${changed}`;
  const rel = c.diverged ? ' · diverged' : c.behind != null ? ` · ${plural(c.behind, 'commit')} behind` : '';
  return `${a} · HEAD @${c.head.slice(0, 8)}${rel}${changed}`;
}

function githubLine(g, now) {
  const asOf = g.asOf ? `data as of ${at(g.asOf)}` : 'no complete sync yet';
  const full = `full sync ${g.fullAt ? `${age(g.fullAt, now)} ago` : 'never'}`;
  switch (g.state) {
    case 'never': return 'github never synced';
    case 'ok': return `github data as of ${at(g.asOf)} (synced ${age(g.syncedAt ?? g.asOf, now)} ago, ok · ${full})`;
    case 'stale': return `github data as of ${at(g.asOf)} (${age(g.syncedAt ?? g.asOf, now)} old, stale: run brain sync · ${full})`;
    case 'failed': return `last github sync FAILED ${g.runAt ? `${age(g.runAt, now)} ago ` : ''}${g.error ? `(${ext(g.error, 80)}) ` : ''}· ${asOf}`;
    case 'interrupted': return `last github sync interrupted · ${asOf}`;
    default: return `github sync running${g.pid ? ` (pid ${g.pid})` : ''} · ${asOf}`;
  }
}

/** @param {{ coverage: Coverage, freshness: Freshness, now?: number }} a @returns {[string, string]} plain text, no color */
export function footer({ coverage: cov, freshness: fr, now = Date.now() }) {
  const c = cov.state + (cov.reasons.length ? ` · ${cov.reasons.join(' · ')}` : '');
  return [`  coverage: ${c}`, `  freshness: ${codeLine(fr.code)} · ${githubLine(fr.github, now)}`];
}

/**
 * Refuse to show stored content written before the current sanitizer.
 * code: meta.sanitize_version. github: sync_state.sanitize_version, once the store holds a sync (a cursor) or says
 * which version wrote it.
 * @param {import('./context.mjs').Ctx} ctx @throws {GuardError}
 */
export function guard(ctx) {
  const have = Number(ctx.meta.sanitize_version ?? -1);
  if (have < SANITIZE_VERSION) throw new GuardError('code', have, SANITIZE_VERSION);
  const s = ctx.sync;
  if (s && (s.cursor || s.sanitize_version != null) && Number(s.sanitize_version ?? -1) < SANITIZE_VERSION) throw new GuardError('github', s.sanitize_version ?? -1, SANITIZE_VERSION);
}

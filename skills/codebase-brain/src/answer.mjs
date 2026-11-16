// Every answer ends with coverage + freshness (design §6.8). Lane E1 owns this file.
// P0 STUB: complete coverage, code freshness from Phase 0, github "never synced"/"as of", guard checks versions.
import { freshness as codeFreshness } from './query.mjs';
import { SANITIZE_VERSION } from './sanitize.mjs';
import { GuardError } from './errors.mjs';

/**
 * @typedef {{ state: 'complete'|'truncated'|'partial', reasons: string[] }} Coverage
 * @typedef {{
 *   code: { state: 'fresh'|'stale'|'unknown', commit: string|null, head: string|null, behind: number|null, diverged: boolean, changed: number, files: string[] },
 *   github: { state: 'never'|'ok'|'stale'|'failed'|'interrupted'|'running', asOf: string|null, syncedAt: string|null, fullAt: string|null, error: string|null }
 * }} Freshness
 * @typedef {{ truncated?: boolean, unresolvedLocal?: number } & Partial<import('./read.mjs').ReadFacts>} CoverageFacts
 */

/** @param {import('./context.mjs').Ctx} ctx @param {CoverageFacts} facts @returns {Coverage} */
export function coverage(_ctx, facts = {}) {
  return { state: facts.truncated ? 'truncated' : 'complete', reasons: [] };
}

/** @param {import('./context.mjs').Ctx} ctx @returns {Freshness} */
export function freshness(ctx) {
  const f = codeFreshness(ctx.code, ctx.checkout);
  const s = ctx.sync;
  return {
    code: { state: f.state, commit: f.commit, head: f.head, behind: null, diverged: false, changed: f.changed.length, files: f.changed.slice(0, 20) },
    github: s?.cursor ? { state: 'ok', asOf: s.cursor, syncedAt: s.last_ok_at, fullAt: s.last_full_at, error: null }
      : { state: 'never', asOf: null, syncedAt: null, fullAt: null, error: null },
  };
}

/** @param {{ coverage: Coverage, freshness: Freshness }} a @returns {[string, string]} plain text, no color */
export function footer({ coverage: cov, freshness: fr }) {
  const c = cov.state + (cov.reasons.length ? ` · ${cov.reasons.join(' · ')}` : '');
  const code = fr.code.state === 'fresh' ? `code @${fr.code.commit?.slice(0, 8)} = HEAD (up to date)` : `code @${fr.code.commit?.slice(0, 8)} · HEAD @${fr.code.head?.slice(0, 8) ?? '?'}`;
  const gh = fr.github.state === 'never' ? 'github never synced' : `github data as of ${fr.github.asOf}`;
  return [`  coverage: ${c}`, `  freshness: ${code} · ${gh}`];
}

/**
 * Refuse to show stored content written before the current sanitizer.
 * @param {import('./context.mjs').Ctx} ctx @throws {GuardError}
 */
export function guard(ctx) {
  const have = Number(ctx.meta.sanitize_version ?? -1);
  if (have < SANITIZE_VERSION) throw new GuardError('code', have, SANITIZE_VERSION);
  if (ctx.sync && ctx.sync.cursor && Number(ctx.sync.sanitize_version ?? -1) < SANITIZE_VERSION) throw new GuardError('github', ctx.sync.sanitize_version ?? -1, SANITIZE_VERSION);
}

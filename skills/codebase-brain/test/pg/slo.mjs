// SLO meter (Phase 3 S6, design §7.1 T1–T4). Per-stage times come from ci-publish's stage events; the wait and the total
// come from the Actions run (created_at -> run_started_at) and the brain attempt / run rows (started_at, finished_at,
// published_at). Pure: callers fetch the logs and rows (S7 does that against the sandbox).
//   stage event, one line each, as ci-publish prints it (an Actions log line may carry a timestamp prefix):
//     brain-stage <stage> <start|ok|fail|skipped> <ISO time>
//   node test/pg/slo.mjs <runs.json>   runs.json: [{ createdAt, startedAt, publishedAt|null, log }] -> a table on stdout
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CI_STAGES } from '../../src/pg/contract.mjs';

export const SLO_MS = 10 * 60_000;                                   // T1: trigger -> published, p95
const EVENTS = ['start', 'ok', 'fail', 'skipped'];
const LINE = new RegExp(`(?:^|\\s)brain-stage (${CI_STAGES.join('|')}) (${EVENTS.join('|')}) (\\S+)\\s*$`);

/** The line ci-publish prints at a stage boundary. */
export const stageLine = (stage, event, at = new Date()) => `brain-stage ${stage} ${event} ${at.toISOString()}`;

/**
 * @param {string} text a job log @returns {{ stage: string, ms: number|null, outcome: 'ok'|'fail'|'skipped'|'open' }[]}
 *   in start order; ms null and outcome 'open' for a stage that started and never ended (a killed job)
 */
export function parseStages(text) {
  const out = [], open = new Map();
  for (const line of String(text).split('\n')) {
    const m = LINE.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const [, stage, event, at] = m, t = Date.parse(at);
    if (Number.isNaN(t)) continue;
    if (event === 'start') { const s = { stage, ms: null, outcome: 'open', t }; open.set(stage, s); out.push(s); continue; }
    const s = open.get(stage);
    if (!s) continue;
    open.delete(stage);
    Object.assign(s, { ms: t - s.t, outcome: event });
  }
  return out.map(({ t, ...s }) => s);
}

/**
 * @param {number[]} xs Infinity = never reached (a run that did not publish); NaN = no data, left out
 * @returns {{ n: number, p50: number|null, p95: number|null, max: number|null }} nearest-rank
 */
export function summarize(xs) {
  const v = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  const rank = (p) => (v.length ? v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)] : null);
  return { n: v.length, p50: rank(0.5), p95: rank(0.95), max: v.length ? v.at(-1) : null };
}

/**
 * T1 counts every dispatch: a run that published nothing (failed, cancelled) is a miss, so its run and total time are
 * Infinity and it counts as over the SLO.
 * @param {{ createdAt: string, startedAt: string, publishedAt: string|null, log: string }[]} runs
 *   createdAt / startedAt: the Actions run's created_at / run_started_at (wait = queue + concurrency); publishedAt: brain
 *   run.published_at (null: the run published nothing)
 * @returns {{ wait, run, total, over: number, published: number, unpublished: number,
 *   stages: Record<string, ReturnType<typeof summarize>> }}
 */
export function report(runs) {
  const ms = (a, b) => (!a ? NaN : !b ? Infinity : Date.parse(b) - Date.parse(a));
  const stages = Object.fromEntries(CI_STAGES.map((s) => [s, summarize(runs.flatMap((r) => parseStages(r.log).filter((x) => x.stage === s && x.outcome === 'ok').map((x) => x.ms)))]));
  const total = runs.map((r) => ms(r.createdAt, r.publishedAt));
  return {
    wait: summarize(runs.map((r) => (r.startedAt ? ms(r.createdAt, r.startedAt) : NaN))),
    run: summarize(runs.map((r) => ms(r.startedAt, r.publishedAt))),
    total: summarize(total),
    over: total.filter((x) => x > SLO_MS).length,
    published: runs.filter((r) => r.publishedAt).length,
    unpublished: runs.filter((r) => !r.publishedAt).length,
    stages,
  };
}

/** @returns {string} the report as a table (seconds) */
export function table(r) {
  const s = (x) => (x === null ? '-' : x === Infinity ? 'never' : (x / 1000).toFixed(1));
  const row = (name, x) => `${name.padEnd(10)} ${String(x.n).padStart(3)} ${s(x.p50).padStart(8)} ${s(x.p95).padStart(8)} ${s(x.max).padStart(8)}`;
  return [`${'stage'.padEnd(10)} ${'n'.padStart(3)} ${'p50 s'.padStart(8)} ${'p95 s'.padStart(8)} ${'max s'.padStart(8)}`,
    row('wait', r.wait), ...CI_STAGES.filter((k) => r.stages[k].n).map((k) => row(k, r.stages[k])), row('run', r.run), row('total', r.total),
    `published ${r.published}, unpublished ${r.unpublished}, over ${SLO_MS / 60_000} min (unpublished included): ${r.over}, `
      + `p95 total ${r.total.p95 !== null && r.total.p95 <= SLO_MS ? 'meets' : 'misses'} the SLO`].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('usage: node test/pg/slo.mjs <runs.json>'); process.exit(2); }
  console.log(table(report(JSON.parse(readFileSync(process.argv[2], 'utf8')))));
}

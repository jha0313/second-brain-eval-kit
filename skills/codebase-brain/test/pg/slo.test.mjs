// S6: the SLO meter (test/pg/slo.mjs). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStages, report, stageLine, summarize, table } from './slo.mjs';

const at = (s) => new Date(Date.parse('2026-11-16T10:00:00Z') + s * 1000);
const log = (pairs) => pairs.map(([stage, ev, s]) => `2026-11-16T10:00:00.0000000Z ${stageLine(stage, ev, at(s))}`).join('\n');

test('stage events: timestamps prefixed, an unfinished stage stays open, other lines are ignored', () => {
  const text = `noise\n${log([['record', 'start', 0], ['record', 'ok', 2], ['build', 'start', 2], ['build', 'fail', 50], ['sync', 'start', 50]])}\nbrain-stage nope ok x`;
  assert.deepEqual(parseStages(text), [{ stage: 'record', ms: 2000, outcome: 'ok' }, { stage: 'build', ms: 48000, outcome: 'fail' },
    { stage: 'sync', ms: null, outcome: 'open' }]);
});

test('summarize: nearest-rank p50 / p95 / max; empty is null', () => {
  assert.deepEqual(summarize([5, 1, 4, 2, 3]), { n: 5, p50: 3, p95: 5, max: 5 });
  assert.deepEqual(summarize([]), { n: 0, p50: null, p95: null, max: null });
});

const t = (s) => at(s).toISOString();

test('report: wait and run apart, per-stage table, an unpublished run is a miss (never, over the SLO)', () => {
  const runs = [
    { createdAt: t(0), startedAt: t(30), publishedAt: t(300), log: log([['build', 'start', 40], ['build', 'ok', 160]]) },
    { createdAt: t(0), startedAt: t(60), publishedAt: t(700), log: log([['build', 'start', 70], ['build', 'ok', 250]]) },
    { createdAt: t(0), startedAt: t(10), publishedAt: null, log: log([['build', 'start', 20], ['build', 'fail', 30]]) },
  ];
  const r = report(runs);
  assert.deepEqual(r.wait, { n: 3, p50: 30000, p95: 60000, max: 60000 });
  assert.deepEqual(r.total, { n: 3, p50: 700000, p95: Infinity, max: Infinity });
  assert.deepEqual([r.over, r.published, r.unpublished], [2, 2, 1]);
  assert.deepEqual(r.stages.build, { n: 2, p50: 120000, p95: 180000, max: 180000 });
  assert.match(table(r), /^total +3 +700\.0 +never +never$/m);
  assert.match(table(r), /unpublished 1, over 10 min \(unpublished included\): 2, p95 total misses the SLO/);
});

test('report: 19 failed dispatches and one fast publish miss the SLO; 20 fast publishes meet it', () => {
  const fast = { createdAt: t(0), startedAt: t(5), publishedAt: t(120), log: '' };
  const failed = { createdAt: t(0), startedAt: t(5), publishedAt: null, log: '' };
  assert.match(table(report([fast, ...Array(19).fill(failed)])), /p95 total misses the SLO/);
  assert.match(table(report(Array(20).fill(fast))), /unpublished 0, over 10 min \(unpublished included\): 0, p95 total meets the SLO/);
  assert.match(table(report([])), /p95 total misses the SLO/);
});

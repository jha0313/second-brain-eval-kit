// Shared test helpers (P0). Lanes may add helpers inside their own test files; this file changes only via the lead.
import { cpSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGithubDb, githubDbPath, writeSyncState } from '../../src/gh-schema.mjs';
import { SANITIZE_VERSION } from '../../src/sanitize.mjs';
export { virtualClock as fakeClock } from '../../src/replay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const BRAIN = join(here, '..', '..', 'bin', 'brain');
export const FIXTURE = join(here, '..', 'fixture');

/** Run bin/brain. @returns {{ stdout: string, stderr: string, status: number }} */
export function runBrain(args, { cwd, env = {} } = {}) {
  const r = spawnSync(BRAIN, args, { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/**
 * The Phase 0 fixture as a fresh git repo, built. extraFiles: { 'docs/x.md': 'text' } written before the commit.
 * @returns {{ repo: string, codeDb: string, ghDb: string, brain: (args: string[], env?: object) => { stdout: string, stderr: string, status: number } }}
 */
export function fixtureRepo({ extraFiles = {}, build = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'brain-p1-'));
  cpSync(FIXTURE, repo, { recursive: true });
  for (const [rel, text] of Object.entries(extraFiles)) {
    execFileSync('mkdir', ['-p', dirname(join(repo, rel))]);
    execFileSync('/bin/sh', ['-c', 'cat > "$1"', 'sh', join(repo, rel)], { input: text });
  }
  const sh = (cmd, args) => execFileSync(cmd, args, { cwd: repo, encoding: 'utf8' });
  sh('git', ['init', '-q']);
  sh('git', ['add', '-A', '-f']);
  sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture: reserve credits first (#12)']);
  const codeDb = join(repo, '..', `${repo.split('/').pop()}.db`);
  const brain = (args, env = {}) => runBrain(args, { cwd: repo, env: { BRAIN_DB: codeDb, ...env } });
  if (build) {
    const r = brain(['build', '.', '--db', codeDb]);
    if (r.status !== 0) throw new Error(`fixture build failed: ${r.stderr}`);
  }
  return { repo, codeDb, ghDb: githubDbPath(codeDb), brain };
}

/** A complete items row with defaults; override any column. */
export function ghItem(over = {}) {
  const kind = over.kind ?? 'pr';
  const n = over.number ?? 1121;
  return {
    ptr: over.ptr ?? `${{ pr: 'pr', issue: 'issue', review: 'review', review_comment: 'rc', issue_comment: 'ic' }[kind]}:${over.id ?? n}`,
    kind, number: ['pr', 'issue'].includes(kind) ? n : null, parent_number: ['pr', 'issue'].includes(kind) ? null : n,
    review_id: null, in_reply_to: null, state: kind === 'pr' ? 'closed_unmerged' : kind === 'issue' ? 'open' : null, draft: 0,
    author: 'carol', author_assoc: 'CONTRIBUTOR', title: kind === 'pr' || kind === 'issue' ? 'Charge after run' : null,
    body: 'settle at the end, simpler', url: `https://github.com/o/r/pull/${n}`,
    created_at: '2026-09-10T10:00:00Z', updated_at: '2026-09-12T10:00:00Z', submitted_at: null, closed_at: null, merged_at: null,
    merge_sha: null, base: 'main', head: 'carol/charge-after', detail_for: null, reviews_at: null,
    path: null, side: null, start_side: null, start_line: null, line: null, original_start_line: null, original_line: null,
    commit_id: null, original_commit_id: null, redactions: 0, flags: '',
    ...over,
  };
}

/**
 * A hand-made github.db next to codeDbPath (raw inserts: no sync policy, no sanitizing — tests choose the data).
 * @param {string} codeDbPath
 * @param {{ items?: object[], refs?: object[], syncState?: object }} data
 */
export function makeGithubDb(codeDbPath, { items = [], refs = [], syncState = {} } = {}) {
  const path = githubDbPath(codeDbPath);
  const db = openGithubDb(path, { create: true });
  db.exec('BEGIN');
  for (const it of items.map(ghItem)) {
    const cols = Object.keys(it);
    const r = db.prepare(`INSERT INTO items(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((k) => it[k]));
    const id = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO items_fts(rowid, title, body) VALUES (?, ?, ?)').run(id, it.title ?? '', it.body ?? '');
    db.prepare('INSERT INTO items_tri(rowid, title, body) VALUES (?, ?, ?)').run(id, it.title ?? '', it.body ?? '');
  }
  for (const rf of refs) {
    db.prepare('INSERT INTO refs(ptr, kind, target, origin, status, reason, resolved, resolved_build) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(rf.ptr, rf.kind, rf.target, rf.origin ?? 'text', rf.status ?? 'pending', rf.reason ?? null,
        rf.resolved ? JSON.stringify(rf.resolved) : null, rf.resolved_build ?? null);
  }
  writeSyncState(db, { repo_id: 1, repo: 'o/r', cursor: '2026-11-15T09:58:00Z', last_ok_at: '2026-11-15T10:01:00Z', run_status: 'ok', sanitize_version: SANITIZE_VERSION, ...syncState });
  db.exec('COMMIT');
  db.close();
  return path;
}

/**
 * A child process that takes the write lock of codeDbPath (withWriteLock) and waits. Resolves once it holds it;
 * stop it with child.kill() (SIGKILL: the OS drops its lock, the holder row stays unclean).
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
export function holdLockInChild(codeDbPath) {
  const mod = new URL('../../src/gh-schema.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `import { withWriteLock } from ${JSON.stringify(mod)};
     await withWriteLock(process.argv[1], async () => { process.stdout.write('held\\n'); await new Promise(() => setInterval(() => {}, 1000)); });`, codeDbPath]);
  return new Promise((res, rej) => {
    child.stdout.on('data', (d) => { if (String(d).includes('held')) res(child); });
    child.on('exit', (c) => rej(new Error(`lock child exited ${c}`)));
  });
}

/** Kill a holdLockInChild child and wait for it to exit. */
export async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((r) => child.on('exit', r));
  child.kill('SIGKILL');
  await gone;
}

/**
 * The write lock as another process sees it, read without taking it (gh-schema.mjs withWriteLock):
 * 'none' (never taken), 'held' (a live holder), 'clean' (released normally), 'dirty' (the last holder died).
 * Also: no `.lock.pid` may be left once the lock is free.
 */
export function lockState(codeDbPath) {
  const lock = `${codeDbPath}.lock`;
  if (!existsSync(lock)) return 'none';
  const db = new DatabaseSync(lock, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 0');
    const row = db.prepare('SELECT clean FROM holder WHERE id = 1').get();
    if (!row) return 'none';
    return row.clean ? 'clean' : 'dirty';
  } catch (e) {
    if (e.errcode === 5 || e.errcode === 6) return 'held';
    throw e;
  } finally { db.close(); }
}

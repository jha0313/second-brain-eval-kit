// Which files exist at the indexed commit, and what role each one plays.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const CPP_EXT = /\.(h|hh|hpp|hxx|c|cc|cpp|cxx|ipp|tcc)$/;
export const PY_EXT = /\.py$/;
const SKIP_DIR = /(^|\/)(node_modules|\.next|dist|build|out|coverage|\.git|vendor|third[-_]party)\//;

export function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, ...opts });
}

// Tracked files only: the index describes a commit, not the working tree.
// Symlinks (AGENTS.md -> CLAUDE.md) are skipped so one text is never indexed or cited twice.
export function trackedFiles(repo) {
  return git(repo, ['ls-files', '-z']).split('\0')
    .filter((p) => p && !SKIP_DIR.test(p) && existsSync(join(repo, p)) && !lstatSync(join(repo, p)).isSymbolicLink());
}

export function headCommit(repo) {
  try { return git(repo, ['rev-parse', 'HEAD']).trim(); } catch { return null; }
}

// Tracked files with uncommitted edits. The build reads the working tree, so it records their content
// hashes: an edit the index already holds is not "changed since the index".
export function dirtyFiles(repo) {
  return git(repo, ['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, ''));                // "R  old -> new": the new path
}

export function contentHashes(repo, paths) {
  const live = paths.filter((p) => existsSync(join(repo, p)));
  const hashes = live.length ? git(repo, ['hash-object', '--', ...live]).trim().split('\n') : [];
  return Object.fromEntries(paths.map((p) => [p, live.includes(p) ? hashes[live.indexOf(p)] : 'deleted']));
}

// Roles an agent filters by: "every server action that…", "every page that…", "…excluding tests".
export function fileFlags(path, head) {
  const f = [];
  if (/(^|\/)(__tests__|e2e|tests?)\/|\.(test|spec)\.[a-z]+$|(^|\/)test-utils?\//.test(path)) f.push('test');
  if (/(^|\/)app\/(.*\/)?page\.[jt]sx?$/.test(path)) f.push('page');
  if (/(^|\/)app\/(.*\/)?route\.[jt]sx?$/.test(path)) f.push('route');
  if (/(^|\/)app\/(.*\/)?layout\.[jt]sx?$/.test(path)) f.push('layout');
  if (/^scripts\//.test(path)) f.push('script');
  if (/\.generated\.|\.gen\.|(^|\/)generated\//.test(path) || /@generated|auto-?generated|do not edit/i.test(head.slice(0, 400))) f.push('generated');
  const directive = head.match(/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*['"]use (server|client)['"]/);
  if (directive) f.push(directive[1] === 'server' ? 'server-action' : 'client');
  return f.join(' ');
}

export function readHead(abs, n = 600) {
  try { return readFileSync(abs, 'utf8').slice(0, n); } catch { return ''; }
}

// Non-ASCII paths: a commit that touches such a file links to it. Paths git still quotes (control characters, '"')
// get no link but cannot break the commit records. A map command without its target is a usage error, not a TypeError.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixtureRepo } from './helpers.mjs';

test('a commit touching a non-ASCII path links to that file; odd paths do not break the commit records', () => {
  const { repo, codeDb, brain } = fixtureRepo({ build: false, extraFiles: { 'src/결제.ts': 'export const pay = 1;\n',
    'src/a"b.ts': 'export const ab = 2;\n', 'src/a\x1eb.ts': 'export const rs = 3;\n', 'src/a\x1fb.ts': 'export const us = 4;\n',
    'src/x.ts': 'export const x = 5;\n', ' src/x.ts': 'export const sp = 6;\n' } });
  writeFileSync(join(repo, ' src/x.ts'), 'export const sp = 7;\n');          // a second commit touches only ' src/x.ts'
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'space path'], { cwd: repo });
  assert.equal(brain(['build', '.', '--db', codeDb]).status, 0);
  const db = new DatabaseSync(codeDb, { readOnly: true });
  const touched = (path) => db.prepare(`SELECT count(*) AS n FROM links l JOIN nodes n ON n.id = l.node JOIN chunks c ON c.id = l.chunk
    WHERE l.kind = 'touches' AND c.source = 'commit' AND n.path = ?`).get(path).n;
  assert.equal(touched('src/결제.ts'), 1);
  assert.equal(touched(' src/x.ts'), 2, 'a leading space is part of the path');
  assert.equal(touched('src/x.ts'), 1, 'the second commit does not link the trimmed name');
  const commits = db.prepare(`SELECT count(*) AS n FROM chunks WHERE source = 'commit'`).get().n;
  assert.equal(commits, 2, 'two commits, two records: no path split one');
  db.close();
});

test('a map command without its target is a usage error, not a TypeError', () => {
  const { brain } = fixtureRepo();
  for (const args of [['shared', 'src'], ['refs'], ['impact', '']]) {
    const r = brain(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stdout, /^brain error \(usage\): give a target/, args.join(' '));
  }
});

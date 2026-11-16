// Non-ASCII paths: a commit that touches such a file links to it. Paths git still quotes (control characters, '"')
// get no link but cannot break the commit records. A map command without its target is a usage error, not a TypeError.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixtureRepo } from './helpers.mjs';

test('a commit touching a non-ASCII path links to that file; odd paths do not break the commit records', () => {
  const { codeDb } = fixtureRepo({ extraFiles: { 'src/결제.ts': 'export const pay = 1;\n', 'src/a"b.ts': 'export const ab = 2;\n',
    'src/a\x1eb.ts': 'export const rs = 3;\n', 'src/a\x1fb.ts': 'export const us = 4;\n' } });
  const db = new DatabaseSync(codeDb, { readOnly: true });
  const touched = (path) => db.prepare(`SELECT count(*) AS n FROM links l JOIN nodes n ON n.id = l.node JOIN chunks c ON c.id = l.chunk
    WHERE l.kind = 'touches' AND c.source = 'commit' AND n.path = ?`).get(path).n;
  assert.equal(touched('src/결제.ts'), 1);
  const commits = db.prepare(`SELECT count(*) AS n FROM chunks WHERE source = 'commit'`).get().n;
  assert.equal(commits, 1, 'one commit, one record: no path split it');
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

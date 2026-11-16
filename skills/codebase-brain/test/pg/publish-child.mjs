// V10 helper (publish.test.mjs): one publish that stops inside its transaction after the node writes, so the test can
// kill this process there. Input: BRAIN_TEST_PUBLISH_INPUT (a JSON file: attemptId, base, delta, checksum, commit,
// repoDir) and BRAIN_TEST_WRITER_URL (env only, never printed).
import { readFileSync } from 'node:fs';
import { publish } from '../../src/pg/publish.mjs';

const revive = (k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data) ? Buffer.from(v.data) : v);
const input = JSON.parse(readFileSync(process.env.BRAIN_TEST_PUBLISH_INPUT, 'utf8'), revive);
await publish({ url: process.env.BRAIN_TEST_WRITER_URL, ...input, mode: 'normal', toolVersion: 'test',
  onStage: (s) => (s === 'nodes' ? new Promise(() => process.stdout.write('ready\n')) : null) });

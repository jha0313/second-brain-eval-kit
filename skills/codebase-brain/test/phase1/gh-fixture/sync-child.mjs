// Crash-test child (lane G, §5.2 S3): one sync of a github.json snapshot with the fake client and deps, so that
// BRAIN_CRASH_AT can SIGKILL it at a failpoint. Prints the SyncResult as JSON when it is not killed.
// usage: node sync-child.mjs <v1|v2> <codeDbPath> [--full]
import { dirname } from 'node:path';
import { sync } from '../../../src/gh-sync.mjs';
import { fakeClient, fakeDeps, loadSnapshot } from './fakes.mjs';

const [snap, codeDbPath, flag] = process.argv.slice(2);
const r = await sync({ codeDbPath, repoDir: dirname(codeDbPath), client: fakeClient(loadSnapshot(snap)), full: flag === '--full', deps: fakeDeps() });
process.stdout.write(`${JSON.stringify(r)}\n`);

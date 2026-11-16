// Read context (P0, implemented): the two stores a read command looks at, opened read-only.
import { existsSync } from 'node:fs';
import { openDb, getMeta } from './db.mjs';
import { githubDbPath, openGithubDb, readSyncState } from './gh-schema.mjs';

/**
 * @typedef {{
 *   code: import('node:sqlite').DatabaseSync,        // code.db, read-only
 *   gh: import('node:sqlite').DatabaseSync | null,   // github.db, read-only, null when never synced
 *   meta: Record<string, any>,                       // code.db meta (build_id, sanitize_version, commit, ...)
 *   sync: Record<string, any> | null,                // github.db sync_state row
 *   checkout: string | undefined,                    // the git checkout the command runs in
 *   codeDbPath: string, ghDbPath: string,
 *   close(): void
 * }} Ctx
 */

/** @param {{ codeDbPath: string, checkout?: string }} opts @returns {Ctx} */
export function openContext({ codeDbPath, checkout }) {
  const code = openDb(codeDbPath);
  const ghDbPath = githubDbPath(codeDbPath);
  const gh = existsSync(ghDbPath) ? openGithubDb(ghDbPath, { readOnly: true }) : null;
  return {
    code, gh, meta: getMeta(code), sync: gh ? readSyncState(gh) : null, checkout, codeDbPath, ghDbPath,
    close() { try { code.close(); } catch {} try { gh?.close(); } catch {} },
  };
}

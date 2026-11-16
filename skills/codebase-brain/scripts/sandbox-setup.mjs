// Sandbox setup for the Phase 3 S7 run (design §4, §6.1, §6.7, §7): two user-owned GitHub repos (source role and ops
// role), their secrets and variable, the Neon target, and the agent's two credentials. DRY RUN ONLY: this script prints
// the steps as shell commands and runs nothing. It has no network access and starts no process. The lead decides at S7
// whether and when to run them, by hand.
//   node scripts/sandbox-setup.mjs --owner <github user> [--source <repo>] [--ops <repo>] [--neon-branch <name>]
//                                  [--code <public TypeScript git URL>] [--code-ref <tag or branch>] [--kit-commit <sha>]
// The printed commands never put a credential on a command line or on the screen: connection strings stay in shell
// variables or pipes, and secrets go to `gh secret set` on stdin. NEON_PROJECT_ID is printed as the variable name only.
import { pathToFileURL } from 'node:url';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const DEFAULTS = Object.freeze({ owner: '<owner>', source: 'brain-sandbox-source', ops: 'brain-sandbox-ops', 'neon-branch': 'brain-sandbox',
  code: '<public TypeScript repo URL>', 'code-ref': '<tag>', 'kit-commit': '<kit commit>' });
const PLACEHOLDER = /^<[a-z A-Z]+>$/;

/** @param {string[]} argv @returns {{ opts: Record<string, string> } | { error: string }} */
export function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') return { error: 'there is no apply mode: the lead runs the printed steps by hand at S7' };
    const key = a.startsWith('--') ? a.slice(2) : null;
    if (!key || !(key in DEFAULTS) || i + 1 >= argv.length) return { error: `unknown or incomplete option: ${a}` };
    opts[key] = argv[(i += 1)];
  }
  for (const k of ['owner', 'source', 'ops', 'neon-branch', 'code-ref']) {
    if (!PLACEHOLDER.test(opts[k]) && !NAME.test(opts[k])) return { error: `--${k}: letters, digits, '.', '_', '-' only` };
  }
  if (!PLACEHOLDER.test(opts['kit-commit']) && !/^[0-9a-f]{40}$/.test(opts['kit-commit'])) return { error: '--kit-commit: a 40-character commit SHA' };
  if (!PLACEHOLDER.test(opts.code) && !/^https:\/\/[A-Za-z0-9./_-]+$/.test(opts.code)) return { error: '--code: an https git URL' };
  return { opts };
}

/** @param {Record<string, string>} o @returns {{ title: string, why?: string, run?: string[], manual?: string[] }[]} */
export function steps(o) {
  const src = `${o.owner}/${o.source}`, ops = `${o.owner}/${o.ops}`, br = o['neon-branch'];
  const neon = `--project-id "$NEON_PROJECT_ID"`;
  // a connection string for one role of the sandbox branch, built from the owner's and the password file; stdout only
  const roleUrl = (role, pooled) => [
    `neon connection-string ${br} ${neon} --role-name neondb_owner --database-name neondb${pooled ? ' --pooled' : ''} \\`,
    `  | ROLE=${role} PWFILE="$PWFILE" node -e 'const u = new URL(require("fs").readFileSync(0, "utf8").trim()); u.username = process.env.ROLE;`,
    `      u.password = JSON.parse(require("fs").readFileSync(process.env.PWFILE, "utf8"))[process.env.ROLE]; process.stdout.write(u.href)' \\`];
  return [
    { title: 'Shell setup (one shell for every step; nothing below prints a credential)',
      run: ['export NEON_API_KEY="$(cat ~/.config/neon/api-key)"   # key stays in env', 'export NEON_PROJECT_ID=<the Neon test project id>   # not the production project',
        'WORK="$(mktemp -d)"; PWDIR="$(mktemp -d)"; chmod 700 "$PWDIR"; PWFILE="$PWDIR/passwords.json"',
        'KIT=<path to a checkout of this kit repo>'] },

    { title: 'Neon target: a branch of the test project, schema and roles',
      why: 'Phase 2 §6.2: the owner migrates once; brain_writer and brain_reader get random passwords from a 0600 file',
      run: [`neon branches create ${neon} --name ${br} --parent production -o json > /dev/null`,
        `(umask 077; node -e 'const r = () => require("crypto").randomBytes(24).toString("base64url"); process.stdout.write(JSON.stringify({ brain_writer: r(), brain_reader: r() }))' > "$PWFILE")`,
        `OWNER_URL="$(neon connection-string ${br} ${neon} --role-name neondb_owner --database-name neondb)"`,
        `(cd "$KIT/skills/codebase-brain" && OWNER_URL="$OWNER_URL" PWFILE="$PWFILE" node --input-type=module -e 'import { migrate } from "./src/pg/migrate.mjs"; await migrate(process.env.OWNER_URL, { passwordFile: process.env.PWFILE }); console.log("migrated")')`,
        'unset OWNER_URL'] },

    { title: `Source-role repo ${src}: public TypeScript code of a service-repo size, no service-repo code`,
      why: 'design §4: the source role holds the code and the GitHub history; it gets no brain file and no brain secret',
      run: [`gh repo create ${src} --private`,
        `git clone --quiet --depth 1 --branch ${o['code-ref']} ${o.code} "$WORK/src" && rm -rf "$WORK/src/.git"`,
        `git -C "$WORK/src" init -q -b main && git -C "$WORK/src" add -A && git -C "$WORK/src" commit -q -m "sandbox: public TypeScript code at ${o['code-ref']}"`,
        `git -C "$WORK/src" remote add origin https://github.com/${src}.git && git -C "$WORK/src" push -q -u origin main`] },

    { title: 'Source-role repo: GitHub history for sync (issues, PRs, one merged)',
      run: [`gh issue create --repo ${src} --title "sandbox: first issue" --body "Refunds wait for the ledger."`,
        `git -C "$WORK/src" switch -q -c sandbox-pr-1 && echo "// sandbox change 1" >> "$WORK/src/README.md" && git -C "$WORK/src" commit -qam "sandbox: change 1" && git -C "$WORK/src" push -q -u origin sandbox-pr-1`,
        `gh pr create --repo ${src} --head sandbox-pr-1 --title "sandbox: change 1" --body "Fixes #1"`,
        `gh pr merge --repo ${src} sandbox-pr-1 --squash --delete-branch`,
        `git -C "$WORK/src" switch -q main && git -C "$WORK/src" pull -q`] },

    { title: `Ops-role repo ${ops}: the kit at a pinned commit and the two workflows`,
      why: 'Phase 2 §4 ops repo: the writer secret lives only here; BRAIN_SOURCE_REPO is fixed in the file, never an input',
      run: [`gh repo create ${ops} --private`,
        `mkdir -p "$WORK/ops/.github/workflows" && git -C "$KIT" archive ${o['kit-commit']} skills/codebase-brain | tar -x -C "$WORK/ops"`,
        `cp "$WORK/ops/skills/codebase-brain/ci/brain-publish.yml" "$WORK/ops/skills/codebase-brain/ci/brain-bootstrap.yml" "$WORK/ops/.github/workflows/"`,
        `perl -pi -e 's#^(\\s*BRAIN_SOURCE_REPO:\\s*)\\S+#\${1}${src}#' "$WORK/ops/.github/workflows/"brain-*.yml`,
        `git -C "$WORK/ops" init -q -b main && git -C "$WORK/ops" add -A && git -C "$WORK/ops" commit -q -m "brain ops at kit ${o['kit-commit']}"`,
        `git -C "$WORK/ops" remote add origin https://github.com/${ops}.git && git -C "$WORK/ops" push -q -u origin main`] },

    { title: 'Ops-role repo: Actions settings and who can write',
      why: 'design §6.7: only the admin writes to the ops repo (P17); fork PRs get no secret; GITHUB_TOKEN is read-only by default',
      run: [`gh api -X PUT repos/${ops}/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false`,
        `gh api repos/${ops}/collaborators --jq '.[].login'   # expect the admin only`],
      manual: [`Settings → Actions → General → "Fork pull request workflows in private repositories": leave "Run workflows from fork pull requests" off`] },

    { title: 'Ops-role repo secrets (stdin only, never --body)',
      run: [...roleUrl('brain_writer', false), `  | gh secret set BRAIN_WRITER_URL --repo ${ops}   # direct endpoint`,
        `gh secret set BRAIN_SOURCE_TOKEN --repo ${ops}   # paste the source read token at the prompt`,
        `gh secret list --repo ${ops}   # names only: BRAIN_SOURCE_TOKEN, BRAIN_WRITER_URL`],
      manual: [`BRAIN_SOURCE_TOKEN: a fine-grained token in the browser; resource owner ${o.owner}, only ${src}; Contents, Issues, Pull requests: read (Metadata: read is added); 7-day expiry`,
        'BRAIN_BOOTSTRAP_UNTIL is NOT set now: the bootstrap gate stays closed until the bootstrap step below'] },

    { title: 'Agent credentials (laptop only, never in a repo)',
      why: 'design §4, §6.7: the agent reads with brain_reader and dispatches with an Actions-only token (P16, P17, P23)',
      run: ['mkdir -p ~/.config/brain-sandbox && chmod 700 ~/.config/brain-sandbox',
        ...roleUrl('brain_reader', true), '  > ~/.config/brain-sandbox/reader-url && chmod 600 ~/.config/brain-sandbox/reader-url   # pooled endpoint',
        'export BRAIN_READER_URL="$(cat ~/.config/brain-sandbox/reader-url)"'],
      manual: [`BRAIN_DISPATCH_TOKEN: a fine-grained token; only ${ops}; Actions: read and write (Metadata: read is added); nothing else (no Contents, Secrets or Variables)`,
        'store it like the reader URL (a 0600 file) and export it; never use the `gh auth token` login instead'] },

    { title: 'First publish: open the bootstrap gate for one hour, dispatch, close it',
      why: 'design §6.1: the gate step needs BRAIN_BOOTSTRAP_UNTIL later than now and at most 2 hours ahead',
      run: [`gh variable set BRAIN_BOOTSTRAP_UNTIL --repo ${ops} --body "$(node -e 'console.log(new Date(Date.now() + 3600e3).toISOString().slice(0, 19) + "Z")')"`,
        `gh workflow run brain-bootstrap.yml --repo ${ops} --ref main`,
        `gh run watch --repo ${ops} "$(gh run list --repo ${ops} --workflow brain-bootstrap.yml --limit 1 --json databaseId --jq '.[0].databaseId')"`,
        `gh variable delete BRAIN_BOOTSTRAP_UNTIL --repo ${ops}`] },

    { title: 'A normal publish',
      run: [`gh workflow run brain-publish.yml --repo ${ops} --ref main`, `gh run list --repo ${ops} --workflow brain-publish.yml --limit 3`] },

    { title: 'Boundary checks for S7 (P17, P18, P23): each must be refused, skipped or empty, and brain.attempt must not grow',
      why: 'design §6.7: the dispatch token can dispatch and read runs, nothing else; only main publishes; the gate needs an admin',
      run: [`attempts() { (cd "$KIT/skills/codebase-brain" && node --input-type=module -e 'import pg from "pg"; const c = new pg.Client(process.env.BRAIN_READER_URL); await c.connect(); console.log("attempts", (await c.query("SELECT count(*)::int AS n FROM brain.attempt")).rows[0].n); await c.end()'); }`,
        `watch_last() { sleep 5; gh run watch --repo ${ops} --exit-status "$(gh run list --repo ${ops} --workflow "$1" --limit 1 --json databaseId --jq '.[0].databaseId')"; }`,
        'attempts',
        `GH_TOKEN="$BRAIN_DISPATCH_TOKEN" gh secret list --repo ${ops}   # P17: expect HTTP 403`,
        `GH_TOKEN="$BRAIN_DISPATCH_TOKEN" gh api -X PUT repos/${ops}/contents/probe.txt -f message=probe -f content=cHJvYmU=   # P17 push: expect 403 or 404`,
        `GH_TOKEN="$BRAIN_DISPATCH_TOKEN" gh api -X PUT repos/${ops}/contents/.github/workflows/brain-publish.yml -f message=probe -f content=cHJvYmU= -f sha="$(gh api repos/${ops}/contents/.github/workflows/brain-publish.yml --jq .sha)"   # P17 workflow edit: expect 403 or 404`,
        `GH_TOKEN="$BRAIN_DISPATCH_TOKEN" gh variable set BRAIN_BOOTSTRAP_UNTIL --repo ${ops} --body 2099-01-01T00:00:00Z   # P23: expect HTTP 403`,
        `# P23 gate closed three ways (the admin sets the variable, the dispatch token dispatches; wait for each run: a run reads the variable when it starts)`,
        `gh variable delete BRAIN_BOOTSTRAP_UNTIL --repo ${ops} 2>/dev/null; GH_TOKEN="$BRAIN_DISPATCH_TOKEN" gh workflow run brain-bootstrap.yml --repo ${ops} --ref main; watch_last brain-bootstrap.yml   # expect: fails at the gate`,
        `gh variable set BRAIN_BOOTSTRAP_UNTIL --repo ${ops} --body 2020-01-01T00:00:00Z; GH_TOKEN="$BRAIN_DISPATCH_TOKEN" gh workflow run brain-bootstrap.yml --repo ${ops} --ref main; watch_last brain-bootstrap.yml   # expect: fails at the gate`,
        `gh variable set BRAIN_BOOTSTRAP_UNTIL --repo ${ops} --body "$(node -e 'console.log(new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 19) + "Z")')"; GH_TOKEN="$BRAIN_DISPATCH_TOKEN" gh workflow run brain-bootstrap.yml --repo ${ops} --ref main; watch_last brain-bootstrap.yml   # expect: fails at the gate`,
        `gh variable delete BRAIN_BOOTSTRAP_UNTIL --repo ${ops}`,
        `# P18: a dispatch to another ref of the ops repo`,
        `gh api repos/${ops}/git/refs -f ref=refs/heads/probe -f sha="$(gh api repos/${ops}/git/ref/heads/main --jq .object.sha)" > /dev/null`,
        `GH_TOKEN="$BRAIN_DISPATCH_TOKEN" gh workflow run brain-publish.yml --repo ${ops} --ref probe; sleep 20; gh run list --repo ${ops} --workflow brain-publish.yml --limit 1   # expect: the job is skipped`,
        `gh api -X DELETE repos/${ops}/git/refs/heads/probe`,
        `# P17: a workflow pushed to a branch of the SOURCE repo cannot see the writer secret (README "V22 확인")`,
        `git -C "$WORK/src" switch -q -c secret-probe && mkdir -p "$WORK/src/.github/workflows" && printf '%s\\n' 'on: push' 'jobs:' '  probe:' '    runs-on: ubuntu-24.04' '    steps:' '      - env:' '          W: \${{ secrets.BRAIN_WRITER_URL }}' '        run: test -z "$W" && echo "no writer secret in the source repo"' > "$WORK/src/.github/workflows/probe.yml"`,
        `git -C "$WORK/src" add -A && git -C "$WORK/src" commit -qm "probe" && git -C "$WORK/src" push -q -u origin secret-probe; sleep 20; gh run list --repo ${src} --branch secret-probe --limit 1   # expect: success`,
        `git -C "$WORK/src" push -q origin --delete secret-probe && git -C "$WORK/src" switch -q main`,
        'attempts   # expect: the same count as before these checks'] },

    { title: 'Teardown after S7 (the lead decides)',
      run: [`gh repo delete ${src} --yes`, `gh repo delete ${ops} --yes`, `neon branches delete ${br} ${neon}`,
        'rm -rf "$WORK" "$PWDIR" ~/.config/brain-sandbox'],
      manual: ['revoke both fine-grained tokens in the browser'] },
  ];
}

/** @returns {string} the steps as text */
export function render(o) {
  const out = ['# DRY RUN: nothing was run. These are the steps for S7; run them by hand after the lead decides.', ''];
  steps(o).forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.title}`);
    if (s.why) out.push(`# ${s.why}`);
    for (const l of s.run ?? []) out.push(l);
    for (const l of s.manual ?? []) out.push(`# by hand: ${l}`);
    out.push('');
  });
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = parseArgs(process.argv.slice(2));
  if (r.error) { console.error(`sandbox-setup: ${r.error}`); process.exit(2); }
  console.log(render(r.opts));
}

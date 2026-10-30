---
name: codebase-brain
description: Find every file that imports a module (directly or through N hops), every reference or call site of a symbol, and every file, test, page or route that may be affected by a change, across a whole TypeScript/JavaScript repo, from a compiler-built index instead of grep. Also answers "why is X built this way / what went wrong before / which PR changed it" with doc and commit citations. Use it for "which files import X", "what is affected if I change X", "list every caller/use of X", "which tests cover X", "what do A and B share". Do not use it for a small task inside one file you already know.
---

# codebase-brain (prototype)

`brain` answers cross-file questions from an index, in one or two calls, with a coverage flag on every answer.
Call it before grep when the answer is a list of files or locations: grep misses alias and relative imports and counts comments and `vi.mock` strings.
It does not answer for you: it gives exact locations and citations, then you read those lines.

Run `bin/brain` in this skill's base directory: `.claude/skills/codebase-brain/bin/brain` in a project, `~/.claude/skills/codebase-brain/bin/brain` for a user install. `brain` below means that path.
Needs Node 22.13+. Queries need no packages; `brain build` needs `npm install` once in this directory. `BRAIN_DB` or `--db` names the index file.

## 0. Before the first query

```bash
brain status                        # index commit, files changed since, coverage
brain build <repo-root>             # no index yet: 10–60 s for 6,000 files, writes nothing into the repo
```

`brain status` and every answer print `stale:` when HEAD moved after the index. Then grep the changed files it lists, or rebuild.

## 1. Route by question

| The question | Call | Not this |
|---|---|---|
| Every use / caller of a symbol | `brain find X` → `brain refs <ID>` or `brain callers <ID>` | grep the name |
| Every file that imports a module, N hops out | `brain impact <file> --hops N --list` (`--no-mocks`: skip `vi.mock`) | grep for the path |
| What may be affected if a file or symbol changes | `brain impact <ID>` (hop table, tests counted) | reading importers by hand |
| Only pages / routes / tests / server actions | add `--filter page,route,test,server-action` (or `--exclude test`) | filtering grep output |
| What two areas both depend on | `brain shared <dirA> <dirB>` | — |
| What a file pulls in | `brain deps <file>` | — |
| Why is it built so / what broke / which PR | `brain why "<question>"` → read the cited lines | guessing from code |
| See it | `brain viz <ID> --out graph.html` | — |
| Small task in one known file | **do not call brain.** Read the file. | an index round-trip |

`<ID>` is `path#Name` (`lib/credits.ts#reserve`, `src/a.ts#Class.method`) or a file path or a directory.

## 2. Rules

1. **IDs, not strings.** If `brain` says `ambiguous`, pick one ID from its list and ask again.
2. **Never call a capped list complete.** `coverage: truncated` → page with `--cursor N` (or use `--files`). `coverage: partial` → say which part may be missing (unresolved imports, listed by `brain status`).
3. **Static facts only.** The map sees imports, calls, JSX renders, types and `extends`. It does not see `obj[name]()`, string-built import paths, DI containers, or config that names code by string. When the question depends on those, add a grep for the name.
4. **Read before you answer.** `refs`/`impact` give locations; `why` gives citations. Open the cited lines, answer with `path:line` or the commit SHA and PR number.
5. **Fail open.** If `brain` errors, has no index, or does not know the name, continue with grep and Read. Do not stop the task.
6. **Tests decide.** After an edit, run the tests that `brain impact <ID> --filter test --list` lists.

## 3. Output

Tables for people; add `--json` for exact lists. Every answer ends with:

```text
  coverage: complete · index @<commit>
```

`complete` = the whole index was searched and nothing was cut. Anything else is a reason to say "at least".

## 4. Limits (prototype)

- TS/JS: symbols are top-level declarations and class members, resolved by the TypeScript compiler (`tsconfig` paths, several `tsconfig`s, dynamic `import()`, `vi.mock`). CommonJS `module.exports` members and JSDoc `{@link}` are not symbols. CSS and other assets are not tracked.
- C/C++/Python: file level only (`#include`, `import`).
- `why` is keyword + link search (BM25, trigram for Korean, doc→code and doc→commit links). No embeddings, no LLM.
- `impact` is reverse reachability over imports and uses: "may be affected", not proof that something breaks. Next.js file-system routing and runtime links (strings, `fetch` URLs, env) are out of scope.
- One repo, one commit per index. This is a prototype. A more advanced version is planned for the course.

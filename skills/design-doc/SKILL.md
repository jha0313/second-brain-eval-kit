---
name: design-doc
description: Write a design document for one phase or feature that a team and coding agents will implement in parallel, get it reviewed by Codex, and publish it as markdown plus an interactive HTML page. Use it for "설계 문서 써줘", "Phase N 설계", "design doc for X", "이 기능 설계하고 리뷰까지", or when a plan must hand PR-sized tasks with interface contracts to parallel agents. Do not use it for a short answer, a code review, or a plan that stays in chat.
---

# design-doc

The markdown is the source; the HTML page is built from it. Readers: the team and the coding agents that implement it.

## 1. Format

Write in Korean. Short plain sentences, one idea each. Tables over prose. Header first:

```markdown
# Phase N 설계: <한 줄 제목>

- 상태: 설계 리뷰용 (코드 없음)
- 날짜: YYYY-MM-DD
- 대상: <무엇 위에 쌓나>
- 외부 의존 추가: <없음 / 무엇>

---
```

Then these sections, numbered exactly so (the builder uses the numbers for ids):

| § | Holds |
|---|---|
| 0 TL;DR | 3–5 bullets: problem, what this phase does, data/flow, safety |
| 1 왜 필요한가 | Most important. Measured cost or failure, why now, alternatives table (대안 · 무엇이 남나 · 판단) |
| 2 Impact · 성공 기준 | Before/after table. Numbered criteria that a test or measurement can decide |
| 3 범위 | 한다 / 하지 않는다. Every cut item says why |
| 4 요청 해석 · 가정 | Table: request wording → interpretation. Assumptions and measured facts with dates |
| 5 HLD | 5.1 mermaid flowchart, 5.2 components table, 5.3 key decisions (결정 · 이유 · 버린 대안) |
| 6 LLD | ERD, sequence diagrams, rules table `R1…` (규칙 · 근거), failure table (상황 · 동작 · 상태 · 보이는 것), security |
| 7 테스트 | Tables of scenario → pass condition. Each success criterion maps to tests |
| 8 구현 계획 | 8.1 task table, 8.2 dependency mermaid + lanes table (레인 · 작업 · 소유 파일 · 동시에) |
| 9 열린 질문 | Numbered, each with a default proposal |
| 10 한계 | What still goes wrong after this design |
| 부록: 리뷰 반영 기록 | Review rounds (§3 below) |

Rules:

- Cite a primary source URL for every external fact (vendor docs, official API reference). Mark what you could not verify. Prefer a measurement you ran, with its date.
- State cut items and the reason. Do not add flexibility nobody asked for.
- List what this phase needs from an earlier one as "Phase N−1 needs" in your report.
- Public repos: no private repo names, owners, internal paths or private eval facts.

### The §8.1 task table

The HTML task explorer reads this table, so keep the columns:

```markdown
| ID | 작업 | 받는 것 | 내놓는 것 (소유 파일) | 의존 | 크기 | 완료 기준 |
```

- `ID`: short and unique (`Q0`, `S3`, `P0`, `A`). The builder finds dependencies by matching these IDs in `의존`. Other text there (e.g. `Phase 2 Q3`) is shown but not linked.
- `받는 것` / `내놓는 것`: the interface contract. Name exports with signatures, files, and the test command, so a lane can start from the contract alone.
- `의존`: include tasks needed to check the done criterion, not only to start.
- `크기`: `S` · `M` · `L` (weights 1 · 2 · 3 for the critical path).
- `완료 기준`: a command or a named test set.
- Optional `웨이브` column (a number). Without it, waves come from dependency depth.

## 2. Diagrams and widgets

- Mermaid in fenced `mermaid` blocks. Quote labels with spaces or symbols; `<br/>` breaks lines.
- A widget is an optional interactive block for a mechanism the reader must "run" to understand (a sync window, an as-of slider, a failure simulator). One or two per doc. Put `<!--widget:NAME-->` on its own line where it belongs.
- A widget is `NAME.html` (markup, may hold a `<style>`) and optional `NAME.js` (runs inside an IIFE after the page script; `$`, `$$`, `reduce` and `PLAN` exist). Use the template's CSS tokens (`--accent`, `--ok`, `--bad`, `--amber`, `--sunk`, `--line`, …) so both themes work. Write demo data, never real private data.
- The task explorer (`plan`) is built in. It goes at the end of the subsection after the task table (8.2) unless you place `<!--widget:plan-->`.

## 3. Review with Codex

1. Write the draft to `docs/<name>.md`.
2. Write the review prompt to a scratchpad file: the document, the user's requirements, ordered goals (correctness blockers → external facts with URLs → gaps against existing code → §8 contracts → tests → over-engineering → mermaid), output format (verdict line, `**[blocker|major|minor] [§] title** — evidence — fix`, ≤ 25 findings, "Over-engineering", "Facts verified").
3. Run it in the background, read-only:

   ```bash
   codex exec --skip-git-repo-check -m gpt-6.1-sol -c model_reasoning_effort=xhigh -s read-only \
     -o "$D/review-r1.out.md" "$(cat "$D/review-r1.md")" </dev/null > "$D/review-r1.log" 2>&1
   ```

4. Verify every finding against the code, docs and primary sources before changing anything. Reviewers can be wrong; record what you declined and why.
5. Fix, then run one narrower confirmation round: per round-1 finding resolved / partially / not, plus new problems from the revision, at most 12.
6. Fill the appendix: per round, verdict, counts by severity, and finding → handling (반영 / 일부 / 거절 + reason). Stop after the confirmation round; if it still fails, report that instead of looping. Show the user only the final version.

## 4. Build the HTML

```bash
node scripts/build-html.mjs docs/<name>.md docs/<name>.html \
  --widgets widgets/<set> --eyebrow "<project> · Phase N · 설계서"
```

- `--widgets DIR` may repeat. `--place s6-2=sync,…` puts a widget at the end of a subsection when you cannot add markers to the markdown.
- The page has a scrollspy index, click-to-zoom diagrams, light/dark themes, and the task explorer (dependencies, critical path, contract per task). `widgets/phase1`–`phase3` are worked examples.

## 5. Verify before you report

Render each page in headless Chrome and check what actually happened:

```bash
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$C" --headless=new --disable-gpu --user-data-dir="$D/chrome" --enable-logging=stderr --v=0 \
  --virtual-time-budget=20000 --dump-dom "file://$PWD/docs/<name>.html" > "$D/dom.html" 2> "$D/console.txt"
grep -o '<svg[^>]*id="mermaid-' "$D/dom.html" | wc -l   # must equal the number of mermaid blocks
grep -c 'Syntax error' "$D/dom.html"                    # must be 0
grep -c 'CONSOLE' "$D/console.txt"                      # must be 0
```

Mermaid loads from a CDN, so this needs network. Report the counts you saw and which widgets you drove (a small test script appended to a copy of the page works headless).

# second-brain-eval-kit

패스트캠퍼스 세미나 "세컨브레인 · Eval"(2026-10-31)에서 쓴 프로토타입 스킬과, 그 뒤 Phase 1–3에서 더한 것입니다.

| 폴더 | 무엇 |
|---|---|
| [skills/codebase-brain](skills/codebase-brain) | 코딩 에이전트용 지도(코드 그래프)와 코드 메모리. "X를 쓰는 곳 전부·바꾸면 어디가 영향받나"(import 그래프)와 "왜 이렇게 만들었나"(문서·changes·커밋 검색)를 `파일:줄`·커밋 인용으로 답합니다. Phase 1–3에서 GitHub 기억(`brain sync`), 팀 서버(Neon Postgres), 자동 갱신(GitHub Actions)을 더했습니다. |
| [skills/skill-eval](skills/skill-eval) | 스킬 비교 eval 하네스. 스킬 없음(none)과 스킬 버전(v1, v2 …)을 격리된 headless `claude -p` trial로 돌리고, 하드 체크와 judge 3표로 채점해 scorecard를 만듭니다. |
| [skills/design-doc](skills/design-doc) | 한 phase · 기능의 설계서를 쓰고 Codex 리뷰를 받아 markdown과 인터랙티브 HTML로 내는 스킬. 아래 Phase 2 · 3 설계서를 이것으로 썼습니다. |

## 설치

```bash
git clone https://github.com/jha0313/second-brain-eval-kit
mkdir -p ~/.claude/skills                # 폴더가 없으면 cp가 이름을 바꿔 복사함
cp -r second-brain-eval-kit/skills/codebase-brain second-brain-eval-kit/skills/skill-eval ~/.claude/skills/
cp -r second-brain-eval-kit/skills/design-doc ~/.claude/skills/     # 설계서 스킬이 필요하면
cd ~/.claude/skills/codebase-brain && npm install      # Node 22.13 이상
```

skill-eval은 Python 3.11 이상과 [uv](https://docs.astral.sh/uv/)가 필요합니다. 인증 준비는 [skills/skill-eval/SKILL.md](skills/skill-eval/SKILL.md)의 "순서 1"을 따릅니다.

## 빠른 시작

```bash
# codebase-brain
export PATH="$HOME/.claude/skills/codebase-brain/bin:$PATH"
cd /path/to/repo                         # 쿼리는 지금 있는 git repo의 인덱스를 씀
brain build . --if-stale                 # 대상 repo에는 아무것도 쓰지 않음. 인덱스가 맞으면 건너뜀
brain find reserve                       # → ID (path#Name)
brain impact src/lib/credits.ts#reserve  # 영향받을 수 있는 파일을 hop별로
brain why "why reserve credits first"    # 문서·changes·커밋 인용 묶음
# 위 이름들은 skills/codebase-brain/test/fixture 복사본에서 git init·commit 후 그대로 돕니다.

# skill-eval: suites/example/를 복사해 <…> 자리를 내 repo에 맞게 채운 뒤
SE=~/.claude/skills/skill-eval
cd $SE && export MY_REPO=/path/to/repo
uv run --project $SE skill-eval probe --out runs/probe              # 격리 점검이 모두 PASS(ISOLATION OK)여야 함
uv run --project $SE skill-eval keycheck suites/my-suite/suite.yaml # 정답표·빈 <…> 자리 점검 ($0)
uv run --project $SE skill-eval selftest suites/my-suite/suite.yaml # 채점기 점검 ($0)
uv run --project $SE skill-eval freeze suites/my-suite/suite.yaml   # 고정해야 run이 시작함
uv run --project $SE skill-eval run suites/my-suite/suite.yaml --dry-run
uv run --project $SE skill-eval run suites/my-suite/suite.yaml -k 3 -j 6 --max-usd 20
```

자세한 명령과 규칙은 각 폴더의 README.md·SKILL.md에 있습니다.

## Phase 1–3 (2026-11)

| Phase | 더한 것 | 설계서 | 판정 |
|---|---|---|---|
| 1 GitHub 기억 | `brain sync`가 PR · 리뷰 · 이슈를 로컬 SQLite로 모음. 비밀 마스킹, 본문은 untrusted quote로만. `brain search` · `get` · `source` | [phase1-design.md](docs/phase1-design.md) · [구현 계획](docs/phase1-impl-plan.md) | 충족: "왜" 질문 0.10 → 0.69 (held-out) |
| 2 팀 서버 | codebase마다 Neon Postgres 하나. 쓰기는 CI 하나, 읽기는 SELECT만. 노트북은 mirror로 읽음 | [phase2-design.md](docs/phase2-design.md) ([HTML](docs/phase2-design.html)) | 일부 미달: 서버 검색 순위가 로컬과 다름 |
| 3 자동 갱신 | `brain-publish.yml`(매일 + dispatch)과 `brain ci-publish`. 낡은 답은 footer에 표시하고 `brain refresh`로 갱신 | [phase3-design.md](docs/phase3-design.md) ([HTML](docs/phase3-design.html)) | 대부분 충족: dispatch → publish p95 75.9 s |

설계하고 구현시킬 때 실제로 쓴 프롬프트는 [prompts](prompts/README.md)에 모았습니다.

- **로컬 모드를 기본으로 권장합니다.** 서버 모드는 로컬과 같은 후보를 찾지만 순서를 다르게 매겨서, 사전 등록 agent eval에서 통과율이 0.10 낮았습니다. 서버 모드는 여러 사람이 같은 brain을 읽어야 할 때 씁니다. 설정은 [skills/codebase-brain/README.md](skills/codebase-brain/README.md)에 있습니다.
- **작업 전에 brain을 보게 하기:** 실제 백로그 과제에서 에이전트는 "구현해", "지워"를 받으면 스킬을 잘 열지 않았습니다. 스킬 설명을 고쳤고, 대상 repo의 `.claude/CLAUDE.md`에 넣을 한 줄을 codebase-brain README의 "작업 전에 brain을 보게 하기"에 적었습니다. 사전 등록한 42번 시행 중 옛 PR·이슈·결정을 알아야 하는 과제에서, 첫 편집 전에 과제 주제로 brain을 검색한 시행은 그 파일이 없을 때 3/9, 한 줄이 있을 때 8/9였습니다. 파일과 새 값을 정해 준 작은 수정에서는 양쪽 모두 brain 호출이 0/9였습니다. 설정과 한계는 그 절에 적었습니다.

## 세미나 버전과 그 뒤 바뀐 것

세미나 화면의 코드와 줄 번호는 태그 [`seminar-2026-10-31`](https://github.com/jha0313/second-brain-eval-kit/tree/seminar-2026-10-31) 기준입니다. main은 세미나 뒤에 고친 버전입니다.

- **codebase-brain:**
  - 모든 답에 freshness(fresh·stale)를 붙이고, `build --if-stale`을 더했습니다.
  - why는 커밋이 아닌 SHA와 지금 없는 파일을 표시합니다.
  - route 파일에는 URL grep 안내를 냅니다.
  - 출력 버그 3개를 고쳤고, SKILL.md에 한국어 질문 예를 넣었습니다.
- **skill-eval:**
  - 채점 버전 grading-v2: 인용 해석 규칙을 하나로 하고, 줄 범위를 검사하고, 실패 사유에 라벨을 붙입니다.
  - freeze 없이는 run이 시작하지 않습니다. canary와 권한 거부 정지를 넣었고, judge가 고장 나면 0점이 아니라 제외합니다.
  - 재시도 비용을 모두 더합니다. `keycheck`를 더했고, 보고서에 실패 원인 표와 검출력 한 줄을 넣었습니다.
- 아래 세미나 숫자는 grading-v1로 잰 값입니다. grading-v2 숫자와 바로 비교할 수 없습니다.

자세한 내용은 각 폴더 README의 "…바뀐 동작" 절에 있습니다.

## 세미나 결과 요약

비공개 서비스 repo에서 잰 값입니다. 측정 케이스·정답·실행 기록은 비공개 repo의 내용이라 이 공개본에 넣지 않았습니다.

- 본 측정 통과율: none 88% · v1 93% · v2 95%. 차이는 검출하지 못했습니다.
- 탐색 실험(결과를 본 뒤 고른 질문 20개): none 40/60 · v1 39/60. 차이는 검출하지 못했습니다.

"차이를 검출하지 못함"은 "효과 없음"이 아니라 "이 케이스·반복 수로는 차이를 확신할 수 없다"는 뜻입니다.

## 한계

- 프로토타입입니다. 강의에서 더 고도화된 버전을 다룹니다.
- codebase-brain의 지도는 TypeScript repo를 기준으로 만들었습니다.
- 위 결과는 repo 하나, agent 모델 하나에서 잰 값입니다. 다른 repo로 넓혀 말할 수 없습니다.

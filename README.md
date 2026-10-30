# second-brain-eval-kit

패스트캠퍼스 세미나 "세컨브레인 · Eval"(2026-10-31)에서 쓴 프로토타입 스킬 두 개입니다.

| 폴더 | 무엇 |
|---|---|
| [skills/codebase-brain](skills/codebase-brain) | 코딩 에이전트용 지도(코드 그래프)와 코드 메모리. "X를 쓰는 곳 전부·바꾸면 어디가 영향받나"(import 그래프)와 "왜 이렇게 만들었나"(문서·changes·커밋 검색)를 `파일:줄`·커밋 인용으로 답합니다. |
| [skills/skill-eval](skills/skill-eval) | 스킬 비교 eval 하네스. 스킬 없음(none)과 스킬 버전(v1, v2 …)을 격리된 headless `claude -p` trial로 돌리고, 하드 체크와 judge 3표로 채점해 scorecard를 만듭니다. |

## 설치

```bash
git clone https://github.com/jha0313/second-brain-eval-kit
mkdir -p ~/.claude/skills                # 폴더가 없으면 cp가 이름을 바꿔 복사함
cp -r second-brain-eval-kit/skills/codebase-brain second-brain-eval-kit/skills/skill-eval ~/.claude/skills/
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
uv run --project $SE skill-eval probe --out runs/probe              # 격리 점검 21개 전부 PASS여야 함
uv run --project $SE skill-eval keycheck suites/my-suite/suite.yaml # 정답표·빈 <…> 자리 점검 ($0)
uv run --project $SE skill-eval selftest suites/my-suite/suite.yaml # 채점기 점검 ($0)
uv run --project $SE skill-eval freeze suites/my-suite/suite.yaml   # 고정해야 run이 시작함
uv run --project $SE skill-eval run suites/my-suite/suite.yaml --dry-run
uv run --project $SE skill-eval run suites/my-suite/suite.yaml -k 3 -j 6 --max-usd 20
```

자세한 명령과 규칙은 각 폴더의 README.md·SKILL.md에 있습니다.

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

AutoKliq(비공개 서비스)에서 잰 값입니다. 측정 케이스·정답·실행 기록은 비공개 repo의 내용이라 이 공개본에 넣지 않았습니다.

- 본 측정 통과율: none 88% · v1 93% · v2 95%. 차이는 검출하지 못했습니다.
- 탐색 실험(결과를 본 뒤 고른 질문 20개): none 40/60 · v1 39/60. 차이는 검출하지 못했습니다.

"차이를 검출하지 못함"은 "효과 없음"이 아니라 "이 케이스·반복 수로는 차이를 확신할 수 없다"는 뜻입니다.

## 한계

- 프로토타입입니다. 강의에서 더 고도화된 버전을 다룹니다.
- codebase-brain의 지도는 TypeScript repo를 기준으로 만들었습니다.
- 위 결과는 repo 하나, agent 모델 하나에서 잰 값입니다. 다른 repo로 넓혀 말할 수 없습니다.

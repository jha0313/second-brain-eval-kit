# second-brain-eval-kit

패스트캠퍼스 세미나 "세컨브레인 · Eval"(2026-10-31)에서 쓴 프로토타입 스킬 두 개입니다.

| 폴더 | 무엇 |
|---|---|
| [skills/codebase-brain](skills/codebase-brain) | 코딩 에이전트용 지도(코드 그래프)와 코드 메모리. "X를 쓰는 곳 전부·바꾸면 어디가 영향받나"(import 그래프)와 "왜 이렇게 만들었나"(문서·changes·커밋 검색)를 `파일:줄`·커밋 인용으로 답합니다. |
| [skills/skill-eval](skills/skill-eval) | 스킬 비교 eval 하네스. 스킬 없음(none)과 스킬 버전(v1, v2 …)을 격리된 headless `claude -p` trial로 돌리고, 하드 체크와 judge 3표로 채점해 scorecard를 만듭니다. |

## 설치

```bash
git clone https://github.com/jha0313/second-brain-eval-kit
cp -r second-brain-eval-kit/skills/codebase-brain second-brain-eval-kit/skills/skill-eval ~/.claude/skills/
cd ~/.claude/skills/codebase-brain && npm install      # Node 22.13 이상
```

skill-eval은 Python 3.11 이상과 [uv](https://docs.astral.sh/uv/)가 필요합니다. 인증 준비는 [skills/skill-eval/SKILL.md](skills/skill-eval/SKILL.md)의 "순서 1"을 따릅니다.

## 빠른 시작

```bash
# codebase-brain
export PATH="$HOME/.claude/skills/codebase-brain/bin:$PATH"
brain build /path/to/repo                # git repo. 대상 repo에는 아무것도 쓰지 않음
brain find reserve                       # → ID (path#Name)
brain impact src/lib/credits.ts#reserve  # 영향받을 수 있는 파일을 hop별로
brain why "why reserve credits first"    # 문서·changes·커밋 인용 묶음
# 위 이름들은 skills/codebase-brain/test/fixture 복사본에서 git init·commit 후 그대로 돕니다.

# skill-eval: suites/example/를 복사해 <…> 자리를 내 repo에 맞게 채운 뒤
SE=~/.claude/skills/skill-eval
cd $SE && export MY_REPO=/path/to/repo
uv run --project $SE skill-eval probe --out runs/probe              # 격리 점검 21개 전부 PASS여야 함
uv run --project $SE skill-eval selftest suites/my-suite/suite.yaml # 채점기 점검 ($0)
uv run --project $SE skill-eval freeze suites/my-suite/suite.yaml
uv run --project $SE skill-eval run suites/my-suite/suite.yaml --dry-run
uv run --project $SE skill-eval run suites/my-suite/suite.yaml -k 3 -j 6 --max-usd 20
```

자세한 명령과 규칙은 각 폴더의 README.md·SKILL.md에 있습니다.

## 세미나 결과 요약

AutoKliq(비공개 서비스)에서 잰 값입니다. 측정 케이스·정답·실행 기록은 비공개 repo의 내용이라 이 공개본에 넣지 않았습니다.

- 본 측정 통과율: none 88% · v1 93% · v2 95%. 차이는 검출하지 못했습니다.
- 탐색 실험(결과를 본 뒤 고른 질문 20개): none 40/60 · v1 39/60. 차이는 검출하지 못했습니다.

"차이를 검출하지 못함"은 "효과 없음"이 아니라 "이 케이스·반복 수로는 차이를 확신할 수 없다"는 뜻입니다.

## 한계

- 프로토타입입니다. 강의에서 더 고도화된 버전을 다룹니다.
- codebase-brain의 지도는 TypeScript repo를 기준으로 만들었습니다.
- 위 결과는 repo 하나, agent 모델 하나에서 잰 값입니다. 다른 repo로 넓혀 말할 수 없습니다.

---
name: skill-eval
description: Claude Code 스킬(SKILL.md)을 숫자로 평가한다. 스킬 없음·v1·v2(+ A/A 복사본) arm을 격리된 headless `claude -p` trial로 k번씩 돌리고, 코드 체크(정답 집합 recall·precision·인용·안전) → LLM judge(3표) → pass^k·paired Δ·bootstrap CI로 채점해 scorecard.html을 만든다. "이 스킬이 불리나/도움이 되나/이 수정이 망가뜨렸나", 스킬 eval·회귀 테스트·전후 비교를 요청할 때 사용한다.
---

# skill-eval (프로토타입)

스킬 하나에 세 질문으로 답하고, A/A로 잡음 크기를 함께 잰다. 숫자는 모두 같은 케이스에서 arm끼리 짝지어(paired) 비교한다.

| 질문 | 비교 | 지표 |
|---|---|---|
| 불리나? (routing, 진단용) | 스킬 있는 arm | 불려야 할 때 불리고 작은 대조군에서는 안 불린 비율. 점수에는 넣지 않는다 |
| 도움이 되나? (uplift) | `none` vs `v1` | 점수 Δ + 탐색적 95% CI, recall·precision·exact set, 시간·토큰·tool call·$ |
| 이 수정이 망가뜨렸나? (regression) | `v1` vs `v2` | 미리 정한 1차 지표의 Δ + CI, pass^k |
| 얼마나 흔들리나? (A/A) | `v1` vs `v1b` | 바이트까지 같은 복사본. Δ가 0 근처여야 위 두 Δ를 믿을 수 있다 |

실행: `uv run --project <이 폴더> skill-eval <command>` (Python ≥ 3.11, 의존성 PyYAML 하나).

## 순서 (이 순서를 지킨다)

1. **인증 준비 (한 번)** — 일반 터미널에서 `claude setup-token`을 실행하고, 출력된 토큰을 `~/.config/skill-eval/oauth-token`(권한 0600, 다른 곳이면 `SKILL_EVAL_TOKEN_FILE`)에 저장한다. 하네스는 이 경로를 화면·기록에 찍지 않는다. trial은 빈 설정 폴더로 돌기 때문에 내 로그인을 쓰지 않는다. 토큰을 화면이나 대화에 붙여 넣지 않는다.
2. **격리 probe** — `skill-eval probe --out runs/probe`. 21개 항목이 전부 PASS여야 비교 실행을 한다(haiku 몇 번, 약 $0.02). trial과 같은 도구 목록(Bash·Read·Grep·Glob·Skill)으로 돌린다. 평범한 Bash 명령(변수 실행·반복문·`$TMPDIR` 쓰기)이 권한 확인에 막히지 않는지, `~/.claude`·토큰 파일·정답 경로가 Bash(`head`)·Read·Grep·Glob 어느 쪽으로도 안 읽히는지, 에이전트 env에 토큰이 안 보이는지, 저장 파일에 토큰 문자열이 없는지, 빈 설정 폴더에 자동으로 생기는 파일(`remote-settings.json`·`policy-limits.json`)에 동작 키가 없는지도 본다(키 이름만 기록). 항목별 범위와 근거는 `probe.json`에 남는다.
3. **케이스 작성** — 아래 형식. 정답·rubric은 workspace 밖에 둔다. 로더가 프롬프트에 정답 항목이 섞이면 거부한다.
4. **채점기 selftest** — `skill-eval selftest suite.yaml`($0). 정답 자체·순서를 섞은 답·기준선 위의 답은 통과하고, 기준선 아래 recall·precision·잘린 JSON·없는 인용·틀린 값은 실패해야 한다(exact set은 하나만 빠져도 2차 지표에서 실패로 기록). 하나라도 틀리게 채점하면 여기서 고친다.
5. **v2 편집 계획을 먼저 기록** — 어떤 줄을 왜 지우는지, 1차 지표와 멈춤 규칙을 v1 결과를 보기 전에 파일로 남긴다(시각 포함).
6. **freeze** — `skill-eval freeze suite.yaml`. 케이스·정답·채점 코드·v2 diff·스킬 폴더·실행 규칙의 sha256을 `FROZEN.json`에 적는다. `run`은 해시가 다르면 시작하지 않는다. 다시 고정하려면 `--reason`을 적어야 하고, 이전 기록은 `history`에 남는다.
7. **dry-run** — `skill-eval run suite.yaml --dry-run`. trial 수, judge 호출 상한, 재시도·probe를 포함한 예상 $·시간을 보여 주고 승인을 받는다. `--calibrate runs/<dir>/results.json`이면 실측 단가를 쓴다.
8. **pilot** — freeze 뒤에 `--cases <2개> -k 1`(arm 4개 = 8 trial). freeze 전에 하네스를 시험할 때는 dev suite만 쓴다(본 케이스에 맞춰 스킬을 고치지 않도록). trial을 직접 읽고 채점이 맞는지 확인한다. 체크를 고쳤으면 `skill-eval grade <run>`으로 agent를 다시 돌리지 않고 재채점한다.
9. **본 실행** — `skill-eval run suite.yaml -k 3 -j 6 --max-usd <상한>`. 진행 줄: `[ 37/300] FA01 · v1 · #2 · PASS · 12:31`. 출력이 잘린 trial에는 `truncated_output`이 붙는다. 결과: `results.json`, `scorecard.html`, `summary.txt`, trial별 `trials/<id>/trajectory.jsonl`.
10. **보고** — 세 질문의 답을 숫자로, expected·attempted·scored·excluded 개수와 함께. CI가 0을 지나면 "이 케이스·반복 수에서는 차이를 검출하지 못함"이라고 쓴다.

## suite.yaml

```yaml
name: my-suite
skill: codebase-brain              # .claude/skills/<skill>/ 로 설치되는 이름
arms: {none: null, v1: ../../../codebase-brain, v2: {skill: ../../../codebase-brain, patch: v2.diff}, v1b: ../../../codebase-brain}   # v1b = A/A
repo: {path: ${MY_REPO}, label: my-repo, commit: <40자 SHA>, strip: [.claude, .agents, .codex]}   # 경로는 env 또는 --repo, 커밋만 고정. repo 자체의 agent 설정은 모든 arm에서 뺀다
cases: cases/*.json                                 # YAML 케이스 또는 JSON 형식. 예: suites/example/
find_all_pass: {min_recall: 0.9, min_precision: 0.8}  # find-all 통과 기준. 결과를 보기 전에 정하고 FROZEN.json에 고정
prepare: $SKILL_DIR/bin/brain build . --db .codebase-brain/brain.db   # 호스트에서 한 번, 스킬 없는 checkout에서. --vault 없음
prepare_outputs: [.codebase-brain/brain.db]         # 같은 파일(같은 sha256)을 스킬 arm마다 읽기 전용으로 복사
skill_env: {BRAIN_DB: "{ws}/.codebase-brain/brain.db"}   # 스킬 arm에만 들어가는 환경변수
deny_read: [~/.cache/codebase-brain]                # 그 밖에 trial이 읽으면 안 되는 호스트 경로
skill_use: {tool: Bash, match: 'bin/brain'}         # routing 진단: 스킬의 도구를 실제로 썼나
model: claude-sonnet-5-5       # agent (실제 모델 ID는 trial마다 기록)
judge_model: claude-opus-5-5   # judge는 agent와 다른 모델
k: 3
votes: 3
tools: Bash,Read,Grep,Glob,Skill   # 모든 arm 같게. Write·Edit·서브에이전트 없음
limits: {max_turns: 40, timeout_s: 900, max_usd: 3.0}   # 한도 초과 = agent 실패(limit)
compare: [[none, v1], [v1, v2], [v1, v1b]]
notes: ["보고서 '측정 한계'에 덧붙일 이 suite만의 한계"]
```

## 케이스

YAML(한 파일에 한 케이스):

```yaml
id: credits-export-impact
kind: find-all                     # find-all | why | small | other
family: credits-impact             # 같은 질문의 변형끼리 묶는다(통계에서 하나로 셈). 없으면 자동
prompt: |                          # 정답 없음. 출력 형식만 지시한다
  ... 경로를 ```json 배열 하나로 출력하세요.
checks:
  hard:
    - set_match: {key: answer-keys/x.json, unit: file}  # 통과: recall ≥ 0.9 그리고 precision ≥ 0.8(기본값). exact: true면 정확히 일치. exact는 항상 기록
    - cites_exist: {min: 1}                         # path:line·커밋 SHA가 repo@commit에 실제로 있나
    - sources_hit: {key: answer-keys/w.json}        # why: 정답 출처를 하나 이상 인용했나(줄 범위는 겹쳐야 함)
    - answer_regex: {pattern: '\b6,?000\b'}
    - tool_not_used: {tool: Bash, match: 'git push|rm -rf'}   # 안전
    - skill_loaded: {expect: true}                  # routing 진단(점수 밖)
  rubric:                          # 코드 체크를 모두 통과한 trial만 judge가 본다
    - {id: answers_question, pass: "...", fail: "..."}
```

skill-S1 JSON 형식(`find-all.json`, `why.json`, `controls.json` + `answer-keys/<id>.json`)은 그대로 읽는다. find-all은 정답 `items`에 대한 recall·precision(suite의 `find_all_pass` 기준, exact set은 2차 지표), why는 유효 인용 + 정답 출처 1개 이상 + rubric 2개(`answers_question`, `citations_support`), 대조군은 기대값 + 유효 인용이다.

## 격리 (trial마다)

- 새 workspace: repo@commit을 `$TMPDIR` 아래 APFS clone으로 복사한다. origin remote를 지우고, repo의 `.claude/.agents/.codex`를 sparse checkout으로 뺀다. arm의 스킬만 `.claude/skills/`에 복사한다(`eval-cases`, `answer-keys` 등은 제외, 정답과 같은 내용의 파일이 섞이면 중단). repo가 추적하는 CLAUDE.md·AGENTS.md는 모든 arm에 같게 둔다.
- 빈 `CLAUDE_CONFIG_DIR`(trial마다 새로) + `CLAUDE_CODE_OAUTH_TOKEN`(토큰 파일에서, 자식 프로세스에만) + 환경변수 허용 목록. `~/.claude`는 읽지도 복사하지도 않는다.
- `claude -p --output-format stream-json --setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-chrome` + `--settings`: 번들 스킬 off, `disableAllHooks`, auto-memory off, sandbox on, Bash·Read·Grep·Glob은 권한 단계에서 허용(Bash의 경계는 sandbox), Read/Edit deny(정답·rubric·suite·스킬 원본·trial 기록·토큰·`~/.claude`·`deny_read`)는 allow보다 우선하고 Grep·Glob에도 걸린다. 허용하지 않으면 `--permission-mode dontAsk`가 `$B args`, `for … $(…)`, `$TMPDIR` 쓰기, 에이전트가 `$TMPDIR`에 쓴 파일의 Read 같은 평범한 호출을 거부해서, 스킬과 무관한 실패가 생긴다. trial 결과에는 거부된 호출(`permission_denied`)이 남고, 실행 로그에 `!!`로 바로 뜬다.
- 이 컴퓨터에만 있는 위험 경로(정답 사본이 든 다른 작업 폴더, 더 새 히스토리를 가진 같은 repo의 clone 등)는 `SKILL_EVAL_DENY`(경로를 `:`로 구분)로 넘긴다. suite.yaml과 저장 기록에는 경로를 남기지 않고 개수만 적는다.
- workspace 위 폴더에 CLAUDE.md·AGENTS.md·.claude가 있으면 실행을 거부한다.
- 매 trial의 init 이벤트로 다시 검사한다. arm 스킬 외 스킬·MCP·memory·hook 이벤트가 보이면 그 trial은 `isolation_error`로 빠진다.

## 채점

1. **코드 체크** — 결과는 네 종류로 나뉜다.
   - 무결성: `no_answer_key_access`(자동). tool call 입력에 금지 경로가 나오면 trial을 `invalid`로 빼고 따로 센다.
   - 안전: `workspace_unchanged`(자동, 끝난 뒤 `git status`·HEAD 비교), `tool_not_used`. 실패하면 `safety_violation`, 점수 0.
   - 정답: `set_match`, `cites_exist`, `sources_hit`, `answer_regex`. 실패하면 `fail`, 점수 0, judge를 부르지 않는다.
     `cites_exist`는 없는 경로, 파일 끝을 넘는 줄 번호, 커밋이라고 적었는데 repo에 없는 SHA를 실패로 본다. UUID 조각이나 `run`·`id` 뒤의 16진수처럼 커밋이라고 하지 않은 16진수는 무시하고, `billing/CLAUDE.md`처럼 줄여 쓴 경로는 repo에 그 꼬리로 끝나는 파일이 있으면 인정한다.
   - 채점 중 예외가 나면 trial은 `infra_error`(`grader_exception`)로 남고 로그에 `!!`로 뜬다. 점수에 넣지 않는다.
   - routing 진단: `skill_loaded`, `tool_used`, `tool_order`. 점수에 넣지 않는다.
2. **judge** — 별도의 격리된 `claude -p`(tool 없음, `--json-schema`)를 3번 부르고, rubric 항목마다 다수결로 PASS/FAIL을 정한다. 인용 질문에는 하네스가 repo@commit에서 읽은 인용 줄과 정답 출처를 보여 준다. 같은 모델의 3표라서 독립 평가자 3명이 아니다.
3. **점수** — PASS 항목 비율(rubric 없으면 1.0). pass = 점수 ≥ `pass_threshold`(기본 0.7). 한도 초과(시간·turn·$)는 `limit`(점수 0), 인프라 오류는 최대 2번 재시도한 뒤 제외한다.
4. **통계** — 케이스별 평균, pass@k·pass^k, find-all recall·precision·exact-set 비율을 낸다. paired Δ는 케이스 가족 단위 percentile bootstrap 95% CI(탐색적)로 낸다. 가족이 5개 미만이면 Δ만 보고한다. 시간은 전체 평균과 성공 trial 평균을 함께 쓴다.

## 비용

$는 Claude Code가 trial마다 보고하는 정가 기준 금액(`total_cost_usd`)이다. 구독 로그인이라면 청구액이 아니라 사용량이다. `--dry-run`은 agent + judge 상한(rubric 케이스 × votes) + 재시도 여유 10% + probe로 추정한다. `--max-usd`를 주면, 실제 쓴 $와 진행 중 trial 예약분의 합이 상한을 넘을 때 새 trial은 진행 중인 trial이 끝나기를 기다리고, 실제 쓴 $만으로 넘게 되면 시작하지 않는다(`skipped_budget`). 실행 순서가 반복(rep) 우선이라 상한에 걸리면 마지막 반복이 arm마다 비슷하게 잘린다. trial마다 `--max-budget-usd`도 건다. 인덱스 빌드 시간은 trial 시간과 따로 보고한다.

## 한계 (프로토타입)

- sandbox는 Claude Code 내장 sandbox(macOS seatbelt)다. gVisor·microVM 같은 보안 경계가 아니다.
- 에이전트는 Bash 도구 설명에서 금지 경로 목록을 볼 수 있어 평가 중임을 알 수 있다. 모든 arm에서 같다.
- 서브에이전트는 비용과 분산 때문에 뺐다. 실제 사용에서 서브에이전트를 쓰는 스킬이라면 결과가 다를 수 있다.
- mock MCP·상태 있는 가짜 도구, CI 게이트, A/A 대량 반복(A/A arm은 하나), holdout, 결과 캐시는 없다. 강의(고도화판)에서 다룬다.
- judge 모델이 바뀌면 `skill-eval grade`로 다시 채점하고 결과를 비교한다.

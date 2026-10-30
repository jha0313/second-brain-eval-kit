# skill-eval

스킬 비교 eval 하네스입니다. 쓰는 순서와 규칙은 [SKILL.md](SKILL.md)에 있습니다.

## 세미나 이후 바뀐 동작

세미나 숫자는 태그 `seminar-2026-10-31`(채점 버전 grading-v1)로 잰 값입니다. 아래 변경 뒤에 그 run을 다시 채점하지 않았습니다.

**채점 (grading-v2, judge-v4)**
- 인용은 한 가지 규칙으로 읽습니다. `cites_exist`·`sources_hit`·judge 발췌가 같은 규칙을 씁니다.
  - 줄여 쓴 경로가 파일 하나만 가리키면 전체 경로로 봅니다(`job-failure.ts:2` → `pipeline/job-failure.ts`).
  - 여러 파일을 가리킬 수 있는 이름은 "있다"로만 셉니다. 정답 출처로는 세지 않습니다.
  - 이름 일부(`failure.ts`)는 다른 파일(`job-failure.ts`)과 맞추지 않습니다.
- 줄 범위는 `1 ≤ 시작 ≤ 끝 ≤ 파일 길이`일 때만 받습니다. `a.ts:3:7`은 3번째 줄 7번째 칸입니다.
- `cites_exist` 실패에는 사유가 붙습니다: `not_a_commit`(repo 글에 있는 SHA인지 함께 기록), `deleted_file`, `no_such_file`, `bad_line_range`. 통과·실패 판정은 사유와 상관없이 같습니다.
- judge 표가 깨지면(grader_error) 그 표는 FAIL로 세지 않습니다. 유효한 표가 과반이 안 되면 trial을 0점이 아니라 제외(infra_error)로 기록합니다.
- 채점 버전은 `FROZEN.json`과 `results.json`에 적힙니다.
  - 옛 버전으로 고정한 suite는 `run`이 거부합니다.
  - 옛 버전으로 채점된 run은 `grade --new-grading`을 줄 때만 다시 채점합니다.

**실행**
- `FROZEN.json`이 없으면 `run`이 시작하지 않습니다. dev run에만 `--dev`(옛 이름 `--unfrozen`)를 씁니다.
- arm마다 trial 하나(canary)를 먼저 돌립니다. canary에서 권한 거부·채점기 예외·infra 오류가 나오면 나머지 trial을 돌리지 않습니다.
- canary 뒤에는 이렇게 멈춥니다.
  - 채점기 예외나 격리 오류가 나오면 바로 멈춥니다.
  - 권한 거부가 있는 trial이 `--stop-after-denials N`(기본 3, 0이면 멈추지 않음)개가 되면 멈춥니다.
  - 남은 trial은 `skipped_stopped`로 남기고, 멈춘 이유는 `meta.stopped`에 적습니다. `results.json`은 그래도 씁니다.
- `--no-canary`로 canary를 끌 수 있습니다.
- 비용은 재시도한 시도까지 모두 더합니다.
  - agent 시도는 `metrics.attempts`에 하나씩 남습니다. 결과 줄이 없는 시도는 $0으로 치지 않고 `cost_unknown_attempts`로 셉니다.
  - judge 재시도 비용도 더합니다.
- 계획한 반복 중 일부가 제외된 칸은 pass@k·pass^k를 N/A로 둡니다.

**점검과 보고서**
- `skill-eval keycheck SUITE`($0)는 정답표가 그 커밋의 실제 파일·줄·커밋을 가리키는지, 채우지 않은 `<…>` 자리가 없는지 봅니다. `freeze`는 keycheck가 실패하면 고정하지 않습니다.
- `repo.commit`이 SHA가 아니면 suite를 읽을 때 바로 멈춥니다.
- YAML 케이스의 `sources_hit.key`는 케이스 파일 기준 경로로 읽습니다.
- `scorecard.html`과 `summary.txt`에 세 가지가 더해졌습니다.
  - 실패 원인 표: arm별 trial 수, trial마다 원인 하나.
  - 권한 거부가 있던 trial 수와 judge 표가 갈린(예: 2:1) trial 수.
  - 비교마다 검출력 한 줄: 이 케이스 수로 80% 확률로 검출할 수 있는 차이의 어림값과, Δ 0.05를 잡는 데 필요한 가족 수.
  - 판정 문장("차이를 검출하지 못함")은 그대로입니다.

## 테스트

```bash
uv run --with pytest pytest tests      # 모델 호출 없음
```

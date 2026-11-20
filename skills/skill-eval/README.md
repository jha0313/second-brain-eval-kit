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
- `grade`는 채점기 탓으로 제외된 trial(judge 표가 깨졌거나 체크가 예외를 낸 trial)도 다시 채점합니다.
  - 실행 때 기록한 게이트(infra·격리·정답 파일 접근·제한)를 runner와 같은 순서로 먼저 적용합니다. 격리가 깨진 trial은 PASS가 되지 않고 `isolation_error`가 됩니다.
  - 체크가 예외를 낸 trial 중 게이트 기록(`gate_inputs`)이 없는 옛 trial은 복구하지 않습니다. judge 표만 깨진 trial은 게이트를 이미 통과했으므로 옛 trial도 복구합니다.
  - `--no-judge` 재채점에서는 복구하지 않습니다.

**실행**
- `FROZEN.json`이 없으면 `run`이 시작하지 않습니다. dev run에만 `--dev`(옛 이름 `--unfrozen`)를 씁니다.
- arm마다 trial 하나(canary)를 먼저 돌립니다. canary에서 권한 거부·채점기 예외·infra 오류가 나오면 나머지 trial을 돌리지 않습니다.
- canary 뒤에는 이렇게 멈춥니다.
  - 채점기 예외나 격리 오류가 나오면 바로 멈춥니다.
  - 권한 거부가 있는 trial이 `--stop-after-denials N`(기본 3, 0이면 멈추지 않음)개가 되면 멈춥니다.
  - 남은 trial은 `skipped_stopped`로 남기고, 멈춘 이유는 `meta.stopped`에 적습니다. `results.json`은 그래도 씁니다.
  - N 값은 `meta.stop_after_denials`에 적힙니다. 이 정지 규칙은 `FROZEN.json`의 `stop_rule`에도 들어갑니다.
  - trial 시작과 멈춤 결정은 같은 lock 안에서 정합니다. 멈추기 전에 시작한 trial은 끝까지 돌고 `meta.stopped_in_flight`에 적힙니다. 멈춘 뒤에는 새 trial을 시작하지 않습니다.
- `--no-canary`로 canary를 끌 수 있습니다.
- 비용은 재시도한 시도까지 모두 더합니다.
  - agent 시도는 `metrics.attempts`에 하나씩 남습니다. 결과 줄이 없는 시도는 $0으로 치지 않고 `cost_unknown_attempts`로 셉니다. 그런 시도가 있으면 보고서 금액은 `≥$X`(확인된 비용 이상)로 나옵니다.
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

## Phase 1(GitHub 기억) eval을 위한 변경

자세한 형식은 [SKILL.md](SKILL.md)에 있습니다. 이 기능을 쓰지 않는 suite는 전과 같이 채점됩니다. 다만 채점 버전은 grading-v3입니다. v3부터는 prepare가 만든 파일(`prepare_outputs`)을 가리킨 경로를 인용으로 세지 않기 때문에, 그런 suite는 다시 동결해야 합니다.

- **arm별 prepare 출력.** arm에 `outputs`·`env`를 쓰면 그 arm만 그 파일을 받고, 그 arm만 그 환경변수를 받습니다. prepare는 스킬 arm마다 `SKILL_DIR_<ARM>`을 받습니다. arm별 복사본 해시는 `meta.index.arm_files`에 남고, 복사본마다 빌드한 파일과 해시를 맞춰 봅니다.
- **GitHub 증거 채점.** 정답 출처에 `{"ptr": "pr:123"}`를 쓸 수 있습니다. `#123`·`PR #123`·`pull/123`·URL·앵커처럼 같은 항목을 가리키는 형식을 모두 맞다고 봅니다. suite의 `github_evidence`(동결 코퍼스의 유효 포인터 색인)가 있으면 색인에 없는 GitHub 인용은 없는 파일처럼 잘못된 인용입니다. 색인에 `paths`·`commits`가 있으면 repo에는 없지만 코퍼스가 이름을 댄 경로·커밋(머지되지 않은 PR의 파일, PR head SHA)은 GitHub 근거로, 맞지도 틀리지도 않은 것으로 봅니다(grading-v3). prepare가 만든 파일(`prepare_outputs`)을 가리킨 경로는 인용이 아닙니다.
- **자격 증명 격리.** trial에는 빈 `GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`가 들어가고, `GH_*`·`GITHUB_*` 변수는 넘어가지 않습니다. 호스트의 자격 증명 파일(`~/.config/gh`·`~/.git-credentials`·`~/.config/git/credentials`·`~/.netrc`·`~/.ssh`, 그리고 호스트의 `GH_CONFIG_DIR`·`XDG_CONFIG_HOME`이 가리키는 gh·git 설정 위치)은 Read·Edit deny(따라서 Bash sandbox 읽기 금지)입니다. probe가 같은 env에서 `gh auth token`·`git credential fill`·자격 증명 파일 바이트 수·env 변수 이름을 확인합니다. `run`은 trial 전에 probe를 돌리고, 실패하면 trial을 하나도 돌리지 않습니다(`--skip-probe`는 `--dev`에서만). 저장되는 trial 파일에서 GitHub 토큰 모양 문자열은 지웁니다.
- **안전 케이스.** `canary`·`expose_marker`가 있는 케이스는 노출·시도·위반을 세고, 성공률 평균과 비교에서 빼고 따로 보고합니다.

## probe 판정과 실행 잠금

- **항목 표 하나.** probe의 공격 항목 24개는 표 하나에서 id·프롬프트·판정 규칙이 함께 나옵니다. 같은 id가 두 번 나오면 시작하지 않습니다.
- **결과가 있어야 PASS.** 항목마다 맞는 tool call이 있고, 그 결과를 읽을 수 있어야 합니다. Bash 항목은 프롬프트의 명령을 그대로 돌려야 PASS입니다. 접근의 증거(0이 아닌 숫자·HTTP 상태·유출)는 어느 call에서 나와도 FAIL입니다. 예전에는 curl이 돌지 않았거나 200이 아닌 응답이 와도 네트워크가 PASS였습니다. 지금은 curl이 연결 단계에서 막혀야 PASS입니다. HTTP 상태가 오면(403·404 포함) FAIL입니다. workspace 밖 쓰기도 시도가 있고 거부되어야 PASS입니다.
- **빠진 항목만 다시 묻기.** 모델이 건너뛴 항목은 그 id만 최대 2번 더 묻습니다. 모든 시도는 `probe.json`에 남습니다. 유출(정답 canary·CLAUDE.md 줄·토큰·옆 workspace 이름)이나 FAIL이 보이면 다시 묻지 않고 바로 FAIL입니다.
- **격리 경계.** 자격 증명·금지 파일·네트워크는 trial의 실제 도구로만 확인합니다. 호스트에서 띄운 프로세스는 sandbox 밖이고 env에 토큰이 있어서 대신할 수 없습니다. 호스트 쪽 확인은 trial env를 만드는 방식(변수 이름, 새 빈 설정 폴더)에만 씁니다. 실제 `HOME`은 그대로이고, 권한 allow 목록은 격리 경계가 아닙니다(자세한 것은 SKILL.md "격리").
- **실행 잠금.** `run`은 probe 전에 `~/.cache/skill-eval/run.lock`을 잡습니다. 다른 `run`이 돌고 있으면 그 pid와 시작 시각을 알려 주고 바로 멈춥니다. 잠금은 프로세스가 끝나거나 죽으면 풀립니다. trial의 `claude`는 `run`과 같은 프로세스 그룹에서 돌아서, 터미널의 Ctrl-C는 둘 다 멈춥니다. `run`만 `kill -9`로 죽였다면 잠금은 풀려도 돌던 `claude`는 끝까지 돌 수 있으니, 다음 `run` 전에 그것도 멈추세요(`pkill -P <run의 pid>`). `probe`·`report`는 잠금을 잡지 않습니다. 메모리 압력이 높으면 경고만 합니다.
- **끝나지 않은 run 세기.** `results.json` 없이 멈춘 run, 아직 도는 run, 또는 `results.json`이 이전 run의 것일 때는 `skill-eval report RUN_DIR`가 `plan.json`과 `trials/*/grade.json`으로 끝난 trial 수, arm별 통과 수, 끝난 trial의 기록된 비용을 보여 줍니다. 이 비용에 probe와 돌던 trial은 들어가지 않습니다. pass^k와 비교는 끝난 run에서만 나옵니다.

## 테스트

```bash
uv run --with pytest pytest tests      # 모델 호출 없음
```

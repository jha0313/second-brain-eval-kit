# Phase 1–3 검증 보고 (공개본)

codebase-brain에 GitHub 기억(Phase 1), 팀이 같이 읽는 서버(Phase 2), 자동 갱신(Phase 3)을 더하고 각각 어떻게 검증했는지 정리한 보고서입니다.

- 슬라이드: [verification-deck.html](verification-deck.html) (내려받아 브라우저로 엽니다. ←/→ 이동, G 전체 보기)
- 설계서: [Phase 1](../phase1-design.md) · [Phase 1 구현 계획](../phase1-impl-plan.md) · [Phase 2](../phase2-design.md) ([HTML](../phase2-design.html)) · [Phase 3](../phase3-design.md) ([HTML](../phase3-design.html))

측정은 비공개 서비스 repo 하나(TypeScript, 코드 파일 약 4,600개, PR 791 · 이슈 526)와, Phase 3은 공개 repo 사본(shadcn-ui/ui @shadcn@4.23.0, 파일 6,508개)으로 했습니다. 측정 케이스 · 정답 · 실행 기록에는 서비스 repo의 데이터가 들어 있어서 이 공개본에 넣지 않았습니다. 아래 숫자는 그 기록에서 옮겼습니다.

## 한눈에

| 영역 | 판정 | 핵심 수치 |
|---|---|---|
| Phase 1 GitHub 기억 | 충족 | 사전 등록 held-out: "왜" 질문 통과율 0.10 → 0.69 (+0.60, 95% CI +0.42 … +0.76) |
| Phase 2 팀 서버 (Neon) | 일부 미달 | 기준 7개 중 5개 충족. 검색 순위 동등성(기준 3)과 agent 정확도(기준 7, −0.10)가 미달 |
| Phase 3 자동 갱신 | 대부분 충족 | dispatch → publish p95 75.9 s (기준 600 s). 실패 주입 28/28 (최종 코드에서 다시 돌림) |
| 실제 개발 trial | 효과 없음 → 스킬 설명 고침 | 처음 스킬을 연 것은 4번 중 1번. 고친 뒤 2번 (대조군을 빼면 3번 중 2번) |

**권장:** 혼자 쓰거나 답의 정확도가 중요하면 로컬 모드(`brain sync` + 로컬 SQLite)를 씁니다. 서버 모드는 여러 사람이 같은 brain을 읽어야 할 때 씁니다. 이유는 아래 Phase 2에 있습니다.

## 검증 방법: 네 층

| 층 | 무엇 | 어디서 |
|---|---|---|
| 단위 · offline | 가짜 GitHub, 가짜 시계, golden 파일 | `npm test`, `test:security`, `test:phase3`, `test:pg` (offline 부분) |
| 실제 Postgres | Neon 임시 branch를 suite마다 만들고 지움 | `test:pg`, `test:phase3` (Neon), `test/pg/faults.mjs` |
| 실제 repo · 실제 Actions | 서비스 repo 수집, 공개 repo 사본에서 GitHub Actions | 비공개 기록 |
| agent eval | 격리된 `claude -p` trial, 하드 체크 + judge 3표, 사전 등록 | [skills/skill-eval](../../skills/skill-eval) |

최종 코드(main)에서 다시 돌린 결과:

| suite | 결과 |
|---|---|
| `npm test` | 31 checks + 185 pass, 0 fail |
| `npm run test:security` | 47 pass |
| `test:phase3` offline | 105 pass + 2 skip |
| `test:pg` offline | 58 pass + 65 skip (Neon 필요분) |
| skill-eval `pytest` | 150 pass |
| `test/pg/faults.mjs ci` (Neon) | 28/28 pass: roundtrip 1 · ci F2–F15 20 · A5 skip 7 (약 6분) |

## Phase 1: GitHub 기억

`brain sync`가 PR · 리뷰 · 리뷰 코멘트 · 이슈를 로컬 SQLite로 모읍니다. GitHub에는 GET만 합니다. 저장 전에 비밀을 `[REDACTED:<kind>]`로 바꾸고, 본문은 "untrusted quote" 틀 안에서만 보여 줍니다. cursor는 수집이 다 성공한 뒤에만 움직입니다.

**실제 repo 수집:** 3,743개 항목, 13분 18초, 요청 1,667개 (모두 GET). 마스킹 안 된 비밀 0개.

**held-out eval** (사전 등록, k=3, 262 trial 채점, agent claude-sonnet-5-5, judge claude-opus-5-5 × 3)

| arm | 내용 |
|---|---|
| none | 스킬 없음 |
| v1 | Phase 0 스킬 (코드 지도 + 문서 · 커밋 기억) |
| dump | v1 + 같은 GitHub 데이터를 JSON 파일로 |
| v2 | Phase 1 스킬 (같은 데이터를 DB와 명령으로) |

| 비교 | Δ | 95% CI | 판정 |
|---|---|---|---|
| v2 − none (주 지표) | +0.60 | +0.42 … +0.76 | 효과 있음 |
| v2 − dump | −0.07 | −0.24 … +0.14 | 차이 검출 못 함 |

질문 예: "프레임워크 메이저 버전 업그레이드를 전에 시도한 적이 있나? 왜 안 했고, 다시 하려면 무엇을 조심해야 하나? 근거 PR · 이슈 · 댓글도." 질문은 6종입니다: 기각된 대안, 리뷰 반대 의견, 이슈 경위, 열린 PR 충돌, 대조(코드로 답함), 인젝션.

효과는 "GitHub 기록에 닿는 것"에서 왔습니다. 같은 데이터를 JSON으로 준 dump와 정확도 차이는 보이지 않았습니다. v2가 나은 점은 속도(28 s 대 39 s)와 도구 호출 수(5.9 대 7.9)입니다. 심어 둔 지시문은 12/12 trial에서 읽고 한 번도 따르지 않았습니다.

## Phase 2: 팀이 같이 읽는 brain (Neon Postgres)

쓰기는 CI의 `brain_writer` 하나입니다. 노트북은 `brain_reader`(SELECT만)로 mirror를 받거나 직접 읽습니다. 항목은 revision으로만 쌓이고, 이력 보호는 DB trigger가 합니다.

| 기준 | 판정 | 근거 |
|---|---|---|
| 1 첫 publish | 측정 | 빈 서버 bootstrap 54.6 s, 도메인 행 283,659개 |
| 2 지도 동등성 | 충족 | 10쌍 모두 187/187 같음 |
| 3 기억 검색 동등성 | 미달 | hit@3 로컬 20 · 서버 19 |
| 4 권한 | 충족 | 검사 78개, 실패 0 |
| 5 지연 | 충족 | 서버 CLI p95 1,176 ms (기준 1.5 s), 잠든 compute 최대 4.27 s (기준 5 s) |
| 6 전송량 | 충족 | 팀 10명 월 1.25 GB (Free 5 GB의 25%) |
| 7 agent 정확도 (사전 등록, 324 trial) | 미달 | 서버 − 로컬 −0.099 (95% CI −0.172 … −0.042), 기준은 하한 > −0.10 |

**원인 (사후 진단):** 두 모드가 찾는 후보는 같습니다. 순서를 매기는 함수가 다릅니다. 로컬은 SQLite FTS5 `bm25`, 서버는 Postgres `ts_rank`(IDF와 길이 정규화 없음)입니다. 질의 때 계산하는 SQL BM25로 순위를 로컬과 똑같이 만들 수 있지만, p95가 1.9 s라 지연 기준을 넘습니다. 다음 단계는 publish 때 문서 길이와 df를 미리 계산하는 BM25입니다. 또 서버 모드는 스킬을 열지 않으면 GitHub 기억에 닿을 길이 없습니다(로컬 모드는 작업 폴더의 DB 파일로 닿습니다).

## Phase 3: 자동 갱신 (GitHub Actions)

`brain-publish.yml`(매일 + dispatch, main에서만)이 `brain ci-publish`를 한 번 돌립니다. 단계는 prepare → record → mirror → build → sync → outbound 검사 → publish(트랜잭션 하나) → verify이고, 단계마다 시간 상한이 있습니다. 어느 단계에서 실패해도 데이터는 마지막 성공 run 그대로입니다. 노트북은 모든 답의 footer에서 낡음을 보고, 낡았으면 `brain refresh`로 다시 dispatch합니다.

| 시나리오 (공개 repo 사본, 실제 Actions) | 판정 | 결과 |
|---|---|---|
| T1 dispatch 20회 | 충족 | dispatch → publish p50 67.4 s · p95 75.9 s |
| P1 같은 커밋 두 번 | 충족 | 도메인 행 0개 변경 |
| P5 비밀 | 충족 | 심은 needle 76개: DB 120,180행 · job log 1.3 MB에서 0번 |
| P6 노트북 2대에서 refresh 5개 동시 | 충족 | dispatch 2번, publish 1번 |
| P10 main force-push | 동작 충족 | 아무것도 안 씀. 안내 문구는 뒤에 고침 |
| P21 낡은 brain에서 agent | 1/3 | 시스템 프롬프트 한 줄을 넣은 경우만 refresh 후 맞게 답함 |
| P16 · P17 토큰 경계 | 안 함 | 읽기 전용 fine-grained PAT 필요 |
| P20 cron schedule | 미확인 | 6 슬롯 동안 schedule run 0번 (dispatch는 정상) |

**실패 주입** (`test/pg/faults.mjs`): 실제 `ci-publish`를 child로 띄우고 단계마다 `BRAIN_FAULT=<stage>:<point>`로 일부러 실패시킵니다. 실패 직후 branch dump가 한 행도 바뀌면 안 되고, 다음 정상 run 뒤 dump는 실패가 없었던 경우와 같아야 합니다. 최종 코드(main)에서 2026-11-18에 다시 돌려 28개 모두 통과했습니다: roundtrip 1, ci 20(F2 mirror 연결 · checksum, F3 build 실패 · 시간 초과, F4 · F5 GitHub 500 · rate limit, F6 나갈 행의 비밀, F7 publish 중간 4곳, F8 트랜잭션 중 kill, F9 COMMIT 전 연결 끊김, F10 COMMIT 응답 유실, F11 · F12 lock · 시간 초과, F13 취소, F14 COMMIT 뒤 kill, F15 base 경쟁), A5 skip 7.

## 실제 개발 trial: 백로그 과제 4개

서비스 repo 백로그에서 brain이 차이를 낼 만한 과제 4개를 골랐습니다. 프롬프트는 백로그 원문과 작업 조건이고, brain 이름은 쓰지 않았습니다. 격리 clone(네트워크 · GitHub 인증 없음, push 막음), claude-opus-5-5, 과제 · arm마다 1회(k=1)입니다. 통계가 아니라 사례입니다.

| 과제 | 종류 | 처음 (스킬 이전 설명) | before vs after |
|---|---|---|---|
| A | 관리자 전용 경로의 출시 결정 (관련 이슈 4개) | 스킬 열림, brain 2회 | 결정 같음. 닫힌 이슈를 진행 중으로 읽음 |
| B | 죽은 서버 액션 제거 + 소유자 범위 | 안 열림 | 같은 소스 17개 수정 |
| C | 잘못된 세션 쿠키 → 500 대신 로그인 | 안 열림 | 같은 방향으로 고침 |
| D | 헬스체크 비밀값 분리 (대조군, env 변수) | 안 열림 | 같은 파일 12개 수정 |

결과가 거의 같았던 가장 큰 원인은 검색 품질이 아니라 **routing**이었습니다. "구현해", "지워"를 받은 agent는 grep과 테스트로 바로 갔고, "누가 이미 하고 있나"를 스스로 묻지 않았습니다. 과제 A에서 찾은 제품 버그(`brain source` 머리말에 이슈 state가 없음)는 고쳤습니다.

### 고친 것과 다시 잰 결과

SKILL.md 설명을 "공유 코드를 바꾸기 전에 먼저 본다"로 바꾸고, "Before you change shared code" 절(호출자 → 그 파일의 열린 PR · 이슈 → 전의 결정, 작업 지시가 "진행 중"이라 부르는 PR · 이슈는 `brain get`으로 확인)을 넣었습니다. [skills/codebase-brain/README.md](../../skills/codebase-brain/README.md)의 "작업 전에 brain을 보게 하기"에 대상 repo의 CLAUDE.md에 넣을 한 줄도 있습니다.

같은 과제 4개를 after arm으로 다시 돌렸습니다(k=1, 로컬 모드).

| 과제 | 전 | 후 | 후: brain으로 한 것 |
|---|---|---|---|
| A 출시 결정 | 열림 | 열림 | `brain get` × 4로 두 이슈가 이미 closed임을 확인하고, 작업 지시와 다르다고 보고 |
| B 죽은 서버 액션 제거 | 안 열림 | **열림** | `callers` · `refs`로 호출처 13곳(coverage complete), `impact --filter test --list`로 돌릴 테스트를 고름 |
| C 세션 쿠키 | 안 열림 | 안 열림 | — |
| D 비밀값 분리 (대조군) | 안 열림 | 안 열림 | 의도대로: env 변수는 grep |

- 스킬 로드 **1/4 → 2/4**. 4개 모두 tsc와 관련 테스트를 통과했고, 비용은 4 trial에 $5.74입니다.
- B의 호출처 13곳은 before arm이 grep으로 찾은 것과 같습니다. 결과의 질이 더 좋아졌다는 근거는 아닙니다. A는 이번에는 이슈 상태를 맞게 읽었습니다.
- 주의: k=1이고, 스킬 설명과 함께 읽기 모드도 서버에서 로컬로 바뀌었습니다. 작은 단일 파일 과제에서 스킬이 과하게 열리는지는 따로 재지 않았습니다.
- 교훈: 스킬 설명은 질문("which files import X")만이 아니라 작업("지워", "고쳐", "구현해")으로도 써야 열립니다.

## 한계

- 서비스 repo 하나, agent 모델 하나에서 잰 값입니다. 다른 repo로 넓혀 말할 수 없습니다.
- 개발 trial은 k=1이고, before arm에는 네트워크와 `gh`가 없습니다. 실제 개발 환경보다 약한 비교군이라 비교가 brain 쪽으로 기웁니다.
- Phase 3의 토큰 경계(P16 · P17)와 실제 cron schedule은 확인하지 못했습니다.
- 서버 모드의 검색 순위는 로컬과 다릅니다. 위 권장을 따르세요.

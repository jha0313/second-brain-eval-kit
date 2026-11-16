# codebase-brain — 코딩 에이전트용 지도(코드 그래프)와 코드 메모리 · 프로토타입

큰 코드베이스에서 에이전트가 grep으로 헤매는 두 종류의 질문을 한두 번 호출로 답합니다.

- **지도:** "X를 쓰는 곳 전부", "X를 바꾸면 어디가 영향받을 수 있나", "어떤 page·route·test가 X에 기대나". TypeScript 컴파일러가 만든 사실(import·호출·렌더·타입·상속 엣지)로 답하고, 모든 답에 `coverage` 플래그를 붙입니다.
- **코드 메모리:** "왜 이렇게 만들었나", "전에 뭐가 깨졌나". 문서·`changes/`·CHANGELOG·커밋 메시지(PR 번호)·Obsidian vault를 SQLite FTS5로 찾고, 문서↔코드↔커밋 링크를 한 hop 걸어 `파일:줄`·커밋 SHA 인용을 돌려줍니다. LLM을 부르지 않습니다(FAST).
- **GitHub 메모리 (Phase 1):** `brain sync`가 PR·리뷰·인라인 리뷰 댓글·이슈·이슈 댓글을 로컬 SQLite(`github.db`)에 모으고, 본문에 나온 파일·심볼·커밋·PR 언급을 지금 인덱스에 이어 둡니다. `brain search`·`get`·`source`가 포인터 → 메타·스레드·링크 → 원문 순서로 꺼내 줍니다.

프로토타입입니다. 강의에서 훨씬 더 고도화된 버전을 보여 드릴 예정입니다.

## 설치

```bash
git clone https://github.com/jha0313/second-brain-eval-kit
mkdir -p ~/.claude/skills                                                # 폴더가 없으면 cp가 이름을 바꿔 복사함
cp -r second-brain-eval-kit/skills/codebase-brain ~/.claude/skills/     # 또는 프로젝트의 .claude/skills/
cd ~/.claude/skills/codebase-brain && npm install                        # typescript 하나. Node 22.13 이상
export PATH="$HOME/.claude/skills/codebase-brain/bin:$PATH"
cd /path/to/repo && brain build . --if-stale                             # 대상 repo에는 아무것도 쓰지 않음
```

쿼리는 지금 있는 git repo의 인덱스를 씁니다(`--repo DIR`로 바꿈). 그래서 빌드한 repo 안에서 부릅니다. 인덱스는 `~/.cache/codebase-brain/<repo 경로 해시>.db`에 생깁니다. `--db` 또는 `BRAIN_DB`로 바꿀 수 있습니다. vault를 같이 넣으려면 `--vault <dir>`(커밋 날짜보다 나중에 생긴 노트는 넣지 않음).

## 명령

| 명령 | 하는 일 |
|---|---|
| `brain build <repo> [--if-stale]` | 인덱스 만들기. `--if-stale`: 같은 repo·같은 빌드 옵션의 인덱스가 아직 맞으면 건너뜀. `--vault`를 주면 늘 다시 빌드(vault는 git 밖이라 바뀌었는지 모름) |
| `brain status` | 인덱스 커밋·나이, HEAD 이후 바뀐 파일, 미해결 import, 이름 연결에서 뺀 이름 수. server mode에서는 run·커밋·GitHub 상태와 낡음 네 칸(code · memory · activity · last) |
| `brain find <이름>` | 심볼·파일 → ID(`path#Name`) |
| `brain refs <ID>` | 사용 위치 전부 (`--kind call,renders,type…`, `--filter page,route,test,server-action`, `--files`) |
| `brain callers <ID>` | 호출·렌더 위치를 감싼 함수별로 |
| `brain impact <ID>` | 역방향 BFS: 영향받을 수 있는 파일을 hop별로, 테스트 수 포함 (`--list`, `--no-mocks`, `--no-types`) |
| `brain deps <ID>` · `brain shared <A> <B>` | 앞방향 폐포 · 두 트리가 같이 기대는 파일 |
| `brain why "<질문>"` | 인용 묶음 (BM25 + 한국어 trigram + 이름→코드 링크 + 문서→커밋 hop) |
| `brain viz <ID> --out graph.html` | 2-hop 그래프(엣지 종류·방향, 안 그린 파일 수 표시) + 전체 hop 표 + why 패널, 단일 HTML (CDN 없음, 오프라인, 라이트·다크) |
| `brain sync [--full]` | `origin`의 GitHub 항목을 `github.db`로 모음. 처음엔 전부, 다음부터 바뀐 것만(서버 시각 cursor − 1시간). `--full`은 새 파일에 다 받은 뒤에만 바꿔 끼움. `--request-timeout S`(기본 60) · `--max-rate-wait S`(기본 3600) |
| `brain search "<질문>"` | PR·이슈·리뷰·댓글·문서·changes·커밋을 한 목록으로(BM25 + trigram + 이름→코드 링크, RRF). 댓글은 부모 PR·이슈로 묶음. `--kind`·`--state open,merged,closed-unmerged,closed`·`--path`·`--author`·`--since` |
| `brain get <ptr>…` | 포인터(`pr:12`·`issue:7`·`review:9`·`rc:88`·`ic:5`·`commit:<sha>`·`doc:…`)마다 메타·스레드·코드 링크 상태(본문 없음, 최대 5개) |
| `brain source <ptr>` | 저장된 원문을 `quote … untrusted` 봉투에 담아 (`--from N`·`--lines N`, 기본 200줄) |
| `brain refresh [--wait]` | server mode: 팀 brain이 낡았으면 운영 repo의 `brain-publish`를 dispatch하고 한 호출에 80초까지 기다림. exit 0 fresh · 75 아직 도는 중 · 1 실패 · 2 불가 (아래 "팀 brain 읽기와 refresh") |
| `brain ci-publish` | CI 전용: `brain-publish.yml` · `brain-bootstrap.yml`의 publish 단계 (`--source DIR --mirror DIR [--full] [--mode normal\|bootstrap]`) |

모든 명령에 `--json`이 있습니다. 라우팅 규칙(언제 무엇을 부르고, 언제 부르지 않나)은 [SKILL.md](SKILL.md)에 있습니다.

## 세미나(2026-10-31) 뒤 바뀐 동작

- **freshness:** 모든 JSON 답에 `freshness`(`state: fresh | stale`, commit·HEAD·바뀐 파일)가 `coverage` 옆에 붙습니다. `complete`(다 찾았다)와 `fresh`(지금 코드와 맞다)는 다른 사실입니다. 일반 출력의 why·find에도 `stale:` 줄이 나오고, 바뀐 파일을 앞 5개까지 이름으로 보여 줍니다. 빌드할 때 커밋 안 한 파일의 내용 해시를 적어 두므로, 인덱스가 이미 읽은 수정은 "바뀜"으로 세지 않습니다.
- **why 인용 표시:** 인용된 글에 커밋이 아닌 SHA 모양 문자열(빌드·배포 ID)이나 지금 트리에 없는 파일이 있으면 `(not a commit)`·`(not in the tree)`로 표시합니다(JSON: `notCommits`·`notInTree`). 인용한 문서 자체가 지금 없으면(추적·디스크 둘 다 봄) `inTree: false`와 경고 줄이 나옵니다. 순위는 그대로입니다.
- **route 안내:** import하는 파일이 없는 Next.js route 파일의 `impact`는 0 대신 "URL로 불림 → grep \"/api/…\"" 안내(`hint`)를 냅니다.
- **버그 수정:** 표가 긴 경로를 자르지 않습니다(따로 한 줄). `refs --files --json`은 파일당 한 줄입니다. `deps <심볼 ID>`는 그 심볼이 있는 파일에서 시작합니다(전에는 조용히 0).
- **이름 연결 규칙:** "같은 이름의 export가 1–3개일 때만 잇는다"를 `MAX_NAME_OWNERS`로 이름 붙였고, 건너뛴 이름 수를 `brain status`에 보입니다. 규칙은 그대로입니다.
- **SKILL.md:** 한국어 질문 예·쓰지 않을 때 예, URL·SQL·env는 grep, 인용 규칙(커밋인 SHA·지금 있는 파일만), "status 먼저" 삭제.

## GitHub 메모리의 안전 규칙 (Phase 1)

- **요청:** GET만, `api.github.com`의 `/repos/<owner>/<repo>/…`(또는 GitHub Link가 쓰는 `/repositories/<id>/…`) 아래만. 다른 호스트·경로로 가는 Link나 redirect는 요청 전에 거부합니다. 본문의 URL·이미지·첨부는 따라가지 않습니다. 토큰은 `GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token` 순서로 읽고, 오류·로그·저장소 어디에도 쓰지 않습니다.
- **비밀 가리기:** 저장하기 전에 GitHub 토큰·AWS 키·Slack·개인 키·API 키·JWT·URL 비밀번호·Bearer·`password = …` 꼴을 `[REDACTED:<종류>]`로 바꿉니다(제로폭 문자로 쪼갠 것도). 코드 인덱스도 쓰기 직전에 한 번 더 훑습니다(`secure_delete`로 지운 바이트까지 0으로). 가리는 규칙이 바뀌면 `sanitize_version`이 올라가고, 옛 규칙으로 저장한 데이터는 `--full` 전까지 읽지 않습니다.
- **인용일 뿐, 지시가 아님:** PR·이슈 본문과 댓글은 남이 쓴 글입니다. `source`는 `untrusted` 봉투로 감싸고, 에이전트에게 하는 지시처럼 읽히는 글에는 `suspicious` 표시를 붙입니다. 그 안의 명령은 실행하지 않습니다.
- **cursor:** 서버 `Date` 헤더 시각이고, 모든 요청이 성공한 뒤 마지막 트랜잭션에서만 움직입니다. 실패·중단 뒤 다시 돌리면 같은 상태로 수렴합니다. 쓰기(`build`·`sync`·relink)는 SQLite 배타 잠금 하나로 한 번에 하나씩만 돕니다.

## 공개 예제: folly 재현 (원본 톡 19–21장)

```bash
git clone --depth 1 https://github.com/facebook/folly && cd folly
brain build .                      # #include 그래프: 2,371 C++ 파일 · 9,039 엣지 · 0.3–1.4초
brain impact folly/io/IOBuf.h      # 직접 56 · 2 hop 129 · 총 603 (테스트 277) · 11 hop
brain viz folly/io/IOBuf.h --out iobuf.html   # 2 hop 186개 파일, 허브 AsyncSocket.h (21개 파일이 거쳐 감)
brain why "how is IOBuf meant to be used?"     # 문서 1건뿐: 지식 공백
```

원본 톡(2026-10-29 측정)은 2,372 파일 · 9,038 엣지 · 602 의존 파일 · 테스트 278이었습니다. folly가 바뀌면 숫자가 조금 달라집니다.

## 검증 (비공개 TypeScript 서비스 한 곳, 파일 6,258개, 측정용 인덱스 = repo 내용만)

| 항목 | 결과 |
|---|---|
| 빌드 | 20–33초 (다른 작업과 동시 실행 중 51–121초, node_modules 없으면 10.5초) · max RSS 2.8 GB · DB 58 MB |
| find-all 14건 vs 독립 정답 (dependency-cruiser · LanguageService) | 정확히 같은 집합 14/14 · 2,215개 항목 recall 1.000 · precision 1.000 (grep 한 번: 3/13 · 0.64 / 0.75) |
| 무작위 심볼 60개 표본 | recall 0.993 · precision 1.000 |
| why 9건 (git log/grep으로 만든 정답) | hit@3 9/9 · recall@8 0.97 · 인용 71/71 유효 |
| fixture 테스트 (`npm test`) | 31/31: tsconfig 2개·alias·barrel 재export·동적 import 구조분해·생성 파일·vi.mock·커밋된 node_modules·긴 경로·freshness(한글 파일 이름 포함)·why 인용 표시·route 안내·빌드 옵션 비교 |
| Phase 1 테스트 (`npm test`) | 178/178: GitHub client(재시도·rate limit·timeout·URL 규칙), sync(cursor·멱등·잠금·`--full` 교체), 링크, search·get·source, 그리고 실제 CLI + replay로 실패 시나리오 S1–S10 종단 검사 |
| 보안 테스트 (`npm run test:security`) | 45/45: 비밀 9종을 GitHub·repo 곳곳에 심고 출력·저장 파일 바이트에서 0건, 모든 실패 지점·SIGKILL 뒤에도 0건, 토큰 누출 0건, 인젝션 문구는 인용으로만 |

측정에 쓴 케이스·정답·세부 기록은 비공개 repo의 내용이라 이 공개본에 넣지 않았습니다.

## 공유 brain: publish (Phase 2)

팀이 함께 읽는 brain은 Neon Postgres 하나에 있습니다. 쓰는 곳은 `brain-publish` workflow 하나뿐입니다. workflow가 소스 repo의 `main`을 받아 지도와 기억을 만들고, 바뀐 행만 한 트랜잭션으로 씁니다. 에이전트와 노트북은 읽기 전용 `brain_reader`로만 붙습니다. 설계: [docs/phase2-design.md](../../docs/phase2-design.md) §6.2–6.3.

### 운영 repo 방식 (권장)

소스 repo(서비스)에는 파일도 비밀도 넣지 않습니다. 쓰기 비밀은 별도의 비공개 **운영 repo**에만 둡니다.

1. 운영 repo를 비공개로 만듭니다. 이 kit를 고정한 커밋에서 `skills/codebase-brain/`에 복사하고, workflow 두 개를 복사합니다: `ci/brain-publish.yml` → `.github/workflows/brain-publish.yml`(매일 · dispatch), `ci/brain-bootstrap.yml` → `.github/workflows/brain-bootstrap.yml`(전체 publish, 게이트). 두 파일 안의 `BRAIN_SOURCE_REPO`를 소스 repo(`owner/name`)로 바꿉니다. 소스 repo는 입력으로 받지 않습니다(R1). workflow에는 입력이 없습니다. dispatch 권한으로는 publish 내용을 바꿀 수 없습니다.
2. 쓰기 권한은 관리자만 갖게 합니다. 운영 repo에 push할 수 있는 사람은 workflow를 고쳐 비밀을 꺼낼 수 있기 때문입니다. Actions 설정에서 fork pull request에 secret을 보내는 옵션을 끕니다. workflow에는 `pull_request` trigger가 없습니다.
3. owner가 migration을 돌려 schema와 `brain_writer` · `brain_reader` role을 만듭니다(비밀번호는 migration이 파일에서 읽어 정합니다).
4. 운영 repo의 Actions secret 두 개를 만듭니다.
   - `BRAIN_WRITER_URL`: `brain_writer`의 연결 문자열. direct endpoint(호스트에 `-pooler`가 없는 것)를 씁니다. 이 값은 이곳에만 둡니다.
   - `BRAIN_SOURCE_TOKEN`: 소스 repo만 읽는 fine-grained token(Contents · Pull requests · Issues: read). checkout과 GitHub 수집에 같이 씁니다. `GITHUB_TOKEN`은 다른 비공개 repo를 읽지 못합니다.
5. 첫 publish는 `brain-bootstrap`으로 합니다. 관리자가 게이트를 열고, `main`에서 dispatch하고, gate 단계가 지나면 닫습니다. 게이트는 repo 변수 `BRAIN_BOOTSTRAP_UNTIL`(UTC)이 지금보다 늦고 2시간 이내일 때만 열립니다. 변수를 쓰려면 Variables 쓰기 권한이 필요하고, 에이전트의 dispatch token에는 그 권한이 없습니다.
   ```bash
   gh variable set BRAIN_BOOTSTRAP_UNTIL --repo <운영 repo> --body 2026-01-01T13:00:00Z   # 지금부터 2시간 이내의 UTC 시각
   gh workflow run brain-bootstrap.yml --repo <운영 repo> --ref main
   gh variable delete BRAIN_BOOTSTRAP_UNTIL --repo <운영 repo>                        # gate 단계가 지난 뒤
   ```
   bootstrap은 GitHub를 처음부터 전부 받습니다(PR 1,300개 repo에서 약 2,700 호출, rate limit에 따라 수십 분). job 상한은 360분(publish 단계 350분)이고, 평소 `brain-publish`는 20분입니다. 첫 실행이 데이터베이스를 소스 repo의 숫자 id와 `brain-publish.yml`(refresh가 dispatch하는 workflow)에 묶습니다(`brain.binding`). 그 뒤 다른 repo를 가리키는 실행은 아무것도 쓰지 않습니다(V22). 그다음부터는 `brain-publish`가 매일(19:17 UTC) 돌고, 에이전트의 `brain refresh`가 필요할 때 dispatch합니다. 같은 concurrency group이라 writer는 한 번에 하나만 돕니다.
6. 소스 repo의 `main`을 force-push했거나(마지막 run이 더는 조상이 아님, R9), sanitize 규칙이 바뀐 kit로 올렸으면(R15) 5번처럼 bootstrap을 한 번 더 돌립니다. 돌리지 않으면 `brain-publish`가 거부됩니다.
7. 에이전트(개발자 노트북)에는 두 값만 줍니다. 쓰기 비밀은 주지 않습니다.
   - `BRAIN_READER_URL`: `brain_reader`의 연결 문자열. 환경 변수나 kit의 `.env.local`에 둡니다(`DATABASE_URL`은 읽지 않음).
   - `BRAIN_DISPATCH_TOKEN`: 운영 repo 하나만, Actions: read and write만 가진 fine-grained token(Contents · Secrets · Variables 없음). `brain-publish`를 시작하고 run 상태를 읽을 수 있을 뿐, publish 내용을 바꾸거나 bootstrap 게이트를 열 수 없습니다. 없으면 `brain refresh`는 exit 2로 끝나고, 다른 토큰(`gh auth token` 등)으로 대신하지 않습니다.

publish 단계는 attempt 기록 → mirror 확인(R3) → `brain build` · `brain sync` → delta와 업로드 전 비밀 검사(R16) → 한 트랜잭션입니다. build와 sync는 자식 프로세스에서 돕니다. 자식에게는 `BRAIN_WRITER_URL`을 주지 않습니다. 소스 읽기 token은 sync만 `GH_TOKEN`으로 받습니다. 자식은 `BRAIN_TYPESCRIPT=kit`으로 kit의 TypeScript만 씁니다. 소스 repo에 들어 있는 `typescript`를 부르면 그 repo의 코드가 쓰기 비밀 옆에서 실행되기 때문입니다. 종료 코드(contract `CI_EXIT`): 0 성공(A5로 건너뛴 run 포함), 1 실패(attempt에 단계와 `단계:종류`가 남음, 데이터는 그대로), 2 사용법 오류(시작 전, attempt 없음), 3 확인 실패(데이터는 커밋됨, attempt는 ok), 4 COMMIT 결과를 모름(다시 돌리기 전에 확인).

**V22 확인 (sandbox).** 소스 repo의 아무 브랜치에 아래 workflow를 push하면 값이 비어 있어야 합니다. 소스 repo에는 쓰기 비밀이 없기 때문입니다.

```yaml
# 소스 repo의 브랜치에서만 쓰는 확인용 workflow (확인 뒤 지운다)
on: push
jobs:
  probe:
    runs-on: ubuntu-24.04
    steps:
      - env:
          W: ${{ secrets.BRAIN_WRITER_URL }}
        run: test -z "$W" && echo "no writer secret in the source repo"
```

### 직접 설치 방식

운영 repo 없이 소스 repo 안에 workflow와 kit를 둡니다. 설정은 쉽지만 신뢰 경계가 넓어집니다. 소스 repo의 `main`에 쓸 수 있는 사람과 에이전트는 모두 쓰기 비밀을 꺼낼 수 있습니다.

- `BRAIN_SOURCE_REPO`는 그 repo 자신입니다. 소스 checkout은 하나로 줄이고, `BRAIN_SOURCE_TOKEN` 대신 `github.token`을 쓸 수 있습니다(`permissions`: `contents`, `pull-requests`, `issues` 모두 `read`).
- `BRAIN_WRITER_URL`은 repo secret이 아니라 **environment secret**으로 둡니다. environment(예: `brain`)의 deployment branch를 `main` 하나로 제한하고 job에 `environment: brain`을 붙입니다. repo secret으로 두면 아무 브랜치에 push한 workflow가 읽을 수 있습니다.
- 비공개 repo의 environment는 GitHub Pro · Team · Enterprise에서만 쓸 수 있습니다. environment의 required reviewers는 비공개 repo에서 Enterprise에만 있습니다. Free 플랜의 비공개 repo라면 운영 repo 방식을 쓰세요.
- `main`에 branch protection(리뷰 필수, force-push 금지)을 겁니다. `BRAIN_TYPESCRIPT=kit`은 이 방식에서도 그대로 필요합니다.

## 팀 brain 읽기와 refresh (Phase 3)

server mode의 모든 답 footer는 답이 읽은 run과 그 brain이 `origin`의 `main`보다 얼마나 낡았는지를 보여 줍니다. 설계: [docs/phase3-design.md](../../docs/phase3-design.md) §6.5–6.6.

```text
  freshness: brain data: run 42 @9f3c2e1a (published 3h ago) · 3 commits behind main · github as of 27h ago (stale) · last attempt FAILED 40m ago (sync) · code @9f3c2e1a · HEAD @4d5e6f70 · 3 commits behind
```

- 네 칸: code(`= main` · `N commits behind main` · `differs from main`, `git ls-remote origin`과 로컬 git 객체), memory(`github as of <나이> ago`, 24시간이 넘으면 `(stale)`, 없으면 `github never synced`; 나이는 DB 시계), activity(`refresh queued` · `refresh running`), last(마지막 실행이 실패 · 중단이면 표시). 읽지 못한 칸은 `(freshness unknown)`입니다. 답마다 reader의 SELECT 하나와 `ls-remote` 한 번(8초 상한)을 더 씁니다. Actions API는 `brain status`와 `brain refresh`만 읽습니다.
- `brain refresh`: 이미 fresh(`= main`, 24시간 이내)면 바로 exit 0입니다. 낡았으면 진행 중인 run을 기다리거나 `brain-publish`를 dispatch하고, 서버 상태가 완료 조건(최신 run 커밋 = 확인하는 순간의 `main`, GitHub 시각이 시작 때보다 뒤, 24시간 이내)을 채울 때 exit 0입니다. 어느 Actions run이 publish했는지는 따지지 않습니다. 한 호출은 80초 안에 끝나고(아직이면 exit 75, `brain refresh --wait`로 이어 감), 처음 호출부터 15분이 지나면 exit 1로 멈춥니다. 같은 `main`으로 15분 안에 실패한 run이 있으면 다시 dispatch하지 않습니다(cooldown, exit 1). 이어 받기 상태는 `~/.cache/brain/refresh/<source repo id>.json`(0600, 잠금)에 둡니다. refresh는 brain DB에 쓰지 않습니다.
- SKILL.md 규칙 10: footer에 `behind main` · `differs from main` · `(stale)` · `never synced`가 있으면 refresh 뒤에 답하고, exit 1 · 2면 낡은 데이터라고 사용자에게 밝힙니다.

## 한계

- TS/JS 심볼은 최상위 선언과 클래스 멤버. CommonJS `module.exports` 멤버, JSDoc `{@link}`, CSS·asset은 추적하지 않습니다.
- `obj[name]()`, 문자열로 조립한 import 경로, DI 컨테이너, 설정 파일의 문자열 참조는 정적 그래프에 없습니다.
- C/C++/Python은 파일 단위(`#include`, `import`)만.
- `why`는 키워드·링크 검색입니다. 임베딩과 LLM 재정렬이 없어서, 질문과 단어가 겹치지 않는 문서는 놓칠 수 있습니다.
- `impact`는 import·사용 관계를 거꾸로 따라간 도달 범위입니다. "영향받을 수 있음"이지 "깨짐"의 증명이 아닙니다. Next.js 파일 기반 라우팅, 문자열·`fetch` URL·환경 변수로 이어지는 런타임 연결은 범위 밖입니다.

## 구조

```
bin/brain                 셸 진입점 (node:sqlite 경고 끔)
src/cli.mjs               명령·표 출력
src/build.mjs             인덱서 순서, meta(commit·시간·coverage)
src/index-ts.mjs          TypeScript compiler API 어댑터 (tsconfig 여러 개 → 해석 설정별 program)
src/index-generic.mjs     #include / import 어댑터 (folly)
src/index-knowledge.mjs   문서·CHANGELOG·changes/·git log·vault → FTS5 + 링크
src/query.mjs             find · refs · impact(역방향 BFS) · deps · shared · freshness
src/why.mjs               하이브리드 검색 → RRF → 1 hop → 인용
src/viz.mjs               2-hop 레이아웃(노드 측에서 계산) + HTML
src/gh-client.mjs         GitHub REST (GET만, 재시도·rate limit·timeout·URL 규칙)
src/gh-sync.mjs           sync: cursor·쪽 단위 트랜잭션·--full 교체 · src/gh-schema.mjs  github.db 스키마·쓰기 잠금
src/sanitize.mjs          정규화·비밀 가리기·인젝션 표시·쓰기 직전 훑기
src/link.mjs              GitHub 언급 → 코드 인덱스 링크(relink) · src/read.mjs  search·get·source
test/                     fixture repo + 검사 31개 · phase1/ · security/
```

# codebase-brain — 코딩 에이전트용 지도(코드 그래프)와 코드 메모리 · 프로토타입

큰 코드베이스에서 에이전트가 grep으로 헤매는 두 종류의 질문을 한두 번 호출로 답합니다.

- **지도:** "X를 쓰는 곳 전부", "X를 바꾸면 어디가 영향받을 수 있나", "어떤 page·route·test가 X에 기대나". TypeScript 컴파일러가 만든 사실(import·호출·렌더·타입·상속 엣지)로 답하고, 모든 답에 `coverage` 플래그를 붙입니다.
- **코드 메모리:** "왜 이렇게 만들었나", "전에 뭐가 깨졌나". 문서·`changes/`·CHANGELOG·커밋 메시지(PR 번호)·Obsidian vault를 SQLite FTS5로 찾고, 문서↔코드↔커밋 링크를 한 hop 걸어 `파일:줄`·커밋 SHA 인용을 돌려줍니다. LLM을 부르지 않습니다(FAST).

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
| `brain status` | 인덱스 커밋·나이, HEAD 이후 바뀐 파일, 미해결 import, 이름 연결에서 뺀 이름 수 |
| `brain find <이름>` | 심볼·파일 → ID(`path#Name`) |
| `brain refs <ID>` | 사용 위치 전부 (`--kind call,renders,type…`, `--filter page,route,test,server-action`, `--files`) |
| `brain callers <ID>` | 호출·렌더 위치를 감싼 함수별로 |
| `brain impact <ID>` | 역방향 BFS: 영향받을 수 있는 파일을 hop별로, 테스트 수 포함 (`--list`, `--no-mocks`, `--no-types`) |
| `brain deps <ID>` · `brain shared <A> <B>` | 앞방향 폐포 · 두 트리가 같이 기대는 파일 |
| `brain why "<질문>"` | 인용 묶음 (BM25 + 한국어 trigram + 이름→코드 링크 + 문서→커밋 hop) |
| `brain viz <ID> --out graph.html` | 2-hop 그래프(엣지 종류·방향, 안 그린 파일 수 표시) + 전체 hop 표 + why 패널, 단일 HTML (CDN 없음, 오프라인, 라이트·다크) |

모든 명령에 `--json`이 있습니다. 라우팅 규칙(언제 무엇을 부르고, 언제 부르지 않나)은 [SKILL.md](SKILL.md)에 있습니다.

## 세미나(2026-10-31) 뒤 바뀐 동작

- **freshness:** 모든 JSON 답에 `freshness`(`state: fresh | stale`, commit·HEAD·바뀐 파일)가 `coverage` 옆에 붙습니다. `complete`(다 찾았다)와 `fresh`(지금 코드와 맞다)는 다른 사실입니다. 일반 출력의 why·find에도 `stale:` 줄이 나오고, 바뀐 파일을 앞 5개까지 이름으로 보여 줍니다. 빌드할 때 커밋 안 한 파일의 내용 해시를 적어 두므로, 인덱스가 이미 읽은 수정은 "바뀜"으로 세지 않습니다.
- **why 인용 표시:** 인용된 글에 커밋이 아닌 SHA 모양 문자열(빌드·배포 ID)이나 지금 트리에 없는 파일이 있으면 `(not a commit)`·`(not in the tree)`로 표시합니다(JSON: `notCommits`·`notInTree`). 인용한 문서 자체가 지금 없으면(추적·디스크 둘 다 봄) `inTree: false`와 경고 줄이 나옵니다. 순위는 그대로입니다.
- **route 안내:** import하는 파일이 없는 Next.js route 파일의 `impact`는 0 대신 "URL로 불림 → grep \"/api/…\"" 안내(`hint`)를 냅니다.
- **버그 수정:** 표가 긴 경로를 자르지 않습니다(따로 한 줄). `refs --files --json`은 파일당 한 줄입니다. `deps <심볼 ID>`는 그 심볼이 있는 파일에서 시작합니다(전에는 조용히 0).
- **이름 연결 규칙:** "같은 이름의 export가 1–3개일 때만 잇는다"를 `MAX_NAME_OWNERS`로 이름 붙였고, 건너뛴 이름 수를 `brain status`에 보입니다. 규칙은 그대로입니다.
- **SKILL.md:** 한국어 질문 예·쓰지 않을 때 예, URL·SQL·env는 grep, 인용 규칙(커밋인 SHA·지금 있는 파일만), "status 먼저" 삭제.

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

측정에 쓴 케이스·정답·세부 기록은 비공개 repo의 내용이라 이 공개본에 넣지 않았습니다.

## 공유 brain: publish (Phase 2)

팀이 함께 읽는 brain은 Neon Postgres 하나에 있습니다. 쓰는 곳은 `brain-publish` workflow 하나뿐입니다. workflow가 소스 repo의 `main`을 받아 지도와 기억을 만들고, 바뀐 행만 한 트랜잭션으로 씁니다. 에이전트와 노트북은 읽기 전용 `brain_reader`로만 붙습니다. 설계: [docs/phase2-design.md](../../docs/phase2-design.md) §6.2–6.3.

### 운영 repo 방식 (권장)

소스 repo(서비스)에는 파일도 비밀도 넣지 않습니다. 쓰기 비밀은 별도의 비공개 **운영 repo**에만 둡니다.

1. 운영 repo를 비공개로 만듭니다. 이 kit를 고정한 커밋에서 `skills/codebase-brain/`에 복사하고, `ci/brain-publish.yml`을 `.github/workflows/brain-publish.yml`로 복사합니다. 파일 안의 `BRAIN_SOURCE_REPO`를 소스 repo(`owner/name`)로 바꿉니다. 소스 repo는 입력으로 받지 않습니다(R1).
2. 쓰기 권한은 관리자만 갖게 합니다. 운영 repo에 push할 수 있는 사람은 workflow를 고쳐 비밀을 꺼낼 수 있기 때문입니다. Actions 설정에서 fork pull request에 secret을 보내는 옵션을 끕니다. workflow에는 `pull_request` trigger가 없습니다.
3. owner가 migration을 돌려 schema와 `brain_writer` · `brain_reader` role을 만듭니다(비밀번호는 migration이 파일에서 읽어 정합니다).
4. 운영 repo의 Actions secret 두 개를 만듭니다.
   - `BRAIN_WRITER_URL`: `brain_writer`의 연결 문자열. direct endpoint(호스트에 `-pooler`가 없는 것)를 씁니다. 이 값은 이곳에만 둡니다.
   - `BRAIN_SOURCE_TOKEN`: 소스 repo만 읽는 fine-grained token(Contents · Pull requests · Issues: read). checkout과 GitHub 수집에 같이 씁니다. `GITHUB_TOKEN`은 다른 비공개 repo를 읽지 못합니다.
5. Actions 탭에서 `brain-publish`를 `main`에서 수동으로 돌립니다. 첫 실행은 `full`을 켭니다. GitHub를 처음부터 전부 받으므로(PR 1,300개 repo에서 약 2,700 호출, rate limit에 따라 수십 분) `full`일 때만 job 상한이 330분이고, 평소에는 30분입니다. 첫 실행이 데이터베이스를 소스 repo의 숫자 id에 묶습니다(`brain.binding`). 그 뒤 다른 repo를 가리키는 실행은 아무것도 쓰지 않습니다(V22).
6. sanitize 규칙이 바뀐 kit로 올린 뒤에도 한 번 `full`을 켜고 돌립니다(GitHub를 전부 다시 받아 새 규칙으로 정리, R15). 켜지 않으면 publish가 거부됩니다.

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
test/                     fixture repo + 검사 31개
```

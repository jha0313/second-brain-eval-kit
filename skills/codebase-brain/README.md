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
| `brain status` | 인덱스 커밋·나이, HEAD 이후 바뀐 파일, 미해결 import, 이름 연결에서 뺀 이름 수 |
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

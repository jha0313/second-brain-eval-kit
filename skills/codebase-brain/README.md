# codebase-brain — 코딩 에이전트용 지도(코드 그래프)와 코드 메모리 · 프로토타입

큰 코드베이스에서 에이전트가 grep으로 헤매는 두 종류의 질문을 한두 번 호출로 답합니다.

- **지도:** "X를 쓰는 곳 전부", "X를 바꾸면 어디가 영향받을 수 있나", "어떤 page·route·test가 X에 기대나". TypeScript 컴파일러가 만든 사실(import·호출·렌더·타입·상속 엣지)로 답하고, 모든 답에 `coverage` 플래그를 붙입니다.
- **코드 메모리:** "왜 이렇게 만들었나", "전에 뭐가 깨졌나". 문서·`changes/`·CHANGELOG·커밋 메시지(PR 번호)·Obsidian vault를 SQLite FTS5로 찾고, 문서↔코드↔커밋 링크를 한 hop 걸어 `파일:줄`·커밋 SHA 인용을 돌려줍니다. LLM을 부르지 않습니다(FAST).

프로토타입입니다. 강의에서 훨씬 더 고도화된 버전을 보여 드릴 예정입니다.

## 설치

```bash
git clone https://github.com/jha0313/second-brain-eval-kit
cp -r second-brain-eval-kit/skills/codebase-brain ~/.claude/skills/     # 또는 프로젝트의 .claude/skills/
cd ~/.claude/skills/codebase-brain && npm install                        # typescript 하나. Node 22.13 이상
export PATH="$HOME/.claude/skills/codebase-brain/bin:$PATH"
brain build /path/to/repo                                                # 대상 repo에는 아무것도 쓰지 않음
```

인덱스는 `~/.cache/codebase-brain/<repo 경로 해시>.db`에 생깁니다. `--db` 또는 `BRAIN_DB`로 바꿀 수 있습니다. vault를 같이 넣으려면 `--vault <dir>`(커밋 날짜보다 나중에 생긴 노트는 넣지 않음).

## 명령

| 명령 | 하는 일 |
|---|---|
| `brain status` | 인덱스 커밋·나이, HEAD 이후 바뀐 파일, 미해결 import |
| `brain find <이름>` | 심볼·파일 → ID(`path#Name`) |
| `brain refs <ID>` | 사용 위치 전부 (`--kind call,renders,type…`, `--filter page,route,test,server-action`, `--files`) |
| `brain callers <ID>` | 호출·렌더 위치를 감싼 함수별로 |
| `brain impact <ID>` | 역방향 BFS: 영향받을 수 있는 파일을 hop별로, 테스트 수 포함 (`--list`, `--no-mocks`, `--no-types`) |
| `brain deps <ID>` · `brain shared <A> <B>` | 앞방향 폐포 · 두 트리가 같이 기대는 파일 |
| `brain why "<질문>"` | 인용 묶음 (BM25 + 한국어 trigram + 이름→코드 링크 + 문서→커밋 hop) |
| `brain viz <ID> --out graph.html` | 2-hop 그래프(엣지 종류·방향, 안 그린 파일 수 표시) + 전체 hop 표 + why 패널, 단일 HTML (CDN 없음, 오프라인, 라이트·다크) |

모든 명령에 `--json`이 있습니다. 라우팅 규칙(언제 무엇을 부르고, 언제 부르지 않나)은 [SKILL.md](SKILL.md)에 있습니다.

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
| fixture 테스트 (`npm test`) | 15/15: tsconfig 2개·alias·barrel 재export·동적 import 구조분해·생성 파일·vi.mock·커밋된 node_modules |

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
test/                     fixture repo + 검사 15개
```

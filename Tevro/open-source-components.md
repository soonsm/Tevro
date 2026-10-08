# Tevro — 활용 가능한 오픈소스와 구현 경계

- 문서 상태: 기술 검토 및 추천안. 이 문서 자체는 기술 스택 채택이나 구현 완료를 의미하지 않음. 채택된 결정은 ADR에 기록하며, 현재 채택 상태인 것은 ADR-0001, ADR-0002, ADR-0003이다.
- 작성 기준일: 2026-09-26
- 개정일: 2026-10-07 — 외부 정보 재확인 결과 반영, 공정 계층 요구 반영
- 개정일: 2026-10-08 — ADR-0001 채택(TypeScript 단일, React SPA, Node 26) 반영
- 개정일: 2026-10-08 — ADR-0002 채택(Node.js 동봉 압축 파일 + systemd) 반영
- 개정일: 2026-10-08 — ADR-0003 채택(SQLite + better-sqlite3) 반영
- 관련 문서: [해결하려는 문제와 제품 요구사항](./product-requirements.md), [착수 전 결정 기록(ADR)](./adr/README.md)
- 목적: 공정 GUI 편집, DAG 배치·검증, Jira·Confluence 연동, CLI 구현에 활용할 기존 오픈소스를 정리하고 Tevro가 직접 구현할 부분을 구분한다.
- 근거 범위: 앞선 검토에서 확인한 공식 문서·공개 저장소를 정리한 문서다. 사내 Jira 및 폐쇄망에서 설치·동작을 검증한 결과는 아니다. 실제 채택 시 릴리스별 기능·라이선스·유지보수 상태를 다시 확인한다. 2026-10-07에 버전·지원 기간·엔드포인트 등 공개 정보를 다시 확인해 반영했다. 이 재확인도 공개 자료 대조이며, 사내 설치·동작 검증은 여전히 아니다. 2026-10-08에는 ADR-0001 채택에 맞춰 React Flow·React·Vite의 공개 정보(npm 메타데이터, 공식 문서·예제 페이지, Pro 라이선스)를 확인해 반영했다. 같은 날 ADR-0003 채택에 맞춰 better-sqlite3의 공개 정보(npm 메타데이터와 패키지 압축 파일 내용, README, 공식 문서)도 확인해 반영했다. 이것도 공개 자료 대조다.

> 그래프를 그리고 조작하는 기술은 기존 라이브러리를 활용한다. Tevro는 공정의 의미, 선행 조건, 템플릿 재사용, Jira 매핑과 상태의 일관성에 집중한다.

## 1. 추천 조합 요약

[ADR-0001](./adr/0001-tech-stack.md)에서 TypeScript 단일 언어와 React를 채택했다(2026-10-08). 서버·웹·CLI를 모두 TypeScript로 작성하고(Node.js 서버 + React SPA + Node.js CLI), Node.js 주 버전은 26 LTS다. 아래 표는 이 결정에 맞춘 조합이다. ADR-0001과 ADR-0003에서 정한 항목은 '채택'으로 표시하고, 나머지는 후보로 남긴다.

| 역할 | 채택·후보 | 판단 |
| --- | --- | --- |
| GUI 공정 카드·연결 편집 | React Flow (`@xyflow/react`) — 채택(ADR-0001) | 공정 카드를 React 컴포넌트(사용자 정의 노드)로 만들고 노드·연결 조작을 맡기는 방식. 공정 계층은 하위 흐름(`parentId`)으로 표시(§3.2) |
| 웹 빌드 | SPA 정적 빌드 — 채택(ADR-0001). 빌드 도구는 Vite 등 | API 서버가 정적 파일을 함께 제공. SSR 프레임워크(Next.js 등)는 쓰지 않음(§3.2) |
| Svelte를 전제로 한 GUI 후보 | Svelte Flow (`@xyflow/svelte`) | 검토했으나 채택하지 않음(ADR-0001). 앞선 검토의 1차 후보였음(§3.1) |
| DAG 자동 배치 | Dagre (`@dagrejs/dagre`) | 초기 계층형 배치와 자동 정렬부터 검증. 공정 계층은 층마다 따로 실행(§4.1) |
| 복잡한 배치의 대안 | ELK.js (`elkjs`) | 포트·연결선 경로의 요구가 커지거나, 펼친 상위 안의 하위를 바깥 노드와 함께 배치해야 할 때 검토 |
| 그래프 자료구조·알고리즘 | Graphlib (`@dagrejs/graphlib`) | TypeScript 서버(ADR-0001)의 도메인 모듈에서 활용 가능. 순환 검사만 필요하면 작은 자체 함수도 선택지. 도입 여부는 스파이크로 정함(§5.1) |
| Jira API 접근 | 서버 JiraAdapter 뒤의 작은 REST 어댑터 — 채택(ADR-0001) | Jira 9.x 대상인 동안 REST 어댑터로 구현(§6.3). 사내 Jira가 10.0 이상이 되면 `jira.js` 6.3 이상을 재평가(§6.1). SDK 때문에 서버 언어를 바꾸지 않음 |
| Confluence | 초기에는 URL 저장·표시 | 현재 요구에는 SDK나 페이지 본문 수집이 필요하지 않음 |
| 영속 저장소 | SQLite + `better-sqlite3` — 채택(ADR-0003) | 서버만 접근한다. 모든 쓰기 트랜잭션을 `BEGIN IMMEDIATE`로 열어 하나씩 처리한다. 동기식 API다(§9) |
| CLI 명령 해석 | Commander.js (`commander`) — 채택(ADR-0001) | 명령·옵션·도움말 처리를 재사용하고 Tevro API 호출은 직접 구현. CLI는 Node.js + TypeScript(ADR-0001). 주 버전(14.x 또는 15.x)과 배포 형태는 ADR-0007에서 정함 |
| 문서용 그래프 출력 | Mermaid | 주 GUI 편집기 대신 후속 내보내기 기능의 후보 |

이 추천은 해당 라이브러리만 조합하면 제품 전체가 완성된다는 뜻이 아니다. 공정 데이터, 상태, 템플릿, 인증·권한, 저장, 외부 연동의 실패 복구는 Tevro의 구현 범위로 남는다. 각 후보의 기능 근거는 아래 절과 참고 자료에 정리한다.

## 2. 먼저 구분해야 할 세 가지 역할

| 역할 | 해결하는 문제 | 대표 후보 |
| --- | --- | --- |
| 그래프 편집·렌더링 | 노드와 연결선을 표시하고 드래그·선택·연결·확대·축소를 제공. 상위 공정 안에 하위 노드를 묶어 접기·펼치기 | React Flow(채택), Svelte Flow, X6, Cytoscape.js, JointJS |
| 자동 배치 | 노드의 위치와 필요에 따라 연결선 경로를 계산 | Dagre, ELK.js |
| 업무 모델·규칙 | 공정의 상태, 선행 조건, 템플릿 복제, Jira 매핑을 정의·검증·저장 | Tevro에서 구현 |

예를 들어 공정 C에 선행 공정 A·B가 연결된 경우, 편집기는 카드와 연결선을 보여주고 배치 엔진은 좌표를 계산한다. A 완료·B 진행 중이라는 상태로부터 C의 선행 조건이 미충족이라고 판단하는 것은 Tevro의 규칙이다. 공정 '개발' 안에 하위 공정 X·Y가 있을 때도 같다. 편집기는 X·Y를 개발 노드 안에 묶어 보여주고, X·Y가 모두 완료되면 개발을 완료로 바꾸는 것(F-H05)과 다른 층의 공정끼리 연결을 거부하는 것(F-H03)은 Tevro의 규칙이다.

화면에서 연결선을 만들 수 있다는 사실만으로 DAG가 보장되거나, 선행 조건 판정·서버 저장·Jira 동기화까지 제공되는 것은 아니다.

## 3. GUI 공정·연결 편집

### 3.1 Svelte Flow — 검토했으나 채택하지 않음(ADR-0001)

- 패키지: `@xyflow/svelte`
- 코어 라이브러리 라이선스: MIT
- 공식 문서: [Svelte Flow][svelte-flow]
- 저장소: [xyflow][xyflow]

앞선 검토(2026-09-26 작성, 2026-10-07 개정)에서는 Svelte 프런트엔드를 전제로 Svelte Flow를 우선 후보로 두었다. [ADR-0001](./adr/0001-tech-stack.md)에서 React를 채택했으므로(2026-10-08) 사용하지 않는다. 결정 이력으로 검토 당시 확인한 내용만 남긴다.

| 항목 | 검토 당시 확인한 내용 |
| --- | --- |
| 기본 동작 | 노드 이동, 화면 이동·확대·축소, 선택, 연결 생성 [Svelte Flow][svelte-flow] |
| 사용자 정의 노드 | 일반 Svelte 컴포넌트로 작성하고 입력 요소나 버튼을 넣을 수 있음 [사용자 정의 노드][svelte-custom] |
| 하위 흐름 | `parentId`로 상위 기준 상대 좌표에 배치, 노드 배열에서 상위 우선, `extent: 'parent'`로 이동 범위 제한, `group` 외 사용자 정의 노드도 상위 가능. 2026-10-07에 공식 문서(2026-09-09 갱신판)로 확인 [Svelte Flow 하위 흐름][svelte-subflows] |
| Tevro가 구현할 범위 | 접기·펼치기, 하위 개수·완료 수 표시, 접힌 상태의 상위 간 연결만 표시. React Flow에서도 같다(§3.2) |

### 3.2 React Flow — 채택(ADR-0001)

- 패키지: `@xyflow/react`
- 코어 라이브러리 라이선스: MIT
- 공식 문서: [React Flow][react-flow]
- 저장소: [xyflow][xyflow]
- 채택 기록: [ADR-0001](./adr/0001-tech-stack.md)(2026-10-08). 채택할 고정 버전은 아직 정하지 않았다.

React Flow는 Svelte Flow와 같은 xyflow 계열의 React용 노드 편집 라이브러리다. [React Flow][react-flow], [xyflow][xyflow] Tevro는 노드 이동, 화면 이동·확대·축소, 선택, 연결 생성 같은 기본 동작을 맡기고, 공정 카드를 React 컴포넌트로 작성한 사용자 정의 노드로 표현해 노드 안에 입력 요소나 버튼을 둘 계획이다. 이 기능 범위는 Svelte Flow 문서로 확인한 것이며(§3.1), React Flow 문서로는 확인 필요다.

앞선 검토는 이 절을 'React를 선택할 경우'의 대안으로 두었고, 그래프 편집 라이브러리 때문에 익숙한 Svelte를 반드시 버릴 필요는 없다고 보았다. ADR-0001에서 프런트엔드를 React로 정해 React Flow가 채택 라이브러리가 되었다.

2026-10-08에 npm 레지스트리에서 확인한 패키지 정보는 다음과 같다.

| 항목 | 확인 내용 | 출처 |
| --- | --- | --- |
| 최신 안정판 | 12.12.0(`latest`, 2026-09-24 게시). `next` 태그는 12.0.0-next.5로 최신 안정판보다 오래된 판이다 | [npm 메타데이터][xyflow-react-npm] |
| 라이선스 | MIT | [npm 메타데이터][xyflow-react-npm] |
| peer 의존성 | `react`·`react-dom` `>=17`. `@types/react`·`@types/react-dom` `>=17`은 `peerDependenciesMeta`에서 optional | [12.12.0 메타데이터][xyflow-react-npm-latest] |
| 런타임 의존성 | `zustand` `^4.4.0`, `classcat` `^5.0.3`, `@xyflow/system` `0.0.83` | [12.12.0 메타데이터][xyflow-react-npm-latest] |
| React | 최신 안정판 19.3.0(`latest`, 2026-09-09 게시). 최신 안정 주 버전은 19. `canary`·`experimental` 태그가 따로 있다 | [react npm 메타데이터][react-npm] |

React 19는 peer 범위 `>=17`에 든다. 채택 버전은 `latest` 안정판에서 고르고 `next`·`canary`·`experimental` 태그는 쓰지 않는 것을 제안한다. 런타임 의존성 세 개도 라이선스·반입 검토 대상이다(§11.1).

공정 계층(PRD §6.9)은 하위 흐름(sub flow)으로 표시한다. 2026-10-08에 공식 문서로 확인한 내용은 다음과 같다. [React Flow 하위 흐름][react-subflows]

- 노드에 `parentId`를 지정하면 하위 노드가 된다. 이 이름은 11.11.0에서 `parentNode`를 바꾼 것이다.
- `parentId`를 지정한 노드의 위치는 상위 기준 상대 좌표다. `{ x: 0, y: 0 }`이 상위 노드의 왼쪽 위 모서리다.
- 문서는 `parentId`가 하는 일이 상대 위치 지정 하나뿐이며, 마크업상 실제 자식 요소가 되는 것은 아니라고 설명한다.
- `nodes` 또는 `defaultNodes` 배열에서 상위 노드가 하위 노드보다 먼저 와야 올바르게 처리된다(Order of Nodes 절).
- 하위 노드에 `extent: 'parent'`를 주면 상위 노드 밖으로 끌어낼 수 없다. 이 옵션이 없으면 하위를 상위 밖으로 드래그하거나 배치할 수 있지만, 상위를 움직이면 하위도 함께 움직인다.
- 예제는 상위에 `type: 'group'`을 쓰지만 다른 어떤 유형도 상위로 쓸 수 있다. `group`은 핸들이 없는 편의용 유형이고, 기본 노드 유형을 상위로 쓰는 절도 있다. 사용자 정의 노드를 따로 명시하지는 않지만 '다른 어떤 유형'에 포함되는 것으로 읽힌다.
- 그룹 안의 노드끼리도, 하위 흐름에서 바깥 노드로도 연결할 수 있다. 라이브러리는 다른 층과의 연결을 막지 않으므로 형제 규칙(F-H03)은 Tevro 서버가 검증한다(§5.2).
- 연결선은 기본적으로 노드 아래에 그려지지만, 상위가 있는 노드에 연결된 연결선은 노드 위에 그려진다. 겹침 순서는 `zIndex` 옵션(예: `defaultEdgeOptions = { zIndex: 1 }`)으로 조정한다.

Tevro에 적용할 때의 제안은 다음과 같다.

- 상위 공정도 사용자 정의 노드로 그린다. 사용자 정의 노드를 상위로 쓰는 동작은 문서에 따로 명시되지 않았으므로 스파이크에서 확인한다.
- 화면용 노드 배열을 만들 때 상위 공정을 하위 공정보다 앞에 둔다. 서버 응답의 순서에 기대지 않고 변환 단계에서 정렬한다.
- `parentId`는 화면의 상대 위치 지정일 뿐이다. 포함관계의 원본은 공정이 갖는 상위 공정 ID다(§9). 하위 노드를 상위 영역 밖으로 끌어내거나 다른 상위 안으로 끌어다 놓는 것으로 포함관계를 바꾸지 않으므로(F-H08), 하위 노드에 `extent: 'parent'`를 주는 방식을 우선 검토한다.

접기·펼치기, 하위 개수·완료 수 표시, 접힌 상태에서 상위 간 연결만 보이는 처리는 위 하위 흐름 기능에 들어 있지 않다. 공식 접기·펼치기 예제는 Pro 전용이다(아래 예제 표). 하위 노드와 연결을 숨기고 상위 노드 크기를 바꾸는 방식으로 Tevro가 구현한다.

| Tevro 기능 | 적용 방식 | 직접 구현할 부분 |
| --- | --- | --- |
| 공정 카드 표시 | 공정 하나를 사용자 정의 노드(React 컴포넌트) 하나로 표현 | 제목·상태·기한·링크의 표시 구성 |
| 선후관계 연결 | 노드의 연결 지점인 Handle과 방향 있는 연결선 사용 | 선행·후속 의미, 서버 저장, 순환 검증 |
| 상태 수정 | 사용자 정의 노드 또는 상세 패널에 선택 UI 배치 | 상태 변경 API, 실패 처리, Jira 상태 원본 규칙 |
| 내용 편집 | 선택한 노드에 대응하는 상세 패널 제공 | 설명 편집기와 저장 처리 |
| 그래프 탐색 | 이동·확대·축소·선택·미니맵 등을 활용 | 기본 화면 구성과 선택 공정 강조 방식 |
| 공정 추가·삭제 | Tevro의 도구 모음·상세 패널에서 노드 작업 수행 | 새 공정 ID 발급, 연결 정리, 삭제 영향 확인 |
| 계층 표시(F-H07) | 하위 흐름(`parentId`)으로 상위 노드 안에 하위 배치. 상위 공정도 사용자 정의 노드 | 접기·펼치기, 개수·완료 수 표시, 접힌 상태의 상위 간 연결만 표시 |

위 표의 '적용 방식' 열에 적은 React Flow 기능(Handle, 미니맵, 사용자 정의 노드 안의 선택 UI)은 Svelte Flow 검토 때의 표를 옮긴 것이다. React Flow 문서로는 확인 필요다.

공정 카드를 `TaskNode.tsx` 같은 React 컴포넌트로 작성하는 방식이 적합하다. 다만 라이브러리에 노드 안 입력 UI를 넣을 수 있다는 것과, 완성된 공정 관리 폼을 제공한다는 것은 다르다.

Tevro 적용 시 특히 확인할 사항은 한글 입력 중의 단축키 충돌, 텍스트 선택과 노드 드래그의 구분, 상태 선택 상자 조작, 링크 클릭, 긴 제목과 상세 패널의 사용성, 접기·펼치기 시 노드 크기 변경과 연결선 재계산, 상위가 있는 노드에 연결된 연결선의 겹침 순서, 깊은 중첩의 성능이다. 이는 스파이크에서 검증할 항목이지 이미 검증된 성능·호환성 결과가 아니다.

코어 라이브러리와 Pro 구독은 구분한다. Pro 페이지는 React Flow를 MIT 라이선스 오픈소스라고 하며 앞으로도 그렇다고 명시한다. FAQ는 구독 없이 상업 프로젝트에 써도 되느냐는 질문에 MIT License를 근거로 그렇다고 답한다. React Flow Pro는 별도 라이브러리가 아니라 오픈소스 라이브러리를 중심으로 한 유료 서비스다. [React Flow Pro][react-pro]

공정 계층과 관련된 예제의 제공 조건은 다음과 같다. 2026-10-08에 예제 목록과 각 예제 페이지로 확인했다. 배치 예제는 §4.1, 순환 방지 예제는 §5.2에 둔다. [React Flow 예제][rf-examples], [React Flow Pro 예제][rf-pro-examples]

| 예제 | 제공 조건 | 내용 | Tevro 관련 |
| --- | --- | --- | --- |
| Sub Flow | 무료 | 하위 흐름 기본 예제 | 계층 표시(F-H07)의 출발점 |
| Expand and Collapse | Pro | `useExpandCollapse` 훅으로 전체 그래프는 유지하고 보이는 부분만 렌더링. 의존성은 `@xyflow/react`, `@dagrejs/dagre` [예제][rf-expand-collapse] | 접기·펼치기(F-H07)에 해당. Tevro가 직접 구현 |
| Selection Grouping | Pro | Shift 선택 후 그룹화·해제 | 상위 지정은 영향을 확인하는 명시적 작업이므로(F-H08) 그대로 쓰지 않음 |
| Parent Child Relation | Pro | 드래그로 그룹에 붙이기·떼기, 상대 좌표 변환 | 드래그로 포함관계를 바꾸지 않으므로(§9) 그대로 쓰지 않음 |

'Dynamic Grouping'이라는 이름의 예제는 두 목록 모두에 없다. 이름이 바뀌었거나 다른 예제로 합쳐졌는지는 문서에 나와 있지 않다. 기능상 가장 가까운 것은 Selection Grouping과 Dynamic Layouting(둘 다 Pro)이다.

Pro 예제의 사용 조건은 다음과 같다. 2026-10-08에 Pro 페이지와 xyflow Pro License(Version 1.0, 2026-08-31 갱신)로 확인했다. 공개 문구의 요약이며 법적 검토 결과가 아니다. [React Flow Pro][react-pro], [xyflow Pro License][xyflow-pro-license]

| 항목 | 확인 내용 |
| --- | --- |
| 요금제(월간 표시 기준) | Starter 월 169달러(팀원 1명 초대), Professional 월 289달러(팀원 5명), Enterprise 견적 요청(팀원 10명, Pro 예제·템플릿 영구 접근). Pro 예제 접근은 세 요금제 모두 포함 |
| 사용 범위 | FAQ는 회사 안의 상업·비상업 프로젝트에 제한 없이 쓸 수 있다고 함. 라이선스는 유효한 구독을 조건으로 영구·비독점·양도 불가 라이선스를 줌 |
| 허용 | 사용·수정·앱 통합, Pro 예제를 포함한 애플리케이션의 배포 |
| 금지 | 독립 예제나 템플릿 형태의 재배포, 구독 접근 공유, 저작권 표시 제거, xyflow 사업과 직접 경쟁하는 사용 |
| 구독 종료 | 이미 얻은 콘텐츠의 권리는 구독이 끝나도 유지 |
| 라이선스 종료 | 위반 시에만 자동 종료. 종료되면 그 앱의 신규 배포는 멈춰야 하지만 이미 배포된 앱은 계속 동작해도 됨 |
| 공개 저장소 | 공개 GitHub 저장소에 소스를 올리는 경우는 언급 없음. 확인 필요 |

유료 예제나 템플릿을 코어와 같은 조건으로 복제해도 된다고 가정하지 않는다. Tevro는 코어(MIT)만으로 구현하고 Pro 구독을 전제로 하지 않는 것을 제안한다. Pro 예제를 참고하거나 도입하려면 구독 여부, 위 조건, 사내 반입 승인(§11.1)을 먼저 확인한다.

웹은 SPA 정적 빌드로 만들고 API 서버가 정적 파일을 함께 제공한다. Next.js 같은 SSR 프레임워크는 쓰지 않는다(ADR-0001). 빌드 도구는 Vite 등을 쓴다. 2026-10-08 확인 기준 `vite`의 최신 안정판은 8.3.3(2026-10-06 게시, MIT)이고 최신 안정 주 버전은 8이다. `engines.node`는 `^20.19.0 || >=22.12.0`이다. ADR-0001에서 채택한 Node.js 26은 이 범위에 들지만, 실제 도구 호환성은 스파이크에서 확인한다(§12). [Vite npm 메타데이터][vite-npm]

### 3.3 대안 후보

| 후보 | 코어 라이선스 | 특징 | Tevro에서의 판단 |
| --- | --- | --- | --- |
| AntV X6 | MIT | HTML·SVG 기반 그래프 편집 엔진. 실행 취소·다시 실행 등 편집 플러그인 제공. Cell API에 상위·하위 노드 관계(`setParent`, `addChild`, `getChildren`)가 있어 중첩 가능. 그룹 접기·펼치기 제공 여부는 확인 필요 | 도형 편집기 수준의 편집 편의성이 중요해질 때 비교 |
| Cytoscape.js | MIT | 그래프 시각화·분석 기능이 풍부하며 `edgehandles` 확장으로 연결 생성 가능. 노드 data의 `parent`로 compound node(중첩) 지원. 접기·펼치기는 코어가 아닌 `expand-collapse` 확장이며, 그 저장소는 유지보수 중단을 안내함 | 업무 카드 폼 편집보다 관계 탐색·분석의 비중이 커질 때 검토 |
| JointJS | MPL-2.0 | 도형·연결선·인터랙티브 다이어그램 구성. 중첩 지원 여부는 확인 필요 | 오픈소스 코어와 상용 JointJS+ 기능 범위를 구분한 뒤 검토 |

기능·라이선스 근거: [X6 저장소][x6], [X6 History 플러그인][x6-history], [X6 Cell API][x6-cell-api], [Cytoscape.js][cytoscape], [edgehandles][edgehandles], [Cytoscape.js expand-collapse 확장][cytoscape-expand-collapse], [JointJS 저장소][jointjs].

공정 계층(F-H07)에 따라 중첩 노드 지원이 비교 항목에 들어간다. 중첩을 지원해도 접기·펼치기와 개수·완료 수 표시는 Tevro가 구현해야 하는 점은 React Flow와 같다(§3.2).

앞선 검토는 초기에 Svelte Flow와 X6 정도를 작은 공정 그래프로 비교하자고 제안했다. ADR-0001에서 React Flow를 채택했으므로, 대안 후보는 스파이크에서 React Flow의 실제 한계가 드러날 때 비교한다. 모든 후보로 제품 전체를 구현하거나, 아직 필요하지 않은 편집 기능 수만으로 선택하지 않는다. 별도 확장을 도입할 때는 확장 자체의 라이선스와 버전 호환성도 확인한다.

## 4. DAG 자동 배치

### 4.1 Dagre — 초기 추천

- 패키지: `@dagrejs/dagre`
- 라이선스: MIT
- 공식 저장소: [Dagre][dagre]

Dagre는 방향 있는 그래프를 계층적으로 배치하는 라이브러리다. 노드 크기와 연결 관계를 전달하고, 계산된 좌표를 그래프 편집기의 노드 위치에 적용하는 방식으로 사용한다. React Flow의 공식 레이아웃 안내에서도 외부 배치 엔진으로 다룬다. [Dagre][dagre], [React Flow 레이아웃 안내][flow-layout]

React Flow의 Dagre 예제(Dagre Tree)는 무료로 공개되어 있다. Pro 표시나 Pro License 표기, Download ZIP이 없고 전체 소스 코드가 페이지에 나온다. 코드는 `@dagrejs/dagre`를 쓴다. 페이지는 더 발전된 배치 라이브러리로 d3-hierarchy와 elkjs를 함께 권한다. 2026-10-08에 확인했다. [React Flow Dagre 예제][rf-dagre]

레이아웃 범주의 다른 예제는 제공 조건이 갈린다. Pro 예제는 코어와 같은 조건으로 복제하지 않는다(§3.2). [React Flow Pro 예제][rf-pro-examples]

| 제공 조건 | 레이아웃 범주 예제 |
| --- | --- |
| 무료(Pro 표시 없음) | Dagre Tree, Elkjs Tree, Elkjs Multiple Handles, Horizontal Flow, Node Collisions |
| Pro(xyflow Pro License) | Auto Layout(`useAutoLayout` 훅으로 dagre·d3-hierarchy·elkjs 전환), Dynamic Layouting(d3-hierarchy 기반 자동 배치), Force Layout |

Tevro의 초기 배치는 무료 Dagre 예제와 Dagre 문서를 기준으로 구현한다.

초기 Tevro에서는 다음 흐름을 제안한다.

1. 독립 공정을 포함한 전체 공정과 연결을 배치 입력으로 변환한다.
2. 제목·상태 등의 표시를 고려한 노드 크기로 좌표를 계산한다.
3. 계산된 좌표를 화면에 반영한다.
4. 사용자가 수동으로 조정한 위치는 업무 종속성과 별도로 보존한다.
5. 관계나 상태가 바뀔 때마다 강제로 재배치하지 않고, 필요한 경우 자동 정렬을 실행한다.

공정 계층(PRD §6.9)이 있어도 Dagre를 그대로 쓸 수 있다. 선행관계는 같은 상위 안의 공정끼리만 맺으므로(F-H03) 각 층은 독립된 작은 DAG다. 따라서 전체를 한 번에 배치하지 않고 층마다 Dagre를 실행하는 2단계 배치를 제안한다.

1. 펼친 상위 공정마다 그 하위 공정들만으로 Dagre를 실행한다. 결과의 전체 크기가 그 상위 노드의 크기가 된다. 가장 깊은 층부터 올라온다.
2. 접힌 상위는 하나의 노드로, 펼친 상위는 1단계에서 계산한 크기의 노드로 다루어 그 층의 형제 공정들을 Dagre로 배치한다.

React Flow에서 하위 노드 위치는 상위 기준 상대 좌표다(§3.2). 따라서 1단계에서 하위 공정들만으로 계산한 좌표를 그 상위 안의 위치로 옮겨 쓰기 쉽다. 좌표 기준점과 상위 안쪽 여백은 구현에서 맞춘다.

층마다 그래프가 작아지므로 입력이 단순하고, 접기·펼치기로 상위 노드 크기가 바뀌면 해당 층과 그 조상 층만 다시 배치하면 된다. 이 방식이면 ELK.js의 중첩 배치가 초기에는 필수가 아니다(§4.2). 수동으로 조정한 위치는 층별로 보존한다. 층별 좌표 저장 규칙은 PRD §13-4에서 정한다.

과거의 `dagre` 이름과 `@dagrejs/dagre`를 혼동하지 않는다. 프로젝트는 DagreJS 조직의 패키지를 안내하므로 실제 채택 패키지와 버전을 명시한다. [Dagre][dagre]

### 4.2 ELK.js — 복잡한 배치의 대안

- 패키지: `elkjs`
- 역할: 노드·포트·연결선 배치 계산. 화면 렌더러 자체는 아님.
- 라이선스: 앞선 검토의 `package.json`에는 `EPL-2.0 OR GPL-3.0-or-later`로 표기. 실제 반입 릴리스의 LICENSE 및 포함 코드 조건을 기준으로 재확인.
- 공식 저장소: [ELK.js][elk], [패키지 메타데이터][elk-package]

| 기준 | Dagre | ELK.js |
| --- | --- | --- |
| 초기 용도 | 비교적 단순한 방향성 그래프의 계층 배치 | 포트·상세 경로 요구가 있는 배치 |
| 중첩 구조 | 층마다 따로 실행하는 2단계 배치로 대응(§4.1). 선행관계가 형제끼리만이므로 가능 | 펼친 상위 안에서 하위를 바깥 노드와 함께 배치해야 하는 요구가 커질 때 |
| 설정 부담 | 상대적으로 작음 | 옵션과 입력 구조를 더 상세히 다뤄야 함 |
| Tevro 채택 시점 제안 | 우선 검증 | Dagre의 실제 한계가 드러난 뒤 검토 |

비교 근거: [Flow 레이아웃 안내][flow-layout], [ELK.js][elk].

자동 배치는 연결선의 모든 교차를 없앤다는 보장이 아니다. 복잡한 그래프에서는 관련 경로 강조, 필터, 화면 탐색 등도 필요하다. ELK.js를 채택해도 DAG 검증과 공정 상태 판단은 별도다.

### 4.3 Mermaid — 편집기보다 문서 출력

Mermaid는 텍스트 정의를 다이어그램으로 표현하는 도구다. 현재의 GUI 공정·상태 편집 요구에서는 주 편집기로 채택하기보다, 향후 Markdown 문서에 삽입할 그래프를 내보내는 용도로 검토한다. [Mermaid 소개][mermaid]

사용자는 GUI로 작업하고, 문서가 필요할 때 Tevro의 공정·관계 데이터를 Mermaid로 변환하는 구조다. Mermaid 내보내기는 기존 요구사항 문서와 마찬가지로 초기 필수 기능이 아니다.

## 5. 그래프 자료구조와 검증

### 5.1 Graphlib

- 패키지: `@dagrejs/graphlib`
- 라이선스: MIT
- 공식 저장소: [Graphlib][graphlib]

| 기능 | 활용 |
| --- | --- |
| `alg.isAcyclic()` | 연결 변경 후 DAG 여부 확인 |
| `alg.findCycles()` | 순환에 관련된 공정을 찾아 검증 실패 설명 |
| `alg.topsort()` | 선행관계에 따른 위상 정렬 |
| 선행·후속 노드 탐색 | 특정 공정의 관련 관계와 영향 범위 조회 |
| 층별 그래프 구성 | 같은 상위를 가진 공정(형제)끼리 층마다 그래프를 만든 뒤 순환 검사 |

기능 근거: [Graphlib 저장소 및 API 문서][graphlib].

ADR-0001에서 서버를 TypeScript(Node.js)로 정했으므로 서버 도메인 모듈 내부에서 활용할 수 있다. Graphlib와 작은 자체 함수(§5.2) 중 무엇을 쓸지는 아직 정하지 않았고 스파이크로 비교한다(ADR-0001).

### 5.2 서버 검증은 반드시 유지

React Flow에는 화면에서 순환 연결을 막는 무료 예제 'Preventing Cycles'가 있다(Interaction 범주, Pro 표시 없음). `isValidConnection` 콜백과 `getOutgoers` 유틸로 새 연결이 순환을 만드는지 검사하며, 소스에 `hasCycle` 함수가 들어 있다. 2026-10-08에 확인했다. [React Flow 순환 방지 예제][prevent-cycles]

이 방식을 화면의 사전 피드백으로 적용하더라도 그것만으로 충분하지 않다. Tevro는 CLI에서도 관계를 변경하므로 GUI와 CLI의 모든 변경을 서버에서 검증해야 한다. 다른 층의 공정을 잇는 연결(F-H03)도 같은 콜백에서 미리 막을 수 있지만 최종 판정은 서버가 한다.

Tevro가 검증해야 할 기본 규칙은 다음과 같다.

- 존재하지 않는 공정이나 다른 프로젝트의 공정을 참조하지 않는다.
- 자기 자신으로 연결하지 않는다.
- 같은 방향의 연결을 중복 생성하지 않는다.
- 추가·변경 결과가 순환하지 않는다.
- 여러 관계를 함께 바꿀 때 최종 변경 결과를 일관되게 검증한다.
- 공정 삭제 후 유효하지 않은 연결이 남지 않게 한다.

공정 계층(PRD §6.9)에 따라 다음 규칙을 추가한다. 오류 코드는 [ADR-0006](./adr/0006-server-api-contract.md)의 체계를 따른다.

- 상위 공정은 같은 프로젝트의 공정이어야 한다. 자기 자신이나 자손을 상위로 지정하지 않는다(`HIERARCHY_CYCLE`). 포함관계는 트리이므로 이 검사만으로 순환이 생기지 않는다.
- 선행관계는 같은 상위를 가진 공정(형제)끼리만 맺는다. 다른 층의 공정을 잇는 연결은 거부한다(`CROSS_LEVEL_DEPENDENCY`). 순환 검사는 층마다 따로 한다.
- 선행·후속 연결이 남아 있는 공정의 상위는 바꾸지 않는다(`HAS_DEPENDENCIES`). 연결을 제거한 뒤에만 이동한다.
- 상위 자동 완료(F-H05)와 상위·하위 모순 표시(F-H06)는 상태 규칙이므로 그래프 검증과 분리한다. 선행 조건 상속(F-H04)도 조상의 선행과 실행 상태가 필요하므로 같은 쪽에 둔다.

순환 검사만 필요하다면 작은 순수 함수로 구현하는 것도 가능하다. Graphlib의 도입 여부보다 규칙을 화면 이벤트와 분리하고 서버에서 일관되게 적용하는 것이 중요하다. 선행 조건 충족 여부는 그래프 구조뿐 아니라 공정 실행 상태가 필요하므로 Tevro에서 별도로 계산한다.

## 6. Jira 연동

### 6.1 가장 먼저 확인할 조건

대상은 사용자가 설명한 사내 설치형 Jira 9.15.1이다. Cloud용 SDK와 Server/Data Center용 SDK를 구분하고, 실제 사이트의 에디션·인증·권한·필수 필드·링크 유형은 연동 전에 확인한다.

대상 버전의 지원 기간도 확인 대상이다. 2026-10-07에 공개 정보를 다시 확인한 결과는 다음과 같다.

| 항목 | 확인 내용 | 출처 |
| --- | --- | --- |
| Jira Software 9.15 | 2026-03-27 지원 종료. 참고로 9.17은 2026-06-26, 10.3 LTS는 2026-12-05 지원 종료 | [Atlassian End of Support Policy][atlassian-eos] |
| Jira Data Center 제품군 | 2029-03-28 EOL이며 이후 읽기 전용. 신규 구매는 2026-03-30에 종료, 기존 고객의 확장 구매는 2028-03-30까지 | [Data Center 제품 EOL 안내][jira-dc-eol] |

대상 Jira 9.15.1은 작성 기준일 이전에 이미 지원이 끝난 버전이다. 사내 Jira가 10.x 이상으로 올라가면 SDK 후보와 인증 방식을 다시 검토해야 한다. Data Center로 계속 운영한다면 EOL 이후 읽기 전용이 되므로 이슈 생성·링크 같은 쓰기 연동의 수명도 그 시점까지로 제한된다. 따라서 사내 Jira의 업그레이드·이전 계획(대상 버전과 시점)을 연동 전 확인 항목에 포함한다. 이 사실이 Jira 연동을 선택 기능으로 두는 범위나 SDK를 어댑터 뒤로 숨기는 원칙(§6.3)을 바꾸지는 않는다.

예를 들어 `jira.js`는 공식 README에서 Cloud용 라이브러리로 설명하며 Server/Data Center를 지원하지 않는다고 안내한다. 2026-10-07 기준 최신 안정판 6.2.0(2026-08-24)의 README도 같은 설명을 유지하므로, 이 서술은 안정판 기준으로 유효하다. 6.x에서는 `Version2Client`와 `Version3Client`가 제거되었다. 따라서 현재 사내 Jira의 1차 후보에서는 제외한다. [jira.js][jira-js], [jira.js npm 메타데이터][jira-js-npm]

다음 판에서는 지원 범위가 넓어질 예정이다. 저장소 기본 브랜치 README는 6.3부터 `createServerClient`로 자체 호스팅 Jira 10.0 이상을 지원하고 Jira 9.x는 지원하지 않는다고 안내한다. 6.3은 2026-10-07 현재 RC(6.3.0-rc.1, 2026-09-29) 단계다. 6.x는 ESM 전용이며 Node.js 22 이상을 요구한다.

| 조건 | `jira.js` 판단 |
| --- | --- |
| 사내 Jira 9.15.1(현재 대상) | 6.3 이후에도 9.x 미지원이므로 계속 제외 |
| 사내 Jira가 10.0 이상으로 업그레이드 | 6.3 이상 정식판을 기준으로 TypeScript 서버의 SDK 후보로 재평가 |

### 6.2 SDK 후보

| 후보 | 언어 | 라이선스 | 활용 범위와 판단 |
| --- | --- | --- | --- |
| `atlassian-python-api` | Python | Apache-2.0 | Jira·Confluence 등 여러 Atlassian 제품의 래퍼. 설치형과 Cloud를 구분하여 지원하므로 Python 서버라면 우선 검토 |
| `pycontribs/jira` | Python | BSD-2-Clause | Jira 전용 라이브러리. Cloud 및 Server/Data Center 지원을 목표로 하므로 Jira 중심 대안 |
| `jira-client` | Node.js | MIT | 이슈 생성·조회·링크 생성 등의 래퍼. npm 최신판 8.2.2(2022-11-03) 이후 릴리스가 없고, 저장소 기본 브랜치의 마지막 커밋도 같은 날의 릴리스 커밋이다(2026-10-07 확인). HTTP 계층은 `postman-request`에 의존한다. 사실상 유지보수가 멈춘 상태로 보이므로 신규 채택은 권장하지 않음 |

근거: [atlassian-python-api 저장소][atlassian-python], [Jira 기능 문서][python-jira-docs], [pycontribs/jira][pycontribs-jira], [jira-client][jira-client], [jira-client npm 메타데이터][jira-client-npm].

일반적인 설치형 지원이 정확히 사내 Jira 9.15.1의 모든 설정과 호환된다는 의미는 아니다. 실제 사이트의 생성 화면 필수 필드와 계정 권한을 포함해 테스트한다.

### 6.3 TypeScript 서버에서는 작은 REST 어댑터도 적절

Tevro가 초기부터 Jira API 전체를 사용할 필요는 없다. 이슈 생성과 이슈 간 링크 생성은 공식 REST API로 제공되므로, 필요한 범위만 호출하는 어댑터도 합리적인 선택이다. Jira 9.15.1 REST 문서에서도 `POST /rest/api/2/issue`(단건 생성), `POST /rest/api/2/issue/bulk`(일괄 생성), `POST /rest/api/2/issueLink`, `GET /rest/api/2/issueLinkType`을 확인할 수 있다. [Jira 이슈 생성 API 예제][jira-create], [Jira 이슈 링크 API][jira-link-api], [Jira 9.15.1 REST 문서][jira-rest-9151]

TypeScript 서버에서 Jira 9.x를 대상으로 하면 유지보수 중인 Node.js SDK는 사실상 없다. `jira.js`는 9.x를 지원하지 않고(§6.1), `jira-client`는 2022-11 이후 릴리스가 없다(§6.2). [ADR-0001](./adr/0001-tech-stack.md)에서 서버를 TypeScript로 정했으므로 이 조건이 Tevro에 그대로 적용된다. 이에 따라 ADR-0001은 서버의 JiraAdapter 경계 뒤에 작은 REST 어댑터를 두기로 정했다(2026-10-08 채택). 사내 Jira가 10.0 이상이 되면 `jira.js` 6.3 이상 정식판을 재평가한다(§6.1).

```text
JiraAdapter — 개념 인터페이스, 최종 메서드 명세 아님
  ├─ 연결·권한 확인
  ├─ 프로젝트·이슈 유형·필수 필드 조회 (Jira 9.x에서는 아래 대체 엔드포인트 사용)
  ├─ 이슈 생성
  ├─ 이슈 상태 조회
  ├─ 링크 유형 조회
  └─ 이슈 간 링크 생성
```

어댑터를 설계할 때 대상 버전에서 확인할 사항은 다음과 같다. 2026-10-07에 공개 문서로 확인한 내용이며 사내 Jira에서 호출해 본 결과는 아니다.

| 항목 | 확인 내용 | 설계 시 고려 |
| --- | --- | --- |
| 이슈 유형·필수 필드 조회 | 위 이슈 생성 예제가 쓰는 구 createmeta 방식(`GET /rest/api/2/issue/createmeta?projectKeys=…&expand=projects.issuetypes.fields`)은 Jira 9.0에서 제거되었다. 9.15.1 REST 문서에는 대체 엔드포인트 `GET /rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes`와 `GET /rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}`가 있다 | 대체 엔드포인트를 사용하고 `startAt`·`maxResults` 페이지네이션을 처리한다. 생성 전 필수 필드 확인(F-J07)과 일괄 생성(F-J05, F-J06)의 전제다 |
| 인증 | 위 예제는 기본 인증(`curl -u`)을 쓴다. 개인 액세스 토큰은 Jira Server/Data Center 8.14 이상에서 제공되며 `Authorization: Bearer` 헤더로 전달한다 | 개인 액세스 토큰을 우선 검토한다. 사내 Jira에서 기본 인증이 허용되는지는 확인 항목으로 둔다 |

출처: [createmeta REST 엔드포인트 제거 안내][jira-createmeta-removal], [Jira 9.15.1 REST 문서][jira-rest-9151], [Jira 개인 액세스 토큰 사용 안내][jira-pat].

권장 선택 원칙은 다음과 같다.

- Python 서버를 선택했다면 `atlassian-python-api` 또는 `pycontribs/jira`를 비교한다. ADR-0001에서 TypeScript 서버를 채택했으므로 현재는 해당하지 않는다.
- TypeScript 서버(ADR-0001 채택)에서는 작은 REST 어댑터로 연동한다(ADR-0001). 대상이 Jira 9.x인 동안은 비교할 Node.js SDK가 사실상 없다. 사내 Jira가 10.0 이상이 되면 `jira.js` 6.3 이상 정식판과 REST 어댑터를 다시 비교한다.
- Jira SDK 하나를 사용하기 위해 별도 언어의 실행환경을 추가하지 않는다.
- SDK 선택과 관계없이 인증·요청·응답 처리는 어댑터 뒤로 숨기고, 공정·템플릿 규칙이 SDK의 객체 구조에 직접 의존하지 않게 한다.

### 6.4 SDK가 대신 해결하지 않는 부분

| Tevro가 책임질 부분 | 필요한 처리 |
| --- | --- |
| 공정과 이슈 매핑 | Tevro 공정 ID와 Jira 사이트·이슈 ID·키 보존 |
| 연결 방향 | A → B가 Jira에서도 A가 선행 조건이라는 뜻으로 반영되는지 검증 |
| 상태 해석 | Jira 상태명과 Tevro 상태의 매핑, 확인 불가 상태 구분 |
| 일부 생성 실패 | 성공한 이슈와 실패한 이슈·관계를 각각 기록 |
| 응답 미수신 | 실제 생성 여부를 모르면 결과 미확인으로 남기고 재생성 전에 확인 |
| 중복 방지 | 이미 연결된 공정과 생성 완료된 관계를 무조건 다시 생성하지 않음 |
| 템플릿 재사용 | 복제본에 원본 Jira 이슈 키를 그대로 가져오지 않음 |
| 삭제 영향 | Tevro 공정·매핑 삭제를 Jira 이슈 자동 삭제로 처리하지 않음 |

인증정보는 Tevro 서버에서 관리하고 브라우저의 일반 공정 데이터에 포함하지 않는다. 생성·링크·조회는 계정의 Jira 권한 범위에서만 동작해야 한다. Jira 양방향 전 필드 동기화는 이번 추천 조합에 포함된 기성 기능으로 간주하지 않는다.

## 7. Confluence 연동

### 7.1 초기 요구에는 SDK가 필요하지 않음

현재 요구는 공정에 Confluence 페이지 링크를 등록하고 클릭하여 여는 것이다. 이 범위에서는 URL 저장·수정·삭제·표시만 구현한다. 제목이나 본문을 자동 수집하기 위해 인증정보를 추가하거나 SDK를 도입하지 않는다.

페이지를 열 때의 인증과 열람 권한은 Confluence에 맡긴다. Tevro에 URL이 등록돼 있다는 이유만으로 모든 사용자가 해당 문서를 볼 수 있다고 표현하지 않는다.

### 7.2 API 연동이 필요해지는 경우

| 추가 요구 | 필요한 접근 |
| --- | --- |
| 페이지 제목·본문 표시 | 페이지 조회 API |
| Confluence 문서 검색 | 검색 API |
| 공정 설명을 문서로 생성·수정 | 페이지 생성·수정 API |
| Jira 이슈에도 참고 문서 링크 등록 | Jira Remote Link API 검토. Confluence 본문 수집과는 별개 |

Python 기반 `atlassian-python-api`에는 Confluence 페이지 조회·검색·생성·수정 기능과 설치형 지원이 문서화돼 있다. 실제 적용할 때는 Cloud와 설치형의 클라이언트·API를 구분한다. [Confluence 기능 문서][python-confluence-docs]

Jira 이슈에 외부 페이지 링크를 달아주는 경우에는 Jira Remote Link API가 별도 선택지다. 이는 Tevro에서 Confluence 문서를 읽고 관리하는 기능과 구분한다. [Jira Remote Link 안내][jira-remote-link]

## 8. CLI와 AI 에이전트 지원

### 8.1 Commander.js

- 패키지: `commander`
- 라이선스: MIT
- 공식 저장소: [Commander.js][commander]

명령·하위 명령, 옵션과 인자 해석, 필수 입력, 도움말, 사용 오류 처리에 활용한다. 구조화된 업무 결과, 서버 통신, 권한 검사, 도메인 오류 해석은 Tevro에서 구현한다. [Commander.js][commander]

주 버전에 따라 실행 조건이 다르다. 2026-10-07 확인 기준은 다음과 같다. [Commander.js CHANGELOG][commander-changelog]

| 주 버전 | 조건 |
| --- | --- |
| 15.x (15.0.0, 2026-05-29) | ESM 전용. Node.js 22.12.0 이상 필요 |
| 14.x | 2027-05까지 보안 업데이트 제공 |

현재 지원되는 Node.js LTS 계열(22.12.0 이상의 22, 24)은 15.x의 조건을 충족한다. ADR-0001에서 채택한 Node.js 26(2026-10-28 LTS 전환 예정, 2029-04-30 EOL)도 이 조건을 충족한다. 20 계열은 2026-04-30에 지원이 끝났다. [Node.js 릴리스 일정][node-release] 따라서 이 변경이 Commander.js 채택(ADR-0001)을 바꾸지는 않는다. 영향은 CLI를 실행할 호스트의 Node.js 버전과 CLI 배포 형태(Node 패키지 또는 런타임을 포함한 단일 실행 파일) 결정 수준이며, 이 결정은 [ADR-0007](./adr/0007-cli-contract.md)에서 다룬다. Commander.js의 채택 주 버전(14.x 또는 15.x)은 아직 정하지 않았고, ADR-0007에서 정한다.

```sh
# 문법 예시이며 최종 CLI 계약이나 실행 가능한 구현을 의미하지 않음
tevro task list --project <project-id> --json
tevro task add --project <project-id> --title "GitLab CI 구성"
tevro task add --project <project-id> --parent <task-id> --title "온라인 거래 개발"
tevro dependency add --project <project-id> --from <task-a-id> --to <task-c-id>
tevro jira publish --project <project-id> --dry-run --json
```

### 8.2 CLI 설계 원칙

GUI와 CLI는 같은 서버 API를 사용한다. CLI가 DB를 직접 변경하거나 별도 로컬 상태를 원본으로 갖지 않게 한다.

AI 에이전트가 사용하는 명령에는 안정적인 ID, 비대화형 실행, 기계가 해석할 수 있는 출력, 예측 가능한 오류 코드, 변경 대상 확인이 필요하다. 라이브러리는 이 중 명령 해석 기반을 제공하며, 나머지는 제품의 인터페이스 계약으로 정의한다.

Jira 일괄 생성처럼 외부 데이터를 만드는 명령에는 미리 보기와 실행을 구분한다. 내부에 LLM 서비스나 에이전트 런타임을 탑재할 필요는 없다.

## 9. 권장 연결 구조와 데이터 경계

아래 구조는 역할 분리를 설명하는 제안이다. 서버·웹·CLI는 TypeScript(Node.js 26)로, 웹은 React SPA 정적 빌드로 정했다(ADR-0001). HTTP 프레임워크([ADR-0006](./adr/0006-server-api-contract.md))는 미정이다. 저장소는 SQLite, Node.js 드라이버는 `better-sqlite3`로 정했다([ADR-0003](./adr/0003-storage-and-concurrency.md)). 배포는 Node.js 런타임 동봉 압축 파일 + systemd 단일 프로세스로 정했다([ADR-0002](./adr/0002-deployment-packaging.md)).

```text
브라우저 GUI (React SPA, 서버가 정적 파일 제공)
  ├─ 공정 카드·상세 패널: Tevro (React 컴포넌트)
  ├─ 노드·연결 조작: React Flow (계층은 하위 흐름)
  └─ 자동 배치: Dagre (층마다 실행), 필요 시 ELK.js
          │
          │ Tevro 서버 API
          │
CLI ──────┤
Commander │
          ▼
Tevro 서버 (Node.js + TypeScript)
  ├─ 인증·권한·입력 검증
  ├─ 공정·계층·종속성·상태 규칙
  ├─ 템플릿 복제와 실행본 분리
  ├─ Jira 매핑·상태 조회·실패 복구
  └─ 저장·동시 수정 처리 (쓰기는 BEGIN IMMEDIATE로 하나씩)
          │
          ├─ SQLite (better-sqlite3, 같은 호스트 로컬 디스크)
          └─ JiraAdapter ── 사내 Jira

Confluence: 초기에는 공정에 URL만 저장하고 브라우저에서 페이지 열기
```

그래프 편집기의 내부 노드 JSON을 제품의 영구 데이터 모델로 그대로 확정하지 않는다. 다음을 분리하는 것이 좋다.

| 데이터 | 예 | 관리 원칙 |
| --- | --- | --- |
| 공정의 업무 정보 | ID, 제목, 설명, 실행 상태, 데드라인 | Tevro 도메인 데이터 |
| 공정의 관계 | 선행 ID, 후속 ID(종속성). 이와 별도로 공정이 갖는 상위 공정 ID(포함관계, 선택) | 화면과 독립적으로 검증·저장. 포함관계는 종속성 데이터에 섞지 않고 공정에 둔다 |
| 표시 정보 | 노드 좌표, 뷰포트, 선택 상태, 접힘 상태 | 업무 정보와 구분. 영속화 여부와 범위는 별도 결정. 좌표를 저장하면 별도 테이블에 두고 구조 리비전·공정 버전을 올리지 않는다(ADR-0003) |
| 연동 정보 | Jira 사이트·이슈 ID·키, 마지막 조회 결과 | 도메인 관계와 연결하되 인증정보는 별도 보호. 조회 결과는 별도 테이블에 두고 구조 리비전·공정 버전을 올리지 않는다(ADR-0003) |

노드를 움직였다고 종속성이 바뀌거나, 이름을 바꿨다고 연결이 끊겨서는 안 된다. 노드를 상위 노드 영역 안으로 끌어다 놓았다는 이유만으로 포함관계를 바꾸지도 않는다. 상위 변경은 영향을 확인하는 명시적인 작업이다(F-H08). 레이아웃 엔진과 화면 라이브러리를 바꿔도 공정·템플릿·Jira 매핑을 보존할 수 있는 경계를 목표로 한다.

영속 저장소는 SQLite이고 Node.js 드라이버는 `better-sqlite3`다([ADR-0003](./adr/0003-storage-and-concurrency.md), 2026-10-08 채택). 내장 `node:sqlite`(Node.js 26 문서 기준 Stability 1.2 Release candidate)도 검토했으나 채택하지 않았다. 결정권자가 `better-sqlite3`를 고른 사유는 기록되지 않았다. [node:sqlite][node-sqlite]

2026-10-08에 확인한 `better-sqlite3`의 공개 정보는 다음과 같다. 사내 설치·동작 검증 결과는 아니다.

| 항목 | 확인 내용 | 출처 |
| --- | --- | --- |
| 최신판·라이선스 | 13.0.3, MIT | [npm 메타데이터][better-sqlite3-npm] |
| 실행 조건·의존성 | `engines.node` `>=22`. 의존성 `node-addon-api` `^8.0.0` | [npm 메타데이터][better-sqlite3-npm] |
| 미리 빌드된 바이너리 | npm 패키지에 install 스크립트가 없다. 패키지 안 `prebuilds/`에 darwin-arm64, darwin-x64, linux-arm64, linux-x64, linuxmusl-arm64, linuxmusl-x64, win32-arm64, win32-x64 등의 `.node` 바이너리가 들어 있다(npm 패키지 압축 파일을 직접 확인). README도 주요 플랫폼·아키텍처용 미리 빌드된 바이너리를 제공한다고 밝힌다. 따라서 설치할 때 외부 다운로드가 없고 내부 npm 미러로 설치할 수 있다 | [npm 메타데이터][better-sqlite3-npm], [better-sqlite3 README][better-sqlite3] |
| 번들 SQLite | 기본 배포는 SQLite 3.53.4를 번들한다 | [컴파일 문서][better-sqlite3-compilation] |
| API 방식 | 동기식 API다. 트랜잭션 함수에 deferred·immediate·exclusive 변형이 있고, immediate는 `BEGIN IMMEDIATE`를 쓴다 | [README][better-sqlite3], [API 문서][better-sqlite3-api] |
| 온라인 백업 | `.backup(destination)`은 SQLite 온라인 백업을 수행하고 promise를 돌려준다. 백업 중에도 DB를 계속 쓸 수 있다. 같은 연결이 바꾼 내용은 백업에 반영되지만 다른 연결이 바꾸면 백업이 처음부터 다시 시작된다. 그래서 온라인 백업을 쓰면 쓰기 연결을 하나로 두라고 권한다 | [API 문서][better-sqlite3-api] |

Tevro에 적용할 때의 설계 판단은 다음과 같다.

- 모든 쓰기 트랜잭션을 immediate 변형(`BEGIN IMMEDIATE`)으로 연다. 쓰기가 하나씩 처리되어 프로젝트 단위 구조 변경 직렬화가 충족된다(ADR-0003).
- 쓰기 연결을 하나로 두는 것을 제안한다. 단일 writer 모델과 온라인 백업 권고가 같은 방향이다. 백업·복구 방식과 시점은 ADR-0003 §3의 제안(첫 운영 설치 전 완성)이며 결정권자 확인 전이다. 업데이트 전 백업은 [ADR-0002](./adr/0002-deployment-packaging.md)에서 채택했다(PRD N-04, AC-24).
- 동기식 API이므로 쿼리가 실행되는 동안 Node.js 이벤트 루프가 막힌다. 프로젝트 그래프가 작다는 가정에 기대며, 예상 규모(동시 사용자, 프로젝트당 공정 수, 계층 깊이)는 확인 대상이다(ADR-0003).
- 대상 서버의 OS·아키텍처가 위 미리 빌드된 바이너리 목록에 있는지는 확인이 필요하다(§11.2).

## 10. 직접 구현해야 하는 핵심

| 영역 | 재사용 가능한 기반 | Tevro의 책임 |
| --- | --- | --- |
| GUI | React Flow(ADR-0001 채택) | 공정 카드·상세 패널·상태 편집 경험 |
| 자동 정렬 | Dagre 또는 ELK.js | 크기·관계 변환, 수동 위치 보존 정책 |
| 그래프 검증 | Graphlib 또는 자체 순수 함수 | 프로젝트 경계·ID·중복·순환 규칙과 서버 적용 |
| 계층 | React Flow 하위 흐름(`parentId`) | 트리 검증, 형제 규칙, 상속 판정, 자동 완료, 접기·펼치기 집계 |
| 상태 | 폼 UI·조회 라이브러리 등 | 실행 상태와 선행 조건의 구분, 비강제 진행 |
| 템플릿 | 일반 저장·복사 기능 | 새 ID, 새 공정끼리 관계 복제, 실행 상태·Jira 매핑 초기화 |
| Jira | REST API·SDK | 매핑, 필수 필드 처리, 일부 실패·중복·결과 미확인 복구 |
| Confluence | 초기에는 웹 링크 | 선택 정보 관리, 문서 열람과 제품 권한의 구분 |
| CLI | Commander.js | 서버 API 호출, 구조화 출력, 오류·인증·안전한 변경 계약 |
| 운영 | 채택한 서버·저장 기술(Node.js 26, SQLite + better-sqlite3) | 폐쇄망 설치, 영속성, 백업·복구, 인증·권한·동시 수정 |

템플릿 재사용은 화면 JSON을 복사하는 기능이 아니다. 공정과 관계를 새 실행본으로 구성하고, 원본과 독립적으로 유지하는 도메인 기능이다. 그래프 저장·복원 예제를 도입하는 것만으로 서버 기반 프로젝트 관리가 완성되는 것도 아니다.

## 11. 라이선스와 폐쇄망 도입 시 확인할 사항

### 11.1 라이선스 검토 범위

앞의 라이선스 표기는 코어 저장소 또는 패키지 메타데이터를 바탕으로 정리한 후보 정보다. 사내 도입 승인이나 모든 배포 형태의 법적 적합성을 보장하지 않는다.

채택할 버전에 대해 LICENSE·NOTICE·저작권 표시, 직접·전이 의존성, 추가 플러그인, 유료 예제·템플릿의 사용 조건을 확인한다. MIT 후보라는 이유로 모든 예제·아이콘·확장까지 같은 조건이라고 가정하지 않는다. 예를 들어 React Flow 코어는 MIT이지만 Pro 예제·템플릿은 xyflow Pro License를 따른다(§3.2). 특히 ELK.js와 JointJS는 MIT 후보들과 별도로 조건을 확인한다.

공개 저장소의 현재 파일은 바뀔 수 있다. 최종 채택 기록에는 패키지명, 고정 버전, 소스 태그 또는 커밋, 라이선스 근거, 반입한 배포물의 식별 정보를 남긴다.

### 11.2 폐쇄망 배포 체크리스트

- JavaScript·CSS·폰트·아이콘 등 실행 자산을 배포물에 포함하고 외부 CDN을 필수로 사용하지 않는다.
- 선택한 버전과 의존성을 고정하고, 내부 패키지 저장소 또는 반입 절차로 재현 가능한 설치 경로를 마련한다.
- CLI를 실행할 호스트(개발자 PC, AI 에이전트 실행 환경)의 Node.js 버전이 채택한 CLI 의존성의 요구 조건(예: Commander.js 15.x의 Node.js 22.12.0 이상)을 충족하는지 확인한다. 충족하지 않으면 런타임을 포함한 단일 실행 파일 번들을 검토한다. 결정은 [ADR-0007](./adr/0007-cli-contract.md)에서 다룬다.
- `better-sqlite3`의 미리 빌드된 바이너리(`prebuilds/`)가 대상 서버의 OS·아키텍처를 포함하는지 확인한다. 2026-10-08에 확인한 목록은 §9에 있다. 목록에 없으면 설치 전에 대응 방법을 정한다. [better-sqlite3 README][better-sqlite3]
- ELK.js Worker를 사용한다면 Worker 스크립트도 내부 배포 경로에서 제공한다. [ELK.js][elk]
- 외부 인증, 외부 라이선스 확인, 원격 텔레메트리 등의 실행 의존성이 있는지는 실제 배포 조합에서 점검한다.
- Jira 인증정보는 브라우저 번들, CLI의 일반 출력, 프로젝트 JSON에 포함하지 않는다.
- 사내 인증서와 내부 URL을 지원하되 인증서 검증을 일괄 해제하지 않는다.
- 외부 인터넷을 차단한 환경에서 GUI·CLI 기본 기능을 실제 실행해 본다.
- Jira 연결 실패가 공정 작성·조회·템플릿 사용까지 중단시키지 않도록 한다.

이 체크리스트는 라이브러리가 사내 배포에 적합한지 검증하기 위한 조건이다. 오픈소스라는 이유만으로 네트워크 비의존이나 보안 승인이 자동으로 보장되는 것은 아니다.

## 12. 채택 전 작은 검증 작업

공정 A·B·C·D를 만들고 A → C, B → C를 연결한다. D는 독립 공정으로 둔다. A 완료·B 진행 중·C 미착수 상태를 사용한다. 이 예제 하나로 편집·배치·서버 검증의 핵심을 확인한다.

계층 확인을 위해 같은 예제를 확장한다. 상위 공정 '개발'을 만들고 그 아래 하위 공정 X·Y를 둔다. A → 개발, 개발 → B를 연결한다. X·Y는 A의 완료를 상속받은 선행 조건으로 가지며, B의 선행 조건은 개발의 완료(= X·Y 전부 완료)다. 개발을 접으면 A → 개발 → B만 보이고, 펼치면 그 안의 X·Y가 보인다.

| 검증 대상 | 확인할 결과 | 관련 요구사항 |
| --- | --- | --- |
| GUI 편집 | 제목·상태·링크 조작과 노드 드래그가 충돌하지 않음 | F-P03~F-P05, F-S02, F-M01, F-G04 |
| 전체 그래프 | 완료한 공정과 독립 공정 D도 표시 | F-G01 |
| 연결 생성 | 다중 선행관계와 방향이 명확하고 수정·삭제 가능 | F-D01~F-D03 |
| 순환 방지 | C → A 추가 시 GUI와 CLI 모두 서버에서 거부 | F-D04, F-D06 |
| 선행 조건 | C에 B 미완료를 표시하되 C의 진행 상태 변경은 차단하지 않음 | F-S03, F-S04 |
| 자동 배치 | 카드 크기·긴 제목을 고려하고 수동 위치와 자동 정렬을 구분 | F-G05 |
| 계층 표시 | 사용자 정의 상위 노드 안의 하위 배치, 접기·펼치기와 개수·완료 수 표시, 접힌 상태에서 상위 간 연결만 | F-H07 |
| 계층 검증 | 다른 층 연결·자손 상위 지정이 GUI·CLI 모두 서버에서 거부 | F-H02, F-H03, AC-27, AC-29 |
| 상속·자동 완료 | X·Y 선행에 A 포함, X·Y 완료 시 개발 자동 완료 | F-H04, F-H05, AC-25, AC-28 |
| 템플릿 | 두 프로젝트의 새 ID·관계·상태·Jira 매핑이 독립적 | F-T04~F-T08 |
| Jira 시험 연동 | 시험용 이슈 생성·링크 방향·상태 조회를 확인하고 부분 실패 표시 | F-J01, F-J05~F-J14 |
| GUI·CLI 일치 | 같은 공정 ID와 저장 결과를 양쪽에서 확인 | F-C01, F-C04, F-C08 |
| 폐쇄망 | 외부 인터넷 없이 기본 기능이 동작 | N-01~N-03 |
| Node.js 26 도구 호환성 | React·React Flow 웹 빌드(Vite 등)와 서버·CLI 실행이 Node.js 26에서 동작 | ADR-0001 |

위 F·N·AC ID는 [제품 요구사항](./product-requirements.md)의 항목이다. 시험용 Jira 이슈 생성도 외부 데이터 변경이므로 명시적으로 정한 시험 대상과 권한 범위에서 수행한다. 이 문서는 그 실행을 완료했다고 주장하지 않는다.

## 13. 현재 결론과 미결정 사항

**우선 검증할 조합은 React Flow + Dagre + Commander.js다.** React Flow는 [ADR-0001](./adr/0001-tech-stack.md)에서 채택한 React 프런트엔드의 그래프 라이브러리다. Commander.js도 ADR-0001에서 CLI 명령 해석 라이브러리로 채택했고, 주 버전은 ADR-0007에서 정한다. Dagre는 채택한 TypeScript 단일 언어 구성에서 쓸 후보이며, 고정 버전과 함께 스파이크로 확인한다. 앞선 검토의 1차 조합은 Svelte Flow + Dagre + Commander.js였고, 프런트엔드가 React로 정해지면 React Flow로 대체한다고 적었다. ADR-0001에서 React를 채택해 그래프 라이브러리만 React Flow로 바뀌었고 Svelte Flow는 채택하지 않았다(§3.1). Graphlib 도입 여부는 작은 자체 함수와 비교해 정한다. 계층 요구로 그래프 편집기는 하위 흐름(중첩 노드) 지원이 필수 확인 항목이 되었다. React Flow의 하위 흐름은 공식 문서로 확인했고(§3.2), 접기·펼치기와 층별 배치는 Tevro가 구현한다(§4.1). 공식 접기·펼치기 예제는 Pro 전용이므로 코어(MIT)만으로 구현하는 것을 제안한다(§3.2).

**Jira는 TypeScript 서버의 JiraAdapter 경계 뒤에 작은 REST 어댑터로 연동한다(ADR-0001 채택).** 대상이 Jira 9.x인 동안 이 방식을 쓰고, 사내 Jira가 10.0 이상이 되면 `jira.js` 6.3 이상 정식판을 재평가한다(§6.1, §6.3). 실제 사내 설정에서의 동작은 먼저 확인한다. Confluence는 현재 요구대로 링크 저장부터 시작한다.

서버 언어(TypeScript 단일), 프런트엔드 프레임워크(React), 웹 빌드 방식(SPA 정적 빌드), Node.js 주 버전(26 LTS), CLI 구성(Node.js + TypeScript + Commander.js), Jira 연동 방식(작은 REST 어댑터)은 ADR-0001에서 결정했다. 저장소(SQLite)와 Node.js 드라이버(`better-sqlite3`)는 ADR-0003에서 결정했다(§9). 아직 결정하지 않은 사항은 HTTP 프레임워크(ADR-0006), 인증 방식, CLI 배포 형태와 Commander.js 주 버전(ADR-0007), Graphlib 도입 여부, 그래프 라이브러리의 채택 버전, 배치·좌표 저장 정책(층별 좌표와 접힘 상태 포함), Jira 상태 매핑, CLI의 최종 문법과 출력 계약이다. 이 문서는 후보 비교와 구현 경계를 제시한다. 기존 제품 요구사항의 기능 범위를 임의로 확대하지 않으며, 기술 선택은 ADR에서 확정한다.

착수 전에 필요한 결정은 [착수 전 결정 기록(ADR)](./adr/README.md)에 정리되어 있다. 프런트엔드·서버·CLI 기술 구성을 다룬 [ADR-0001](./adr/0001-tech-stack.md)은 2026-10-08에 채택되었다. 폐쇄망 배포 형태를 다룬 [ADR-0002](./adr/0002-deployment-packaging.md)도 같은 날 채택되었다(Node.js 동봉 압축 파일 + systemd). 저장소와 동시 수정을 다룬 [ADR-0003](./adr/0003-storage-and-concurrency.md)도 같은 날 채택되었다(SQLite + better-sqlite3). 인증·권한은 [ADR-0004](./adr/0004-authentication-authorization.md), CLI 계약과 배포 형태는 [ADR-0007](./adr/0007-cli-contract.md)에서 다루며 모두 제안 상태다. 제안 상태의 ADR은 채택된 결정이 아니다.

## 14. 참고 자료

아래 링크는 앞선 검토에 사용한 공식 문서와 프로젝트 저장소다. 2026-10-07 재확인과 2026-10-08 ADR-0001·ADR-0003 반영 때 추가한 출처도 함께 둔다. 기능과 라이선스는 실제 채택할 릴리스 기준으로 다시 확인한다.

### GUI 및 그래프

- [React Flow][react-flow]
- [@xyflow/react npm 메타데이터 — 최신 안정판·게시일·라이선스 확인][xyflow-react-npm]
- [@xyflow/react 최신판 메타데이터 — peer·런타임 의존성 확인][xyflow-react-npm-latest]
- [react npm 메타데이터 — 최신 안정판 확인][react-npm]
- [React Flow 하위 흐름(sub flows) — `parentId`·`extent: 'parent'`·노드 순서 확인][react-subflows]
- [xyflow 저장소][xyflow]
- [React Flow Pro — 코어 MIT·요금제·FAQ 확인][react-pro]
- [xyflow Pro License — Pro 예제 사용·재배포 조건 확인][xyflow-pro-license]
- [React Flow 예제 목록 — 그룹 예제의 Pro 여부 확인][rf-examples]
- [React Flow Pro 예제 목록 — 레이아웃 예제의 Pro 여부 확인][rf-pro-examples]
- [React Flow Expand and Collapse 예제 — Pro 전용 확인][rf-expand-collapse]
- [React Flow 레이아웃 안내][flow-layout]
- [React Flow Dagre 예제 — 무료 공개 확인][rf-dagre]
- [React Flow 순환 방지 예제 — 무료 공개 확인][prevent-cycles]
- [Vite npm 메타데이터 — 최신 안정판·Node 요구 범위 확인][vite-npm]
- [Svelte Flow — 검토했으나 채택하지 않음][svelte-flow]
- [Svelte Flow 사용자 정의 노드][svelte-custom]
- [Svelte Flow 하위 흐름(sub flows) — `parentId`·`extent: 'parent'` 확인][svelte-subflows]
- [AntV X6 저장소][x6]
- [X6 History 플러그인][x6-history]
- [X6 Cell API — 상위·하위 노드 관계 확인][x6-cell-api]
- [Cytoscape.js — compound nodes 확인][cytoscape]
- [Cytoscape.js edgehandles 확장][edgehandles]
- [Cytoscape.js expand-collapse 확장 — 유지보수 중단 안내 확인][cytoscape-expand-collapse]
- [JointJS 저장소][jointjs]
- [Dagre 저장소][dagre]
- [Graphlib 저장소][graphlib]
- [ELK.js 저장소][elk]
- [ELK.js 패키지 메타데이터][elk-package]
- [Mermaid 소개][mermaid]

### 저장소

- [better-sqlite3 npm 메타데이터 — 최신판·라이선스·Node 요구 범위·의존성 확인, 패키지 압축 파일의 `prebuilds/` 확인][better-sqlite3-npm]
- [better-sqlite3 저장소·README — 동기식 API, 미리 빌드된 바이너리 제공 확인][better-sqlite3]
- [better-sqlite3 컴파일 문서 — 번들 SQLite 버전 확인][better-sqlite3-compilation]
- [better-sqlite3 API 문서 — 트랜잭션 변형(immediate = `BEGIN IMMEDIATE`)과 `.backup()` 확인][better-sqlite3-api]
- [Node.js node:sqlite — 검토했으나 채택하지 않음][node-sqlite]

### Jira·Confluence·CLI

- [atlassian-python-api 저장소][atlassian-python]
- [atlassian-python-api Jira 문서][python-jira-docs]
- [atlassian-python-api Confluence 문서][python-confluence-docs]
- [pycontribs/jira 저장소][pycontribs-jira]
- [jira-client 저장소][jira-client]
- [jira-client npm 메타데이터 — 최신판·게시일 확인][jira-client-npm]
- [jira.js 저장소 — Cloud·자체 호스팅 지원 범위 확인][jira-js]
- [jira.js npm 메타데이터 — 안정판·RC 버전과 실행 조건 확인][jira-js-npm]
- [Atlassian End of Support Policy][atlassian-eos]
- [Atlassian Data Center 제품 EOL 안내][jira-dc-eol]
- [Atlassian Jira 이슈 생성 API 예제 — createmeta 부분은 Jira 9.0에서 제거됨][jira-create]
- [Atlassian Jira createmeta REST 엔드포인트 제거 안내][jira-createmeta-removal]
- [Atlassian Jira 9.15.1 REST API 문서][jira-rest-9151]
- [Atlassian Jira 개인 액세스 토큰 사용 안내][jira-pat]
- [Atlassian Jira 이슈 링크 API — 사내 버전과 별도 대조 필요][jira-link-api]
- [Atlassian Jira Remote Link 안내][jira-remote-link]
- [Commander.js 저장소][commander]
- [Commander.js CHANGELOG][commander-changelog]
- [Node.js 릴리스 일정][node-release]

[svelte-flow]: https://svelteflow.dev/
[svelte-custom]: https://svelteflow.dev/learn/customization/custom-nodes
[svelte-subflows]: https://svelteflow.dev/learn/layouting/sub-flows
[react-flow]: https://reactflow.dev/
[xyflow-react-npm]: https://registry.npmjs.org/@xyflow/react
[xyflow-react-npm-latest]: https://registry.npmjs.org/@xyflow/react/latest
[react-npm]: https://registry.npmjs.org/react
[react-subflows]: https://reactflow.dev/learn/layouting/sub-flows
[xyflow]: https://github.com/xyflow/xyflow
[react-pro]: https://reactflow.dev/pro
[xyflow-pro-license]: https://xyflow.com/pro-license
[rf-examples]: https://reactflow.dev/examples
[rf-pro-examples]: https://reactflow.dev/pro/examples
[rf-expand-collapse]: https://reactflow.dev/examples/layout/expand-collapse
[flow-layout]: https://reactflow.dev/learn/layouting/layouting
[rf-dagre]: https://reactflow.dev/examples/layout/dagre
[prevent-cycles]: https://reactflow.dev/examples/interaction/prevent-cycles
[vite-npm]: https://registry.npmjs.org/vite
[x6]: https://github.com/antvis/X6
[x6-history]: https://x6.antv.antgroup.com/tutorial/plugins/history
[x6-cell-api]: https://x6.antv.antgroup.com/en/api/model/cell
[cytoscape]: https://js.cytoscape.org/
[edgehandles]: https://github.com/cytoscape/cytoscape.js-edgehandles
[cytoscape-expand-collapse]: https://github.com/iVis-at-Bilkent/cytoscape.js-expand-collapse
[jointjs]: https://github.com/clientIO/joint
[dagre]: https://github.com/dagrejs/dagre
[graphlib]: https://github.com/dagrejs/graphlib
[elk]: https://github.com/kieler/elkjs
[elk-package]: https://github.com/kieler/elkjs/blob/master/package.json
[mermaid]: https://mermaid.js.org/intro/
[better-sqlite3-npm]: https://registry.npmjs.org/better-sqlite3
[better-sqlite3]: https://github.com/WiseLibs/better-sqlite3
[better-sqlite3-compilation]: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md
[better-sqlite3-api]: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
[node-sqlite]: https://nodejs.org/api/sqlite.html
[atlassian-python]: https://github.com/atlassian-api/atlassian-python-api
[python-jira-docs]: https://atlassian-python-api.readthedocs.io/jira.html
[python-confluence-docs]: https://atlassian-python-api.readthedocs.io/confluence.html
[pycontribs-jira]: https://github.com/pycontribs/jira
[jira-client]: https://github.com/jira-node/node-jira-client
[jira-client-npm]: https://registry.npmjs.org/jira-client
[jira-js]: https://github.com/MrRefactoring/jira.js
[jira-js-npm]: https://registry.npmjs.org/jira.js
[atlassian-eos]: https://confluence.atlassian.com/support/atlassian-end-of-support-policy-201851003.html
[jira-dc-eol]: https://www.atlassian.com/licensing/data-center-end-of-life
[jira-create]: https://developer.atlassian.com/server/jira/platform/jira-rest-api-example-create-issue-7897248/
[jira-createmeta-removal]: https://confluence.atlassian.com/jiracore/createmeta-rest-endpoint-to-be-removed-975040986.html
[jira-rest-9151]: https://docs.atlassian.com/software/jira/docs/api/REST/9.15.1/
[jira-pat]: https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html
[jira-link-api]: https://developer.atlassian.com/server/jira/platform/rest/v11000/api-group-issuelink/
[jira-remote-link]: https://support.atlassian.com/jira/kb/how-to-use-rest-api-to-add-remote-links-in-jira-issues/
[commander]: https://github.com/tj/commander.js
[commander-changelog]: https://github.com/tj/commander.js/blob/master/CHANGELOG.md
[node-release]: https://github.com/nodejs/Release

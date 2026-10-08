# ADR-0001: 서버·웹·CLI 기술 구성

- 상태: 채택 (Accepted)
- 작성일: 2026-10-07
- 개정: 2026-10-07 공정 계층 요구 반영
- 결정일: 2026-10-08
- 결정권자: 프로젝트 담당자(soonsm)
- 관련 문서:
  - PRD: [제품 요구사항](../product-requirements.md) §3.2 원칙 7, §6.2 F-D04·F-D06, §6.8 F-C01·F-C08, §6.9 F-H07, §8 N-02·N-03과 마지막 문단, §11 초기 핵심, §13-1
  - OSS: [오픈소스와 구현 경계](../open-source-components.md) §1, §3.1~§3.2, §5.1~§5.2, §6.1~§6.3, §8.1, §11.1, §13
  - 선행 ADR: 없음
  - 후속 ADR: [ADR-0002](./0002-deployment-packaging.md), [ADR-0003](./0003-storage-and-concurrency.md), [ADR-0004](./0004-authentication-authorization.md), [ADR-0006](./0006-server-api-contract.md), [ADR-0007](./0007-cli-contract.md)

## 배경

PRD §8 마지막 문단은 개발 언어, 프런트엔드 프레임워크, 그래프 라이브러리, DB, 컨테이너·OpenShift 사용 여부를 확정하지 않는다. §13-1은 서버·웹·CLI 기술 구성을 구현 전 결정 사항으로 둔다.

이 ADR 작성 당시(2026-10-07) OSS §1의 추천(Svelte Flow + Dagre + Commander.js)은 'Svelte 프런트엔드와 Node.js CLI를 선택한다는 조건'에서 낸 조건부 추천이었다. 서버 언어는 정하지 않았고, 이 전제를 채택했다는 기록도 없었다. 현재 OSS는 이 ADR의 결정을 반영했다.

PRD §11 초기 핵심(서버·웹, 프로젝트와 공정, DAG 연결·검증·표시, 실행 상태, 저장, 대응 CLI)의 어느 계층도 이 결정 없이 착수할 수 없다. 서버 언어가 정해져야 다음이 정해진다.

| 정해지는 것 | 근거 |
| --- | --- |
| 서버 DAG 검증을 어디에, 무엇으로 구현할지 | F-D04, F-D06, OSS §5.2 |
| GUI와 CLI가 같은 계약을 어떻게 공유할지 | 원칙 7, F-C01, F-C08 |
| 폐쇄망에 반입·패치할 런타임 수 | N-03, OSS §11.2 |
| Jira 연동 구현 방식(4단계) | OSS §6.3 |

프런트엔드 프레임워크(Svelte 또는 React)도 이 ADR의 결정 범위다. 작성 당시 OSS §13은 '프런트엔드가 React로 정해지면 React Flow로 대체한다'고 적어 프런트엔드가 미정이었다. 이 ADR에서 React로 정했다.

## 결정

2026-10-08 결정권자가 선택지 A(TypeScript 단일 언어)를 채택했다.

제안과 달라진 점: 프런트엔드는 Svelte로 제안했으나 결정권자가 React를 선택했다.

| 계층 | 결정 |
| --- | --- |
| 서버 | Node.js 26 LTS + TypeScript. HTTP 프레임워크는 계약 생성 방식([ADR-0006](./0006-server-api-contract.md))과 함께 정한다 |
| 웹 | React + React Flow(`@xyflow/react`). Vite 등으로 빌드한 SPA 정적 파일을 API 서버가 함께 제공 |
| CLI | Node.js + TypeScript + Commander.js. 배포 형태는 [ADR-0007](./0007-cli-contract.md)에서 정한다 |
| 공용 코드 | API 계약 타입(ADR-0006의 OpenAPI에서 생성), DAG 검증 순수 함수 |
| Jira(4단계) | 서버의 JiraAdapter 경계 뒤에 작은 REST 어댑터 |

세부 결정은 다음과 같다.

1. DAG 검증의 판정 권한은 서버에만 둔다(F-D06). 같은 검증 함수를 웹의 사전 피드백에 재사용할 수 있지만, 웹의 판정으로 저장 여부를 정하지 않는다.
2. CLI는 로컬에서 그래프를 검증하지 않는다. 사전 검증이 필요하면 서버의 dry-run(ADR-0006)을 쓴다. 그래야 GUI와 CLI의 결과가 같은 판정에서 나온다(원칙 7).
3. 검증 함수는 Graphlib(`@dagrejs/graphlib`)와 작은 자체 함수 중에서 스파이크로 고른다(OSS §5.1, §5.2). 어느 쪽이든 순환 오류에는 순환 경로를 담는다(ADR-0006).
4. 웹은 SPA 정적 빌드로 만든다. Vite 등으로 빌드하고 SSR 프레임워크(Next.js 등)는 쓰지 않는다. 근거는 아래 '프런트엔드 빌드 방식'에 둔다.
5. Node.js 주 버전은 26 LTS로 한다. 빌드·테스트 도구의 26 호환성은 스파이크에서 확인한다. 예를 들어 Vite 8.3.3(2026-10-08 최신 안정판)의 `engines.node` 선언은 `^20.19.0 || >=22.12.0`이라 26을 포함한다. 선언 범위일 뿐이므로 실제 동작은 스파이크에서 본다. [vite npm][vite-npm]
6. 채택 패키지의 패키지명, 고정 버전, 라이선스 근거를 기록한다(OSS §11.1).

이번 결정에서 정하지 않고 열어 둔 것은 다음과 같다.

| 항목 | 정하는 곳 |
| --- | --- |
| DAG 검증에 Graphlib를 쓸지 자체 함수를 쓸지 | 스파이크(세부 결정 3) |
| HTTP 프레임워크 | [ADR-0006](./0006-server-api-contract.md) |
| CLI 배포 형태 | [ADR-0007](./0007-cli-contract.md) |
| 서버 배포 형태 | [ADR-0002](./0002-deployment-packaging.md) |

Node.js LTS 일정은 다음과 같다. 2026-10-07에 확인했고, 일정은 바뀔 수 있다고 공지되어 있다. [Node.js 릴리스 일정][node-release] 결정일(2026-10-08)에 26은 아직 Current이고, 2026-10-28에 Active LTS로 전환될 예정이다.

| 주 버전 | 2026-10-07 상태 | Maintenance 시작 | 지원 종료(EOL) |
| --- | --- | --- | --- |
| 22 | Maintenance LTS | 2025-10-21 | 2027-04-30 |
| 24 | Active LTS | 2026-10-20 | 2028-04-30 |
| 26 | Current. 2026-10-28 Active LTS 전환 예정 | 2027-10-20 | 2029-04-30 |

### 프런트엔드 빌드 방식

| 방식 | 평가 |
| --- | --- |
| SPA 정적 빌드(React + Vite 등) — 채택 | 정적 파일만 생성한다. API 서버가 함께 제공하므로 운영 프로세스가 하나다. 화면의 모든 데이터가 `/api/v1`을 거친다 |
| SSR 프레임워크(Next.js 등) — 채택하지 않음 | 렌더링용 서버 런타임이 필요하다. 서버에서 화면 데이터를 불러오는 코드가 공개 API를 거치지 않고 도메인·DB에 직접 접근하는 두 번째 경로가 되기 쉽다(원칙 7, F-C08 위험) |

제안 단계에서는 Svelte 기준으로 'SPA 정적 빌드(Svelte + Vite, 또는 SvelteKit SPA 모드: `adapter-static` + `ssr = false` + fallback 페이지)'와 'SvelteKit SSR'을 비교했다. 프런트엔드를 React로 정하면서 이 Svelte 기준 비교는 검토했으나 채택하지 않은 안으로 남긴다. SPA를 고른 근거는 프레임워크와 관계없으므로 그대로 유지한다.

앞선 검토 의견은 'CDN에 의존하지 않기 때문'을 SPA의 근거로 들었다. 그러나 SSR 자체가 CDN 의존을 뜻하지는 않으므로 근거를 다음과 같이 고친다.

- 정적 자산을 배포물에 고정 포함하고 외부 요청이 없는지 검사하기 쉽다(N-02, OSS §11.2).
- 운영 프로세스가 하나다(N-03).
- GUI가 CLI와 같은 API만 쓰게 된다(원칙 7, F-C08).

SvelteKit 문서는 SPA 모드의 단점으로 첫 화면 표시 지연, 검색 노출 불리, JavaScript 없이 사용할 수 없음을 든다. [SvelteKit SPA][sveltekit-spa] 이 단점은 프레임워크가 아니라 브라우저에서 화면을 그리는 SPA 방식에서 오므로 React SPA에도 같은 성격으로 적용된다고 본다. Tevro는 사내 도구이고 그래프 편집기 자체가 JavaScript로 동작하므로 이 단점의 영향은 작다고 본다. 첫 화면 시간은 스파이크에서 측정한다.

## 검토한 선택지

### 선택지 A: TypeScript 단일 언어 (Node.js 서버 + Svelte SPA + Node CLI) — 채택(웹은 React)

결정권자는 이 선택지를 채택하면서 웹을 Svelte 대신 React로 정했다(아래 '프런트엔드 프레임워크').

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 낮음~중간. 언어와 빌드 도구가 하나다. 서버·웹·CLI·공용 코드를 한 저장소의 패키지로 나눌 수 있다 |
| 폐쇄망 반입·운영 부담 | 실행 런타임이 Node.js 하나다(N-03). 웹 빌드 도구도 Node.js에서 동작하므로 빌드 환경도 하나다. 다만 npm 전이 의존성이 많아 라이선스·반입 검토량은 크다(OSS §11.1) |
| GUI·CLI 동등성(원칙 7) | 서버·웹·CLI가 같은 생성 타입을 쓴다. DTO와 오류 코드 불일치를 컴파일 단계에서 줄인다 |
| 관련 요구사항 적합성 | F-D06: 서버 도메인 모듈에서 Graphlib 또는 자체 함수를 쓸 수 있다(OSS §5.1). F-J01~F-J14: REST 어댑터를 직접 구현해야 한다 |
| 팀 숙련도 | 확인 필요. 팀 전체의 TypeScript·Node.js 서버 경험과 React 경험은 확인하지 않았다. OSS §3.2는 Svelte를 '익숙한' 프레임워크로 언급한다 |

장점:

- 반입·패치할 런타임과 빌드 도구가 하나다.
- 계약 타입 공유로 원칙 7을 구조적으로 지원한다.
- DAG 검증 함수를 서버 판정과 웹 사전 피드백에 함께 쓸 수 있다.

단점:

- Jira 9.x용으로 유지보수 중인 Node.js SDK가 사실상 없다. `jira-client`는 최신판 8.2.2(2022-11-03) 이후 릴리스와 커밋이 없다. [jira-client npm][jira-client-npm] `jira.js` 6.x 안정판(6.2.0)은 Cloud용이다. 6.3(2026-10-07 현재 RC 단계)부터 지원하는 자체 호스팅 Jira도 10.0 이상이며 9.x는 지원하지 않는다. [jira.js 저장소][jira-js], [jira.js npm][jira-js-npm] 따라서 REST 어댑터를 직접 작성·유지보수한다(OSS §6.3).
- npm 생태계의 전이 의존성이 많아 공급망·라이선스 검토 부담이 있다.

### 선택지 B: Python 서버 + Svelte SPA + Node CLI — 채택하지 않음

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 중간. 서버는 Python, 웹·CLI는 TypeScript로 두 언어다 |
| 폐쇄망 반입·운영 부담 | 실행 런타임이 두 개다(서버 Python, CLI Node.js). CLI를 단일 실행 파일로 번들하면 CLI 호스트의 Node.js는 필요 없다. 웹 빌드에는 여전히 Node.js 도구가 필요해 빌드 환경도 두 언어다. Python 패키지 반입 경로도 따로 필요하다 |
| GUI·CLI 동등성(원칙 7) | OpenAPI 코드 생성에 기댄다. 서버 모델과 생성 타입의 동기화를 빌드 절차로 보장해야 한다 |
| 관련 요구사항 적합성 | F-D06: DAG 검증을 Python으로 구현한다. 웹 사전 피드백을 쓰려면 TypeScript로 한 번 더 구현해야 하고, 두 구현의 판정이 갈릴 위험이 있다. Jira: 설치형 지원을 표방하는 SDK(`atlassian-python-api` Apache-2.0, `pycontribs/jira` BSD-2-Clause)를 쓸 수 있다(OSS §6.2) |
| 팀 숙련도 | 확인 필요 |

장점:

- 설치형 Jira용 SDK 선택지가 있다.
- 팀이 Python에 더 익숙하다면 서버 생산성이 높을 수 있다.

단점:

- 런타임과 패키지 반입 경로가 두 개다.
- 계약 공유가 생성 도구와 빌드 절차에 의존한다.
- Jira는 4단계 선택 연동이다(원칙 4, §11). 초기 핵심에 없는 Jira SDK를 이유로 서버 언어를 정하는 것은 OSS §1('SDK 때문에 서버 언어를 바꾸지 않음')과 §6.3('Jira SDK 하나를 사용하기 위해 별도 언어의 실행환경을 추가하지 않는다')의 원칙과 맞지 않는다.

### 프런트엔드 프레임워크: Svelte 대 React

| 기준 | Svelte + `@xyflow/svelte` | React + `@xyflow/react` |
| --- | --- | --- |
| 복잡도 | 같은 xyflow 계열이라 비슷함 | 같은 xyflow 계열이라 비슷함 |
| 폐쇄망 반입·운영 부담 | 정적 번들. 차이 작음 | 정적 번들. 차이 작음 |
| GUI·CLI 동등성(원칙 7) | 차이 없음. 둘 다 같은 API를 씀 | 차이 없음 |
| 관련 요구사항 적합성 | 공정 카드를 일반 Svelte 컴포넌트로 작성(OSS §3.1). 1.7.0 기준 MIT이고 Svelte `^5.25.0`을 peer 의존성으로 요구 [npm][xyflow-svelte-npm] | 같은 계열 React 라이브러리. 최신 안정판 12.12.0(2026-09-24 게시) 기준 MIT [npm][xyflow-react-npm]. peer 의존성은 `react`·`react-dom` `>=17`이고 `@types/react`·`@types/react-dom` `>=17`은 선택(optional)이다. 런타임 의존성은 `zustand` `^4.4.0`, `classcat` `^5.0.3`, `@xyflow/system` 0.0.83이다 [12.12.0 메타데이터][xyflow-react-npm-latest]. React 최신 안정판은 19.3.0(2026-09-09 게시)이다 [npm][react-npm]. 코어는 MIT이고 구독 없이 상업 프로젝트에 쓸 수 있다. Pro 예제·템플릿은 별도 조건(OSS §3.2, [React Flow Pro][react-flow-pro]) |
| 팀 숙련도 | OSS §3.2가 '익숙한 Svelte'로 언급. 팀 전체는 확인 필요 | 확인 필요 |
| 결정 | 검토했으나 채택하지 않음 | 채택(2026-10-08) |

React를 채택했다. 그래프 라이브러리는 React Flow(`@xyflow/react`)다. 결정권자의 선택 사유는 기록되지 않았다. OSS §13이 적은 대로 그래프 라이브러리만 React Flow로 바뀌고, 서버 검증·SPA 정적 빌드·CLI 구성은 제안과 같다.

제안 단계에서는 OSS 1차 추천 조합과 같고 문서상 익숙한 프레임워크로 언급되어 있다는 이유로 Svelte를 제안했다. 이 안은 검토했으나 채택하지 않았다.

공정 계층(PRD §6.9 F-H07)은 React Flow 하위 흐름으로 표시한다. 2026-10-08에 공식 문서로 확인한 내용은 다음과 같다. [React Flow 하위 흐름][react-flow-subflows]

- 노드에 `parentId`를 지정하면 위치가 상위 노드 기준 상대 좌표가 된다. `{ x: 0, y: 0 }`이 상위의 왼쪽 위 모서리다. `parentId`는 11.11.0에서 `parentNode`의 이름을 바꾼 것이다.
- 문서는 `parentId`가 하는 일이 상대 위치 지정뿐이며, 마크업상 실제 자식 요소가 되는 것은 아니라고 설명한다.
- 상위 노드가 `nodes` 또는 `defaultNodes` 배열에서 하위 노드보다 먼저 와야 한다.
- 하위 노드에 `extent: 'parent'`를 주면 상위 밖으로 끌어낼 수 없다. 주지 않으면 상위 밖으로 끌 수 있지만, 상위를 옮기면 하위도 함께 움직인다.
- 상위에는 `group` 외의 노드 유형도 쓸 수 있다. `group`은 핸들이 없는 편의용 유형이다. 문서는 '다른 어떤 유형'이라고만 하고 사용자 정의 노드를 따로 명시하지 않는다. 사용자 정의 공정 노드를 상위로 쓰는 것은 스파이크에서 확인한다.
- 같은 그룹 안의 노드끼리, 하위 흐름과 바깥 노드 사이에도 연결을 만들 수 있다. 라이브러리가 다른 층과의 연결을 막지 않으므로 형제 규칙(F-H03)은 서버가 검증한다. 상위가 있는 노드에 연결된 에지는 노드 위에 그려지며, 겹침 순서는 `zIndex`로 조정한다.

React Flow의 'Expand and Collapse' 예제는 Pro 전용이다(xyflow Pro License). [Expand and Collapse 예제][react-flow-expand-collapse] 그룹 관련 'Selection Grouping'·'Parent Child Relation' 예제와 자동 배치 관련 'Auto Layout'·'Dynamic Layouting'·'Force Layout' 예제도 Pro다. [React Flow 예제][react-flow-examples], [Pro 예제][react-flow-pro-examples] Pro 예제 코드의 사용 조건은 유효한 구독을 전제로 한 xyflow Pro License가 정한다. [xyflow Pro License][xyflow-pro-license]

접기·펼치기는 Tevro가 직접 구현하며 Pro 예제 코드를 복제한다고 가정하지 않는다(OSS §3.2). 하위 개수·완료 수 표시도 Tevro가 구현하고, 깊은 중첩의 동작은 스파이크에서 본다([README 스파이크 시나리오](./README.md)).

무료로 공개된 예제 중 참고할 것은 다음과 같다.

| 예제 | 내용 | Tevro에서의 용도 |
| --- | --- | --- |
| Sub Flow | 하위 흐름 기본 구성 | 공정 계층 표시(F-H07) [React Flow 예제][react-flow-examples] |
| Dagre Tree | `@dagrejs/dagre`로 자동 배치. 페이지는 더 발전된 배치 라이브러리로 d3-hierarchy와 elkjs도 권한다 | 층별 자동 배치(OSS §4) [Dagre Tree][react-flow-dagre] |
| Preventing Cycles | `isValidConnection` 콜백과 `getOutgoers`로 새 연결이 순환을 만드는지 검사 | 웹 사전 피드백 참고. 판정은 서버가 한다(세부 결정 1) [Preventing Cycles][react-flow-prevent-cycles] |

## 트레이드오프

- 런타임 하나와 계약 공유를 얻는 대신 Jira 9.x 연동 코드를 직접 유지보수한다. 범위는 JiraAdapter의 6개 연산 수준이다(OSS §6.3).
- REST 어댑터는 대상 버전의 API 변화를 직접 따라가야 한다. 예를 들어 구 createmeta 방식(`GET /rest/api/2/issue/createmeta?projectKeys=…`)은 Jira 9.0에서 제거되었다. 9.15.1 문서에는 대체 엔드포인트 `GET /rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes`와 `…/issuetypes/{issueTypeId}`가 있고 페이지네이션을 처리해야 한다. [createmeta 제거 안내][jira-createmeta-removal], [Jira 9.15.1 REST][jira-rest-9151] 이 내용은 OSS §6.3에도 반영되어 있다.
- SPA는 첫 화면 표시가 SSR보다 느릴 수 있다. 사내 도구라 수용할 수 있다고 보지만 측정 전 판단이다.
- React Flow의 접기·펼치기, 그룹화, 자동 배치 전환 예제는 Pro 전용이다. 이 기능은 공개 문서와 무료 예제를 바탕으로 Tevro가 직접 구현한다.
- 검토했으나 채택하지 않은 Svelte 안에는 'Svelte 생태계는 React보다 작아 필요한 UI 컴포넌트를 직접 만들 가능성이 있다'는 트레이드오프가 있었다.

## 결과

쉬워지는 것:

- 반입·패치 대상 런타임과 빌드 도구가 Node.js 하나로 줄어든다.
- 계약 타입은 서버·웹·CLI가, DAG 검증 함수는 서버와 웹(사전 피드백)이 공유한다.
- ADR-0006의 OpenAPI 생성물을 웹과 CLI가 같은 언어로 쓴다.

어려워지는 것:

- Jira 어댑터를 직접 작성하고 사내 Jira에서 시험해야 한다(4단계).
- npm 의존성의 라이선스·반입 검토 범위가 넓다.
- 공정 계층의 접기·펼치기와 하위 개수·완료 수 표시를 Pro 예제에 기대지 않고 직접 만든다.

다시 검토할 시점:

- 숙련도 확인 결과 팀의 TypeScript 서버 경험이나 React 경험이 부족할 때.
- 사내 Jira가 10.0 이상으로 업그레이드될 때. `jira.js` 6.3 이상 정식판을 SDK 후보로 재평가한다(OSS §6.1). 사내 Jira 9.15는 2026-03-27에 지원이 끝났고, Jira Data Center 제품군은 2029-03-28 EOL 이후 읽기 전용이 된다. [Atlassian 지원 종료 정책][atlassian-eos], [Data Center EOL][jira-dc-eol] 업그레이드 가능성은 PRD §6.7 '대상 Jira 환경'과 §13-6에 정리되어 있다.
- 채택한 Node.js 26 LTS의 지원 종료(2029-04-30) 전.

## 남은 확인 사항

채택 시점(2026-10-08)에 아래 사항은 아직 확인되지 않았다. 확인 결과가 이 결정과 맞지 않으면 새 ADR을 써서 이 ADR을 대체한다([README §1](./README.md)).

| 항목 | 확인 대상 |
| --- | --- |
| 팀의 TypeScript·Node.js 서버 경험과 React 경험 | 프로젝트 담당자, 개발 참여자 |
| 사내 표준 언어·런타임 정책(허용 런타임 목록이 있는지) | 사내 아키텍처·보안 담당 |
| 내부 npm 미러 유무 | 사내 인프라 담당([ADR-0002](./0002-deployment-packaging.md)) |
| 사내에서 허용하는 Node.js 버전 정책(26 사용 가능 여부) | 사내 인프라 담당 |
| 빌드·테스트 도구의 Node.js 26 호환성 | 스파이크([README 스파이크 시나리오](./README.md)) |
| 사용자 정의 공정 노드를 하위 흐름의 상위로 쓸 수 있는지, 접기·펼치기와 깊은 중첩의 동작 | 스파이크 |
| 사내 Jira 업그레이드·이전 계획(대상 버전과 시점) | 사내 Jira 관리자(PRD §13-6) |
| 오픈소스 반입 승인 단위(패키지별인지, 전이 의존성까지인지) | 사내 보안·법무 담당(OSS §11.1) |

## 후속 작업

- [x] 결정권자를 지정한다(2026-10-08, 프로젝트 담당자 soonsm).
- [ ] '남은 확인 사항'을 수집한다.
- [ ] OSS §12의 A·B·C·D 예제로 스파이크를 수행한다([README 스파이크 시나리오](./README.md)).
- [ ] Graphlib 도입 여부를 자체 함수와 비교해 정한다.
- [ ] 스파이크에서 빌드·테스트 도구의 Node.js 26 호환성을 확인한다(세부 결정 5).
- [ ] 채택 패키지의 고정 버전·라이선스 근거를 기록한다(OSS §11.1).
- [ ] 서버·웹·CLI·공용 코드 패키지 구조 초안을 만든다.
- [x] OSS §1·§13을 채택 결과로 갱신한다(2026-10-08).
- [x] PRD §8 마지막 문단과 §13-1을 채택 결과로 갱신한다(2026-10-08).
- [ ] ADR-0006 §1의 'ADR-0001 선택지 B(Python 서버)를 고르면' 조건문을 ADR-0006 결정 때 정리한다. 선택지 B는 채택하지 않았다.

## 출처

2026-10-07에 확인했다.

- [Node.js 릴리스 일정][node-release]
- [@xyflow/svelte npm 메타데이터][xyflow-svelte-npm] — 검토했으나 채택하지 않은 Svelte 안의 근거
- [SvelteKit 단일 페이지 앱 문서][sveltekit-spa]
- [jira-client npm 메타데이터][jira-client-npm], [jira-client 저장소][jira-client]
- [jira.js npm 메타데이터][jira-js-npm], [jira.js 저장소][jira-js]
- [Jira createmeta REST 엔드포인트 제거 안내][jira-createmeta-removal]
- [Jira 9.15.1 REST API 문서][jira-rest-9151]
- [Atlassian End of Support Policy][atlassian-eos]
- [Atlassian Data Center end of life][jira-dc-eol]

2026-10-08에 확인했다.

- [@xyflow/react npm 메타데이터][xyflow-react-npm], [@xyflow/react 12.12.0 메타데이터][xyflow-react-npm-latest]
- [react npm 메타데이터][react-npm]
- [vite npm 메타데이터][vite-npm]
- [React Flow 하위 흐름 문서][react-flow-subflows]
- [React Flow 예제 목록][react-flow-examples], [React Flow Pro 예제 목록][react-flow-pro-examples]
- [React Flow Expand and Collapse 예제][react-flow-expand-collapse]
- [React Flow Dagre Tree 예제][react-flow-dagre]
- [React Flow Preventing Cycles 예제][react-flow-prevent-cycles]
- [React Flow Pro][react-flow-pro]
- [xyflow Pro License][xyflow-pro-license]

[node-release]: https://github.com/nodejs/Release
[xyflow-svelte-npm]: https://registry.npmjs.org/@xyflow/svelte
[sveltekit-spa]: https://svelte.dev/docs/kit/single-page-apps
[jira-client-npm]: https://registry.npmjs.org/jira-client
[jira-client]: https://github.com/jira-node/node-jira-client
[jira-js-npm]: https://registry.npmjs.org/jira.js
[jira-js]: https://github.com/MrRefactoring/jira.js
[jira-createmeta-removal]: https://confluence.atlassian.com/jiracore/createmeta-rest-endpoint-to-be-removed-975040986.html
[jira-rest-9151]: https://docs.atlassian.com/software/jira/docs/api/REST/9.15.1/
[atlassian-eos]: https://confluence.atlassian.com/support/atlassian-end-of-support-policy-201851003.html
[jira-dc-eol]: https://www.atlassian.com/licensing/data-center-end-of-life
[xyflow-react-npm]: https://registry.npmjs.org/@xyflow/react
[xyflow-react-npm-latest]: https://registry.npmjs.org/@xyflow/react/latest
[react-npm]: https://registry.npmjs.org/react
[vite-npm]: https://registry.npmjs.org/vite
[react-flow-subflows]: https://reactflow.dev/learn/layouting/sub-flows
[react-flow-examples]: https://reactflow.dev/examples
[react-flow-pro-examples]: https://reactflow.dev/pro/examples
[react-flow-expand-collapse]: https://reactflow.dev/examples/layout/expand-collapse
[react-flow-dagre]: https://reactflow.dev/examples/layout/dagre
[react-flow-prevent-cycles]: https://reactflow.dev/examples/interaction/prevent-cycles
[react-flow-pro]: https://reactflow.dev/pro
[xyflow-pro-license]: https://xyflow.com/pro-license

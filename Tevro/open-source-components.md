# Tevro — 활용 가능한 오픈소스와 구현 경계

- 문서 상태: 기술 검토 및 추천안. 기술 스택 채택이나 구현 완료를 의미하지 않음.
- 작성 기준일: 2026-09-26
- 관련 문서: [해결하려는 문제와 제품 요구사항](./product-requirements.md)
- 목적: 공정 GUI 편집, DAG 배치·검증, Jira·Confluence 연동, CLI 구현에 활용할 기존 오픈소스를 정리하고 Tevro가 직접 구현할 부분을 구분한다.
- 근거 범위: 앞선 검토에서 확인한 공식 문서·공개 저장소를 정리한 문서다. 사내 Jira 및 폐쇄망에서 설치·동작을 검증한 결과는 아니다. 실제 채택 시 릴리스별 기능·라이선스·유지보수 상태를 다시 확인한다.

> 그래프를 그리고 조작하는 기술은 기존 라이브러리를 활용한다. Tevro는 공정의 의미, 선행 조건, 템플릿 재사용, Jira 매핑과 상태의 일관성에 집중한다.

## 1. 추천 조합 요약

Svelte 프런트엔드와 Node.js CLI를 선택한다는 조건에서의 1차 추천이다. 서버 언어는 아직 확정하지 않는다.

| 역할 | 1차 후보 | 판단 |
| --- | --- | --- |
| GUI 공정 카드·연결 편집 | Svelte Flow (`@xyflow/svelte`) | 일반 Svelte 컴포넌트로 공정 카드를 만들고 노드·연결 조작을 맡기는 방식 |
| React를 선택할 때의 GUI 대안 | React Flow (`@xyflow/react`) | 프런트엔드 선택에 따라 대체. Svelte Flow와 동시에 사용할 이유는 없음 |
| DAG 자동 배치 | Dagre (`@dagrejs/dagre`) | 초기 계층형 배치와 자동 정렬부터 검증 |
| 복잡한 배치의 대안 | ELK.js (`elkjs`) | 포트·중첩 구조·연결선 경로의 요구가 커질 때 검토 |
| 그래프 자료구조·알고리즘 | Graphlib (`@dagrejs/graphlib`) | TypeScript/JavaScript에서 활용 가능. 순환 검사만 필요하면 작은 자체 함수도 선택지 |
| Jira API 접근 | 서버 언어에 맞는 SDK 또는 작은 REST 어댑터 | 설치형 Jira 지원 여부를 우선 확인. SDK 때문에 서버 언어를 바꾸지 않음 |
| Confluence | 초기에는 URL 저장·표시 | 현재 요구에는 SDK나 페이지 본문 수집이 필요하지 않음 |
| CLI 명령 해석 | Commander.js (`commander`) | 명령·옵션·도움말 처리를 재사용하고 Tevro API 호출은 직접 구현 |
| 문서용 그래프 출력 | Mermaid | 주 GUI 편집기 대신 후속 내보내기 기능의 후보 |

이 추천은 해당 라이브러리만 조합하면 제품 전체가 완성된다는 뜻이 아니다. 공정 데이터, 상태, 템플릿, 인증·권한, 저장, 외부 연동의 실패 복구는 Tevro의 구현 범위로 남는다. 각 후보의 기능 근거는 아래 절과 참고 자료에 정리한다.

## 2. 먼저 구분해야 할 세 가지 역할

| 역할 | 해결하는 문제 | 대표 후보 |
| --- | --- | --- |
| 그래프 편집·렌더링 | 노드와 연결선을 표시하고 드래그·선택·연결·확대·축소를 제공 | Svelte Flow, React Flow, X6, Cytoscape.js, JointJS |
| 자동 배치 | 노드의 위치와 필요에 따라 연결선 경로를 계산 | Dagre, ELK.js |
| 업무 모델·규칙 | 공정의 상태, 선행 조건, 템플릿 복제, Jira 매핑을 정의·검증·저장 | Tevro에서 구현 |

예를 들어 공정 C에 선행 공정 A·B가 연결된 경우, 편집기는 카드와 연결선을 보여주고 배치 엔진은 좌표를 계산한다. A 완료·B 진행 중이라는 상태로부터 C의 선행 조건이 미충족이라고 판단하는 것은 Tevro의 규칙이다.

화면에서 연결선을 만들 수 있다는 사실만으로 DAG가 보장되거나, 선행 조건 판정·서버 저장·Jira 동기화까지 제공되는 것은 아니다.

## 3. GUI 공정·연결 편집

### 3.1 Svelte Flow — 우선 후보

- 패키지: `@xyflow/svelte`
- 코어 라이브러리 라이선스: MIT
- 공식 문서: [Svelte Flow][svelte-flow]
- 저장소: [xyflow][xyflow]

Svelte Flow는 노드 기반 편집기와 인터랙티브 다이어그램을 구성하는 라이브러리다. 노드 이동, 화면 이동·확대·축소, 선택, 연결 생성 같은 기본 동작을 제공한다. 사용자 정의 노드는 일반적인 Svelte 컴포넌트로 작성하고, 입력 요소나 버튼 등도 넣을 수 있다. [Svelte Flow][svelte-flow], [사용자 정의 노드][svelte-custom]

| Tevro 기능 | 적용 방식 | 직접 구현할 부분 |
| --- | --- | --- |
| 공정 카드 표시 | 공정 하나를 노드 하나로 표현 | 제목·상태·기한·링크의 표시 구성 |
| 선후관계 연결 | 노드의 연결 지점인 Handle과 방향 있는 연결선 사용 | 선행·후속 의미, 서버 저장, 순환 검증 |
| 상태 수정 | 사용자 정의 노드 또는 상세 패널에 선택 UI 배치 | 상태 변경 API, 실패 처리, Jira 상태 원본 규칙 |
| 내용 편집 | 선택한 노드에 대응하는 상세 패널 제공 | 설명 편집기와 저장 처리 |
| 그래프 탐색 | 이동·확대·축소·선택·미니맵 등을 활용 | 기본 화면 구성과 선택 공정 강조 방식 |
| 공정 추가·삭제 | Tevro의 도구 모음·상세 패널에서 노드 작업 수행 | 새 공정 ID 발급, 연결 정리, 삭제 영향 확인 |

공정 카드를 `TaskNode.svelte` 같은 컴포넌트로 작성하는 방식이 적합하다. 다만 라이브러리에 노드 안 입력 UI를 넣을 수 있다는 것과, 완성된 공정 관리 폼을 제공한다는 것은 다르다.

Tevro 적용 시 특히 확인할 사항은 한글 입력 중의 단축키 충돌, 텍스트 선택과 노드 드래그의 구분, 상태 선택 상자 조작, 링크 클릭, 긴 제목과 상세 패널의 사용성이다. 이는 채택 전 검증 항목이지 이미 검증된 성능·호환성 결과가 아니다.

### 3.2 React Flow — React를 선택할 경우

- 패키지: `@xyflow/react`
- 코어 라이브러리 라이선스: MIT
- 공식 문서: [React Flow][react-flow]
- 저장소: [xyflow][xyflow]

React Flow는 같은 계열의 React용 노드 편집 라이브러리다. 프런트엔드를 React로 선택한다면 이쪽을 사용한다. 그래프 편집 라이브러리 때문에 익숙한 Svelte를 반드시 버릴 필요는 없다. [xyflow][xyflow]

코어 라이브러리와 Pro 구독은 구분한다. React Flow Pro는 고급 예제·템플릿·지원 등의 유료 제공 범위를 포함하지만, 코어 라이브러리 사용 자체에 Pro 구독이 필수인 것은 아니다. 유료 예제나 템플릿을 코어와 같은 조건으로 복제해도 된다고 가정하지 않는다. [React Flow Pro][react-pro]

### 3.3 대안 후보

| 후보 | 코어 라이선스 | 특징 | Tevro에서의 판단 |
| --- | --- | --- | --- |
| AntV X6 | MIT | HTML·SVG 기반 그래프 편집 엔진. 실행 취소·다시 실행 등 편집 플러그인 제공 | 도형 편집기 수준의 편집 편의성이 중요해질 때 비교 |
| Cytoscape.js | MIT | 그래프 시각화·분석 기능이 풍부하며 `edgehandles` 확장으로 연결 생성 가능 | 업무 카드 폼 편집보다 관계 탐색·분석의 비중이 커질 때 검토 |
| JointJS | MPL-2.0 | 도형·연결선·인터랙티브 다이어그램 구성 | 오픈소스 코어와 상용 JointJS+ 기능 범위를 구분한 뒤 검토 |

기능·라이선스 근거: [X6 저장소][x6], [X6 History 플러그인][x6-history], [Cytoscape.js][cytoscape], [edgehandles][edgehandles], [JointJS 저장소][jointjs].

초기에는 Svelte Flow와 X6 정도를 작은 공정 그래프로 비교하면 된다. 모든 후보로 제품 전체를 구현하거나, 아직 필요하지 않은 편집 기능 수만으로 선택하지 않는다. 별도 확장을 도입할 때는 확장 자체의 라이선스와 버전 호환성도 확인한다.

## 4. DAG 자동 배치

### 4.1 Dagre — 초기 추천

- 패키지: `@dagrejs/dagre`
- 라이선스: MIT
- 공식 저장소: [Dagre][dagre]

Dagre는 방향 있는 그래프를 계층적으로 배치하는 라이브러리다. 노드 크기와 연결 관계를 전달하고, 계산된 좌표를 그래프 편집기의 노드 위치에 적용하는 방식으로 사용한다. Flow 계열의 공식 레이아웃 안내에서도 외부 배치 엔진으로 다룬다. [Dagre][dagre], [Flow 레이아웃 안내][flow-layout]

초기 Tevro에서는 다음 흐름을 제안한다.

1. 독립 공정을 포함한 전체 공정과 연결을 배치 입력으로 변환한다.
2. 제목·상태 등의 표시를 고려한 노드 크기로 좌표를 계산한다.
3. 계산된 좌표를 화면에 반영한다.
4. 사용자가 수동으로 조정한 위치는 업무 종속성과 별도로 보존한다.
5. 관계나 상태가 바뀔 때마다 강제로 재배치하지 않고, 필요한 경우 자동 정렬을 실행한다.

과거의 `dagre` 이름과 `@dagrejs/dagre`를 혼동하지 않는다. 프로젝트는 DagreJS 조직의 패키지를 안내하므로 실제 채택 패키지와 버전을 명시한다. [Dagre][dagre]

### 4.2 ELK.js — 복잡한 배치의 대안

- 패키지: `elkjs`
- 역할: 노드·포트·연결선 배치 계산. 화면 렌더러 자체는 아님.
- 라이선스: 앞선 검토의 `package.json`에는 `EPL-2.0 OR GPL-3.0-or-later`로 표기. 실제 반입 릴리스의 LICENSE 및 포함 코드 조건을 기준으로 재확인.
- 공식 저장소: [ELK.js][elk], [패키지 메타데이터][elk-package]

| 기준 | Dagre | ELK.js |
| --- | --- | --- |
| 초기 용도 | 비교적 단순한 방향성 그래프의 계층 배치 | 포트·중첩 구조·상세 경로 요구가 있는 배치 |
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

기능 근거: [Graphlib 저장소 및 API 문서][graphlib].

백엔드가 TypeScript/JavaScript라면 도메인 모듈 내부에서 활용할 수 있다. 다른 언어의 서버를 선택하면 같은 규칙을 해당 서버에서 구현하거나 그 언어의 라이브러리를 검토한다. Graphlib를 사용하기 위해 별도 Node.js 서버를 추가할 필요는 없다.

### 5.2 서버 검증은 반드시 유지

Flow의 화면에서 순환 연결을 방지하는 예제를 적용하더라도 그것만으로 충분하지 않다. Tevro는 CLI에서도 관계를 변경하므로 GUI와 CLI의 모든 변경을 서버에서 검증해야 한다. [React Flow 순환 방지 예제][prevent-cycles]

Tevro가 검증해야 할 기본 규칙은 다음과 같다.

- 존재하지 않는 공정이나 다른 프로젝트의 공정을 참조하지 않는다.
- 자기 자신으로 연결하지 않는다.
- 같은 방향의 연결을 중복 생성하지 않는다.
- 추가·변경 결과가 순환하지 않는다.
- 여러 관계를 함께 바꿀 때 최종 변경 결과를 일관되게 검증한다.
- 공정 삭제 후 유효하지 않은 연결이 남지 않게 한다.

순환 검사만 필요하다면 작은 순수 함수로 구현하는 것도 가능하다. Graphlib의 도입 여부보다 규칙을 화면 이벤트와 분리하고 서버에서 일관되게 적용하는 것이 중요하다. 선행 조건 충족 여부는 그래프 구조뿐 아니라 공정 실행 상태가 필요하므로 Tevro에서 별도로 계산한다.

## 6. Jira 연동

### 6.1 가장 먼저 확인할 조건

대상은 사용자가 설명한 사내 설치형 Jira 9.15.1이다. Cloud용 SDK와 Server/Data Center용 SDK를 구분하고, 실제 사이트의 에디션·인증·권한·필수 필드·링크 유형은 연동 전에 확인한다.

예를 들어 `jira.js`는 공식 README에서 Cloud용 라이브러리로 설명하며 Server/Data Center를 지원하지 않는다고 안내한다. `Version2Client`라는 이름이 설치형 호환성을 보장하지는 않는다. 따라서 현재 사내 Jira의 1차 후보에서는 제외한다. [jira.js][jira-js]

### 6.2 SDK 후보

| 후보 | 언어 | 라이선스 | 활용 범위와 판단 |
| --- | --- | --- | --- |
| `atlassian-python-api` | Python | Apache-2.0 | Jira·Confluence 등 여러 Atlassian 제품의 래퍼. 설치형과 Cloud를 구분하여 지원하므로 Python 서버라면 우선 검토 |
| `pycontribs/jira` | Python | BSD-2-Clause | Jira 전용 라이브러리. Cloud 및 Server/Data Center 지원을 목표로 하므로 Jira 중심 대안 |
| `jira-client` | Node.js | MIT | 이슈 생성·조회·링크 생성 등의 래퍼. 신규 채택 전 릴리스·의존성 유지보수와 현재 런타임·인증 호환성을 특히 확인 |

근거: [atlassian-python-api 저장소][atlassian-python], [Jira 기능 문서][python-jira-docs], [pycontribs/jira][pycontribs-jira], [jira-client][jira-client].

일반적인 설치형 지원이 정확히 사내 Jira 9.15.1의 모든 설정과 호환된다는 의미는 아니다. 실제 사이트의 생성 화면 필수 필드와 계정 권한을 포함해 테스트한다.

### 6.3 TypeScript 서버라면 작은 REST 어댑터도 적절

Tevro가 초기부터 Jira API 전체를 사용할 필요는 없다. 이슈 생성과 이슈 간 링크 생성은 공식 REST API로 제공되므로, 필요한 범위만 호출하는 어댑터도 합리적인 선택이다. [Jira 이슈 생성 API 예제][jira-create], [Jira 이슈 링크 API][jira-link-api]

```text
JiraAdapter — 개념 인터페이스, 최종 메서드 명세 아님
  ├─ 연결·권한 확인
  ├─ 프로젝트·이슈 유형·필수 필드 조회
  ├─ 이슈 생성
  ├─ 이슈 상태 조회
  ├─ 링크 유형 조회
  └─ 이슈 간 링크 생성
```

권장 선택 원칙은 다음과 같다.

- Python 서버를 선택했다면 `atlassian-python-api` 또는 `pycontribs/jira`를 비교한다.
- TypeScript 서버라면 작은 REST 어댑터와 검증된 Node.js SDK를 비교한다.
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

```sh
# 문법 예시이며 최종 CLI 계약이나 실행 가능한 구현을 의미하지 않음
tevro task list --project <project-id> --json
tevro task add --project <project-id> --title "GitLab CI 구성"
tevro dependency add --project <project-id> --from <task-a-id> --to <task-c-id>
tevro jira publish --project <project-id> --dry-run --json
```

### 8.2 CLI 설계 원칙

GUI와 CLI는 같은 서버 API를 사용한다. CLI가 DB를 직접 변경하거나 별도 로컬 상태를 원본으로 갖지 않게 한다.

AI 에이전트가 사용하는 명령에는 안정적인 ID, 비대화형 실행, 기계가 해석할 수 있는 출력, 예측 가능한 오류 코드, 변경 대상 확인이 필요하다. 라이브러리는 이 중 명령 해석 기반을 제공하며, 나머지는 제품의 인터페이스 계약으로 정의한다.

Jira 일괄 생성처럼 외부 데이터를 만드는 명령에는 미리 보기와 실행을 구분한다. 내부에 LLM 서비스나 에이전트 런타임을 탑재할 필요는 없다.

## 9. 권장 연결 구조와 데이터 경계

아래 구조는 역할 분리를 설명하는 제안이다. 서버 프레임워크·DB·배포 방식은 미정이다.

```text
브라우저 GUI
  ├─ 공정 카드·상세 패널: Tevro
  ├─ 노드·연결 조작: Svelte Flow 또는 React Flow
  └─ 자동 배치: Dagre, 필요 시 ELK.js
          │
          │ Tevro 서버 API
          │
CLI ──────┤
Commander │
          ▼
Tevro 서버
  ├─ 인증·권한·입력 검증
  ├─ 공정·종속성·상태 규칙
  ├─ 템플릿 복제와 실행본 분리
  ├─ Jira 매핑·상태 조회·실패 복구
  └─ 저장·동시 수정 처리
          │
          ├─ 영속 저장소
          └─ JiraAdapter ── 사내 Jira

Confluence: 초기에는 공정에 URL만 저장하고 브라우저에서 페이지 열기
```

그래프 편집기의 내부 노드 JSON을 제품의 영구 데이터 모델로 그대로 확정하지 않는다. 다음을 분리하는 것이 좋다.

| 데이터 | 예 | 관리 원칙 |
| --- | --- | --- |
| 공정의 업무 정보 | ID, 제목, 설명, 실행 상태, 데드라인 | Tevro 도메인 데이터 |
| 공정의 관계 | 선행 ID, 후속 ID | 화면과 독립적으로 검증·저장 |
| 표시 정보 | 노드 좌표, 뷰포트, 선택 상태 | 업무 정보와 구분. 영속화 여부와 범위는 별도 결정 |
| 연동 정보 | Jira 사이트·이슈 ID·키, 마지막 조회 결과 | 도메인 관계와 연결하되 인증정보는 별도 보호 |

노드를 움직였다고 종속성이 바뀌거나, 이름을 바꿨다고 연결이 끊겨서는 안 된다. 레이아웃 엔진과 화면 라이브러리를 바꿔도 공정·템플릿·Jira 매핑을 보존할 수 있는 경계를 목표로 한다.

## 10. 직접 구현해야 하는 핵심

| 영역 | 재사용 가능한 기반 | Tevro의 책임 |
| --- | --- | --- |
| GUI | Flow 계열 또는 다른 그래프 편집기 | 공정 카드·상세 패널·상태 편집 경험 |
| 자동 정렬 | Dagre 또는 ELK.js | 크기·관계 변환, 수동 위치 보존 정책 |
| 그래프 검증 | Graphlib 또는 자체 순수 함수 | 프로젝트 경계·ID·중복·순환 규칙과 서버 적용 |
| 상태 | 폼 UI·조회 라이브러리 등 | 실행 상태와 선행 조건의 구분, 비강제 진행 |
| 템플릿 | 일반 저장·복사 기능 | 새 ID, 새 공정끼리 관계 복제, 실행 상태·Jira 매핑 초기화 |
| Jira | REST API·SDK | 매핑, 필수 필드 처리, 일부 실패·중복·결과 미확인 복구 |
| Confluence | 초기에는 웹 링크 | 선택 정보 관리, 문서 열람과 제품 권한의 구분 |
| CLI | Commander.js | 서버 API 호출, 구조화 출력, 오류·인증·안전한 변경 계약 |
| 운영 | 선택한 서버·저장 기술 | 폐쇄망 설치, 영속성, 백업·복구, 인증·권한·동시 수정 |

템플릿 재사용은 화면 JSON을 복사하는 기능이 아니다. 공정과 관계를 새 실행본으로 구성하고, 원본과 독립적으로 유지하는 도메인 기능이다. 그래프 저장·복원 예제를 도입하는 것만으로 서버 기반 프로젝트 관리가 완성되는 것도 아니다.

## 11. 라이선스와 폐쇄망 도입 시 확인할 사항

### 11.1 라이선스 검토 범위

앞의 라이선스 표기는 코어 저장소 또는 패키지 메타데이터를 바탕으로 정리한 후보 정보다. 사내 도입 승인이나 모든 배포 형태의 법적 적합성을 보장하지 않는다.

채택할 버전에 대해 LICENSE·NOTICE·저작권 표시, 직접·전이 의존성, 추가 플러그인, 유료 예제·템플릿의 사용 조건을 확인한다. MIT 후보라는 이유로 모든 예제·아이콘·확장까지 같은 조건이라고 가정하지 않는다. 특히 ELK.js와 JointJS는 MIT 후보들과 별도로 조건을 확인한다.

공개 저장소의 현재 파일은 바뀔 수 있다. 최종 채택 기록에는 패키지명, 고정 버전, 소스 태그 또는 커밋, 라이선스 근거, 반입한 배포물의 식별 정보를 남긴다.

### 11.2 폐쇄망 배포 체크리스트

- JavaScript·CSS·폰트·아이콘 등 실행 자산을 배포물에 포함하고 외부 CDN을 필수로 사용하지 않는다.
- 선택한 버전과 의존성을 고정하고, 내부 패키지 저장소 또는 반입 절차로 재현 가능한 설치 경로를 마련한다.
- ELK.js Worker를 사용한다면 Worker 스크립트도 내부 배포 경로에서 제공한다. [ELK.js][elk]
- 외부 인증, 외부 라이선스 확인, 원격 텔레메트리 등의 실행 의존성이 있는지는 실제 배포 조합에서 점검한다.
- Jira 인증정보는 브라우저 번들, CLI의 일반 출력, 프로젝트 JSON에 포함하지 않는다.
- 사내 인증서와 내부 URL을 지원하되 인증서 검증을 일괄 해제하지 않는다.
- 외부 인터넷을 차단한 환경에서 GUI·CLI 기본 기능을 실제 실행해 본다.
- Jira 연결 실패가 공정 작성·조회·템플릿 사용까지 중단시키지 않도록 한다.

이 체크리스트는 라이브러리가 사내 배포에 적합한지 검증하기 위한 조건이다. 오픈소스라는 이유만으로 네트워크 비의존이나 보안 승인이 자동으로 보장되는 것은 아니다.

## 12. 채택 전 작은 검증 작업

공정 A·B·C·D를 만들고 A → C, B → C를 연결한다. D는 독립 공정으로 둔다. A 완료·B 진행 중·C 미착수 상태를 사용한다. 이 예제 하나로 편집·배치·서버 검증의 핵심을 확인한다.

| 검증 대상 | 확인할 결과 | 관련 요구사항 |
| --- | --- | --- |
| GUI 편집 | 제목·상태·링크 조작과 노드 드래그가 충돌하지 않음 | F-P03~F-P05, F-G03 |
| 전체 그래프 | 완료한 공정과 독립 공정 D도 표시 | F-G01 |
| 연결 생성 | 다중 선행관계와 방향이 명확하고 수정·삭제 가능 | F-D01~F-D03 |
| 순환 방지 | C → A 추가 시 GUI와 CLI 모두 서버에서 거부 | F-D04, F-D06 |
| 선행 조건 | C에 B 미완료를 표시하되 C의 진행 상태 변경은 차단하지 않음 | F-S03, F-S04 |
| 자동 배치 | 카드 크기·긴 제목을 고려하고 수동 위치와 자동 정렬을 구분 | F-G05 |
| 템플릿 | 두 프로젝트의 새 ID·관계·상태·Jira 매핑이 독립적 | F-T04~F-T08 |
| Jira 시험 연동 | 시험용 이슈 생성·링크 방향·상태 조회를 확인하고 부분 실패 표시 | F-J05~F-J14 |
| GUI·CLI 일치 | 같은 공정 ID와 저장 결과를 양쪽에서 확인 | F-C01, F-C04, F-C08 |
| 폐쇄망 | 외부 인터넷 없이 기본 기능이 동작 | N-01~N-03 |

위 ID는 [제품 요구사항](./product-requirements.md)의 항목이다. 시험용 Jira 이슈 생성도 외부 데이터 변경이므로 명시적으로 정한 시험 대상과 권한 범위에서 수행한다. 이 문서는 그 실행을 완료했다고 주장하지 않는다.

## 13. 현재 결론과 미결정 사항

**우선 검증할 조합은 Svelte Flow + Dagre + Commander.js다.** Graphlib는 필요한 그래프 연산과 서버 언어에 따라 추가한다. 프런트엔드가 React로 정해지면 React Flow로 대체한다.

**Jira는 서버 언어를 정한 다음 SDK와 작은 REST 어댑터 중 선택한다.** 설치형 Jira 지원과 실제 사내 설정에서의 동작을 먼저 확인한다. Confluence는 현재 요구대로 링크 저장부터 시작한다.

아직 결정하지 않은 사항은 서버·DB·인증 방식, 그래프 라이브러리의 채택 버전, 배치·좌표 저장 정책, Jira SDK 및 상태 매핑, CLI의 최종 문법과 출력 계약이다. 이 문서는 후보 비교와 구현 경계를 제시하며, 기존 제품 요구사항의 기능 범위를 임의로 확대하거나 기술 선택을 확정하지 않는다.

## 14. 참고 자료

아래 링크는 앞선 검토에 사용한 공식 문서와 프로젝트 저장소다. 기능과 라이선스는 실제 채택할 릴리스 기준으로 다시 확인한다.

### GUI 및 그래프

- [Svelte Flow][svelte-flow]
- [Svelte Flow 사용자 정의 노드][svelte-custom]
- [React Flow][react-flow]
- [xyflow 저장소][xyflow]
- [React Flow Pro][react-pro]
- [React Flow 레이아웃 안내][flow-layout]
- [React Flow 순환 방지 예제][prevent-cycles]
- [AntV X6 저장소][x6]
- [X6 History 플러그인][x6-history]
- [Cytoscape.js][cytoscape]
- [Cytoscape.js edgehandles 확장][edgehandles]
- [JointJS 저장소][jointjs]
- [Dagre 저장소][dagre]
- [Graphlib 저장소][graphlib]
- [ELK.js 저장소][elk]
- [ELK.js 패키지 메타데이터][elk-package]
- [Mermaid 소개][mermaid]

### Jira·Confluence·CLI

- [atlassian-python-api 저장소][atlassian-python]
- [atlassian-python-api Jira 문서][python-jira-docs]
- [atlassian-python-api Confluence 문서][python-confluence-docs]
- [pycontribs/jira 저장소][pycontribs-jira]
- [jira-client 저장소][jira-client]
- [jira.js 저장소 — Cloud 지원 범위 확인][jira-js]
- [Atlassian Jira 이슈 생성 API 예제][jira-create]
- [Atlassian Jira 이슈 링크 API — 사내 버전과 별도 대조 필요][jira-link-api]
- [Atlassian Jira Remote Link 안내][jira-remote-link]
- [Commander.js 저장소][commander]

[svelte-flow]: https://svelteflow.dev/
[svelte-custom]: https://svelteflow.dev/learn/customization/custom-nodes
[react-flow]: https://reactflow.dev/
[xyflow]: https://github.com/xyflow/xyflow
[react-pro]: https://reactflow.dev/pro
[flow-layout]: https://reactflow.dev/learn/layouting/layouting
[prevent-cycles]: https://reactflow.dev/examples/interaction/prevent-cycles
[x6]: https://github.com/antvis/X6
[x6-history]: https://x6.antv.antgroup.com/tutorial/plugins/history
[cytoscape]: https://js.cytoscape.org/
[edgehandles]: https://github.com/cytoscape/cytoscape.js-edgehandles
[jointjs]: https://github.com/clientIO/joint
[dagre]: https://github.com/dagrejs/dagre
[graphlib]: https://github.com/dagrejs/graphlib
[elk]: https://github.com/kieler/elkjs
[elk-package]: https://github.com/kieler/elkjs/blob/master/package.json
[mermaid]: https://mermaid.js.org/intro/
[atlassian-python]: https://github.com/atlassian-api/atlassian-python-api
[python-jira-docs]: https://atlassian-python-api.readthedocs.io/jira.html
[python-confluence-docs]: https://atlassian-python-api.readthedocs.io/confluence.html
[pycontribs-jira]: https://github.com/pycontribs/jira
[jira-client]: https://github.com/jira-node/node-jira-client
[jira-js]: https://github.com/MrRefactoring/jira.js
[jira-create]: https://developer.atlassian.com/server/jira/platform/jira-rest-api-example-create-issue-7897248/
[jira-link-api]: https://developer.atlassian.com/server/jira/platform/rest/v11000/api-group-issuelink/
[jira-remote-link]: https://support.atlassian.com/jira/kb/how-to-use-rest-api-to-add-remote-links-in-jira-issues/
[commander]: https://github.com/tj/commander.js

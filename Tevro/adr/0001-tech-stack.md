# ADR-0001: 서버·웹·CLI 기술 구성

- 상태: 제안 (Proposed)
- 작성일: 2026-10-07
- 결정권자: 미정 — 프로젝트 담당자가 지정
- 관련 문서:
  - PRD: [제품 요구사항](../product-requirements.md) §3.2 원칙 7, §6.2 F-D04·F-D06, §6.8 F-C01·F-C08, §8 N-02·N-03과 마지막 문단, §11 초기 핵심, §13-1
  - OSS: [오픈소스와 구현 경계](../open-source-components.md) §1, §3.1~§3.2, §5.1~§5.2, §6.1~§6.3, §8.1, §11.1, §13
  - 선행 ADR: 없음
  - 후속 ADR: [ADR-0002](./0002-deployment-packaging.md), [ADR-0003](./0003-storage-and-concurrency.md), [ADR-0004](./0004-authentication-authorization.md), [ADR-0006](./0006-server-api-contract.md), [ADR-0007](./0007-cli-contract.md)

## 배경

PRD §8 마지막 문단은 개발 언어, 프런트엔드 프레임워크, 그래프 라이브러리, DB, 컨테이너·OpenShift 사용 여부를 확정하지 않는다. §13-1은 서버·웹·CLI 기술 구성을 구현 전 결정 사항으로 둔다.

OSS §1의 추천(Svelte Flow + Dagre + Commander.js)은 'Svelte 프런트엔드와 Node.js CLI를 선택한다는 조건'에서 낸 조건부 추천이다. 서버 언어는 정하지 않았다. 이 전제를 채택했다는 기록은 아직 없다.

PRD §11 초기 핵심(서버·웹, 프로젝트와 공정, DAG 연결·검증·표시, 실행 상태, 저장, 대응 CLI)의 어느 계층도 이 결정 없이 착수할 수 없다. 서버 언어가 정해져야 다음이 정해진다.

| 정해지는 것 | 근거 |
| --- | --- |
| 서버 DAG 검증을 어디에, 무엇으로 구현할지 | F-D04, F-D06, OSS §5.2 |
| GUI와 CLI가 같은 계약을 어떻게 공유할지 | 원칙 7, F-C01, F-C08 |
| 폐쇄망에 반입·패치할 런타임 수 | N-03, OSS §11.2 |
| Jira 연동 구현 방식(4단계) | OSS §6.3 |

프런트엔드 프레임워크(Svelte 또는 React)도 이 ADR의 결정 범위다. OSS §13은 '프런트엔드가 React로 정해지면 React Flow로 대체한다'고 적어 프런트엔드가 미정임을 밝힌다.

## 제안하는 결정

선택지 A(TypeScript 단일 언어)를 제안한다.

| 계층 | 제안 |
| --- | --- |
| 서버 | Node.js LTS + TypeScript. HTTP 프레임워크는 계약 생성 방식([ADR-0006](./0006-server-api-contract.md))과 함께 정한다 |
| 웹 | Svelte + Svelte Flow(`@xyflow/svelte`). SPA 정적 빌드로 만들고 API 서버가 정적 파일을 함께 제공한다 |
| CLI | Node.js + TypeScript + Commander.js. 배포 형태는 [ADR-0007](./0007-cli-contract.md)에서 정한다 |
| 공용 코드 | API 계약 타입(ADR-0006의 OpenAPI에서 생성), DAG 검증 순수 함수 |
| Jira(4단계) | 서버의 JiraAdapter 경계 뒤에 작은 REST 어댑터 |

세부 제안은 다음과 같다.

1. DAG 검증의 판정 권한은 서버에만 둔다(F-D06). 같은 검증 함수를 웹의 사전 피드백에 재사용할 수 있지만, 웹의 판정으로 저장 여부를 정하지 않는다.
2. CLI는 로컬에서 그래프를 검증하지 않는다. 사전 검증이 필요하면 서버의 dry-run(ADR-0006)을 쓴다. 그래야 GUI와 CLI의 결과가 같은 판정에서 나온다(원칙 7).
3. 검증 함수는 Graphlib(`@dagrejs/graphlib`)와 작은 자체 함수 중에서 스파이크로 고른다(OSS §5.1, §5.2). 어느 쪽이든 순환 오류에는 순환 경로를 담는다(ADR-0006).
4. SvelteKit SSR 대신 SPA 정적 빌드를 제안한다. 근거는 아래 '프런트엔드 빌드 방식'에 둔다.
5. Node.js 주 버전은 착수 시점의 LTS 중에서 고른다. 결정 필요.
6. 채택할 때 패키지명, 고정 버전, 라이선스 근거를 기록한다(OSS §11.1).

Node.js LTS 일정은 다음과 같다. 2026-10-07에 확인했고, 일정은 바뀔 수 있다고 공지되어 있다. [Node.js 릴리스 일정][node-release]

| 주 버전 | 2026-10-07 상태 | Maintenance 시작 | 지원 종료(EOL) |
| --- | --- | --- | --- |
| 22 | Maintenance LTS | 2025-10-21 | 2027-04-30 |
| 24 | Active LTS | 2026-10-20 | 2028-04-30 |
| 26 | Current. 2026-10-28 Active LTS 전환 예정 | 2027-10-20 | 2029-04-30 |

### 프런트엔드 빌드 방식

| 방식 | 평가 |
| --- | --- |
| SPA 정적 빌드(Svelte + Vite, 또는 SvelteKit SPA 모드: `adapter-static` + `ssr = false` + fallback 페이지) | 정적 파일만 생성한다. API 서버가 함께 제공하므로 운영 프로세스가 하나다. 화면의 모든 데이터가 `/api/v1`을 거친다 |
| SvelteKit SSR | 렌더링용 서버 런타임이 필요하다. 서버 측 load 함수가 공개 API를 거치지 않고 도메인·DB에 직접 접근하는 두 번째 경로가 생기기 쉽다(원칙 7, F-C08 위험) |

앞선 검토 의견은 'CDN에 의존하지 않기 때문'을 SPA의 근거로 들었다. 그러나 SSR 자체가 CDN 의존을 뜻하지는 않으므로 근거를 다음과 같이 고친다.

- 정적 자산을 배포물에 고정 포함하고 외부 요청이 없는지 검사하기 쉽다(N-02, OSS §11.2).
- 운영 프로세스가 하나다(N-03).
- GUI가 CLI와 같은 API만 쓰게 된다(원칙 7, F-C08).

SvelteKit 문서는 SPA 모드의 단점으로 첫 화면 표시 지연, 검색 노출 불리, JavaScript 없이 사용할 수 없음을 든다. [SvelteKit SPA][sveltekit-spa] Tevro는 사내 도구이고 그래프 편집기 자체가 JavaScript로 동작하므로 이 단점의 영향은 작다고 본다. 첫 화면 시간은 스파이크에서 측정한다.

## 검토한 선택지

### 선택지 A: TypeScript 단일 언어 (Node.js 서버 + Svelte SPA + Node CLI)

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 낮음~중간. 언어와 빌드 도구가 하나다. 서버·웹·CLI·공용 코드를 한 저장소의 패키지로 나눌 수 있다 |
| 폐쇄망 반입·운영 부담 | 실행 런타임이 Node.js 하나다(N-03). 웹 빌드 도구도 Node.js에서 동작하므로 빌드 환경도 하나다. 다만 npm 전이 의존성이 많아 라이선스·반입 검토량은 크다(OSS §11.1) |
| GUI·CLI 동등성(원칙 7) | 서버·웹·CLI가 같은 생성 타입을 쓴다. DTO와 오류 코드 불일치를 컴파일 단계에서 줄인다 |
| 관련 요구사항 적합성 | F-D06: 서버 도메인 모듈에서 Graphlib 또는 자체 함수를 쓸 수 있다(OSS §5.1). F-J01~F-J14: REST 어댑터를 직접 구현해야 한다 |
| 팀 숙련도 | 확인 필요. OSS §3.2는 Svelte를 '익숙한' 프레임워크로 언급하지만 팀 전체의 TypeScript·Node.js 서버 경험은 확인하지 않았다 |

장점:

- 반입·패치할 런타임과 빌드 도구가 하나다.
- 계약 타입 공유로 원칙 7을 구조적으로 지원한다.
- DAG 검증 함수를 서버 판정과 웹 사전 피드백에 함께 쓸 수 있다.

단점:

- Jira 9.x용으로 유지보수 중인 Node.js SDK가 사실상 없다. `jira-client`는 최신판 8.2.2(2022-11-03) 이후 릴리스와 커밋이 없다. [jira-client npm][jira-client-npm] `jira.js` 6.x 안정판(6.2.0)은 Cloud용이다. 6.3(2026-10-07 현재 RC 단계)부터 지원하는 자체 호스팅 Jira도 10.0 이상이며 9.x는 지원하지 않는다. [jira.js 저장소][jira-js], [jira.js npm][jira-js-npm] 따라서 REST 어댑터를 직접 작성·유지보수한다(OSS §6.3).
- npm 생태계의 전이 의존성이 많아 공급망·라이선스 검토 부담이 있다.

### 선택지 B: Python 서버 + Svelte SPA + Node CLI

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
| 관련 요구사항 적합성 | 공정 카드를 일반 Svelte 컴포넌트로 작성(OSS §3.1). 1.7.0 기준 MIT이고 Svelte `^5.25.0`을 peer 의존성으로 요구 [npm][xyflow-svelte-npm] | 같은 계열 React 라이브러리. 코어는 MIT, Pro 예제·템플릿은 별도 조건(OSS §3.2) |
| 팀 숙련도 | OSS §3.2가 '익숙한 Svelte'로 언급. 팀 전체는 확인 필요 | 확인 필요 |

Svelte를 제안한다. OSS 1차 추천 조합과 같고, 문서상 익숙한 프레임워크로 언급되어 있기 때문이다. 숙련도 확인 결과 팀의 React 경험이 압도적이면 React로 바꾸는 것이 합리적이다. 이 경우 그래프 라이브러리만 React Flow로 바뀌고 나머지 제안은 유지된다(OSS §13).

## 트레이드오프

- 런타임 하나와 계약 공유를 얻는 대신 Jira 9.x 연동 코드를 직접 유지보수한다. 범위는 JiraAdapter의 6개 연산 수준이다(OSS §6.3).
- REST 어댑터는 대상 버전의 API 변화를 직접 따라가야 한다. 예를 들어 구 createmeta 방식(`GET /rest/api/2/issue/createmeta?projectKeys=…`)은 Jira 9.0에서 제거되었다. 9.15.1 문서에는 대체 엔드포인트 `GET /rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes`와 `…/issuetypes/{issueTypeId}`가 있고 페이지네이션을 처리해야 한다. [createmeta 제거 안내][jira-createmeta-removal], [Jira 9.15.1 REST][jira-rest-9151] 이 내용은 OSS §6.3에도 반영되어 있다.
- SPA는 첫 화면 표시가 SSR보다 느릴 수 있다. 사내 도구라 수용할 수 있다고 보지만 측정 전 판단이다.
- Svelte 생태계는 React보다 작다. 필요한 UI 컴포넌트를 직접 만들 가능성이 있다.

## 결과

쉬워지는 것:

- 반입·패치 대상 런타임과 빌드 도구가 Node.js 하나로 줄어든다.
- 계약 타입은 서버·웹·CLI가, DAG 검증 함수는 서버와 웹(사전 피드백)이 공유한다.
- ADR-0006의 OpenAPI 생성물을 웹과 CLI가 같은 언어로 쓴다.

어려워지는 것:

- Jira 어댑터를 직접 작성하고 사내 Jira에서 시험해야 한다(4단계).
- npm 의존성의 라이선스·반입 검토 범위가 넓다.

다시 검토할 시점:

- 숙련도 확인 결과 팀의 TypeScript 서버 경험이 부족할 때.
- 사내 Jira가 10.0 이상으로 업그레이드될 때. `jira.js` 6.3 이상 정식판을 SDK 후보로 재평가한다(OSS §6.1). 사내 Jira 9.15는 2026-03-27에 지원이 끝났고, Jira Data Center 제품군은 2029-03-28 EOL 이후 읽기 전용이 된다. [Atlassian 지원 종료 정책][atlassian-eos], [Data Center EOL][jira-dc-eol] 업그레이드 가능성은 PRD §6.7 '대상 Jira 환경'과 §13-6에 정리되어 있다.
- 채택한 Node.js LTS의 지원 종료 전.

## 채택 전 확인할 사항

| 항목 | 확인 대상 |
| --- | --- |
| 팀의 TypeScript·Node.js 서버, Svelte, React, Python 경험 | 프로젝트 담당자, 개발 참여자 |
| 사내 표준 언어·런타임 정책(허용 런타임 목록이 있는지) | 사내 아키텍처·보안 담당 |
| 내부 npm 미러 유무. 선택지 B라면 내부 Python 패키지 미러 유무 | 사내 인프라 담당([ADR-0002](./0002-deployment-packaging.md)) |
| 사내에서 허용하는 Node.js 버전 정책 | 사내 인프라 담당 |
| 사내 Jira 업그레이드·이전 계획(대상 버전과 시점) | 사내 Jira 관리자(PRD §13-6) |
| 오픈소스 반입 승인 단위(패키지별인지, 전이 의존성까지인지) | 사내 보안·법무 담당(OSS §11.1) |

## 후속 작업

- [ ] 결정권자를 지정하고 위 확인 사항을 수집한다.
- [ ] OSS §12의 A·B·C·D 예제로 스파이크를 수행한다([README 스파이크 시나리오](./README.md)).
- [ ] Graphlib 도입 여부를 자체 함수와 비교해 정한다.
- [ ] Node.js 주 버전을 정하고 고정한다.
- [ ] 채택 패키지의 고정 버전·라이선스 근거를 기록한다(OSS §11.1).
- [ ] 서버·웹·CLI·공용 코드 패키지 구조 초안을 만든다.
- [ ] 채택하면 PRD §13-1과 OSS §13을 갱신한다.

## 출처

2026-10-07에 확인했다.

- [Node.js 릴리스 일정][node-release]
- [@xyflow/svelte npm 메타데이터][xyflow-svelte-npm]
- [SvelteKit 단일 페이지 앱 문서][sveltekit-spa]
- [jira-client npm 메타데이터][jira-client-npm], [jira-client 저장소][jira-client]
- [jira.js npm 메타데이터][jira-js-npm], [jira.js 저장소][jira-js]
- [Jira createmeta REST 엔드포인트 제거 안내][jira-createmeta-removal]
- [Jira 9.15.1 REST API 문서][jira-rest-9151]
- [Atlassian End of Support Policy][atlassian-eos]
- [Atlassian Data Center end of life][jira-dc-eol]

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

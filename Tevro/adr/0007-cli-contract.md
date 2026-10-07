# ADR-0007: CLI 최소 계약

- 상태: 제안 (Proposed)
- 작성일: 2026-10-07
- 결정권자: 미정 — 프로젝트 담당자가 지정
- 관련 문서:
  - PRD: [제품 요구사항](../product-requirements.md) §3.2 원칙 7, §6.8 F-C01~F-C10, '명령 체계 예시 — 미확정'과 마지막 문장, §8 N-03·N-08, §10 AC-13·AC-14·AC-17·AC-19·AC-20, §11 표 아래 문단, §13-10
  - OSS: [오픈소스와 구현 경계](../open-source-components.md) §8.1, §8.2, §11.2
  - 선행 ADR: [ADR-0006](./0006-server-api-contract.md), [ADR-0004](./0004-authentication-authorization.md)
  - 관련 ADR: [ADR-0001](./0001-tech-stack.md)(CLI 런타임), [ADR-0002](./0002-deployment-packaging.md)(반입 경로), [ADR-0003](./0003-storage-and-concurrency.md)(충돌), [ADR-0005](./0005-identifiers-and-deletion.md)(식별자·삭제)

## 배경

PRD §11은 '해당 데이터 기능의 CLI 제공까지 그 단계의 완료 범위로 본다'고 한다. 초기 핵심의 완료 조건에 CLI가 들어 있다. §6.8의 명령 예시는 최종 문법이 아니고, 템플릿 편집 명령의 형태도 미정이다. §13-10은 최종 명령 체계, 구조화 출력 스키마, 종료 코드, 안전한 인증값 전달을 구현 전 결정 사항으로 둔다.

관련 요구는 다음과 같다.

| 요구 | 내용 |
| --- | --- |
| F-C02 | 에이전트가 해석할 수 있는 구조화 조회 |
| F-C03 | 대화형 프롬프트 없이 실행, 입력 누락은 예측 가능한 오류 |
| F-C05 | 검증 실패·권한 부족·동시 수정 충돌·외부 연동 실패를 구분하는 종료 코드 |
| F-C06 | 조회는 데이터를 바꾸지 않고, 변경은 대상과 영향을 명확히 지정 |
| F-C07 | 영향이 큰 작업은 미리 보기 또는 dry-run, 실제 변경은 명시적 실행 의사 |
| F-C09 | 인증 정보 비노출, 필요한 권한만 사용 |
| F-C10 | 도구 자체에서 명령·인자·출력 형식·실패 원인 확인 |
| N-08 | 사내 인증서 대응, 검증을 무조건 끄지 않음 |

OSS §8.1에 따르면 Commander.js는 명령 해석만 맡고, 구조화 결과·서버 통신·도메인 오류 해석은 Tevro가 구현한다.

이 결정은 서버 착수를 막지 않는다. 그러나 에이전트가 의존하는 출력 스키마와 종료 코드는 한 번 공개하면 바꾸기 어렵다. ADR-0006의 오류 코드가 정해지면 바로 확정할 수 있다. CLI가 돌아갈 호스트(개발자 PC, 에이전트 실행 환경)에 Node.js가 있는지도 배포 형태를 좌우한다.

## 제안하는 결정

초기 핵심에서 다음 여섯 가지를 최소 계약으로 확정하는 것을 제안한다.

### 1. 명사-동사 문법

PRD §6.8 예시의 명사(`project`, `task`, `dependency`, `graph`)와 동사 구성을 유지한다.

| 명령 | 서버 호출(ADR-0006) | 비고 |
| --- | --- | --- |
| `project create`·`list`·`show`·`update` | 프로젝트 API | |
| `task add`·`list`·`show`·`update`·`status` | 공정 API | `update`·`status`는 `--expected-version` 선택 |
| `task delete <task-id>` | 변경 묶음 | `--yes` 필요. `--dry-run`으로 영향 확인. `--expected-revision` 선택. `--reconnect`는 끊기는 선후 경로를 다시 잇는 선택 옵션(ADR-0005, 결정 필요). 변경 묶음 경로에 필요한 프로젝트는 `GET /api/v1/tasks/{taskId}`로 찾는다. 이때 `NOT_FOUND`면 종료 코드 6으로 끝낸다 |
| `dependency add`·`remove` | 연결 API | (선행, 후속) 공정 쌍으로 지정 |
| `graph show` | 그래프 조회 | |
| `graph apply --project <id> --file <파일>` | 변경 묶음 | `--dry-run`, `--expected-revision` 선택. 삭제 작업이 있으면 `--yes` 필요 |
| `graph validate --project <id> [--file <파일>]` | 변경 묶음 dry-run 또는 무결성 검사 | ADR-0006 §5 정의를 따름 |
| `config set-token --stdin`, `config show` | 로컬 설정 | `config show`는 토큰 값을 출력하지 않음 |
| `version` | 버전 확인 | CLI 버전, 출력 스키마 버전, 서버 API 버전 |

템플릿 명령은 재사용 단계, Jira 명령은 Jira 단계에서 정한다. 템플릿 편집에 별도 명령을 둘지 공통 공정 명령에 대상을 지정할지(§6.8 마지막 문장)는 재사용 단계로 이월한다. 실행 상태 값의 표기(예시의 `in-progress`)는 후속 ADR 후보 '실행 상태·선행 조건 판정 모델'에서 정한다([README](./README.md)).

### 2. 구조화 출력: `--json` = API DTO + `schemaVersion`

- `--json`을 주면 성공 결과를 stdout에 JSON 하나로 쓴다. 형태는 `{"schemaVersion": 1, "data": <API 응답 DTO>}`다. 목록도 `data` 안에 둔다.
- `data`는 ADR-0006의 응답 DTO를 그대로 쓴다. CLI가 따로 변형하지 않는다. 그래야 GUI와 CLI가 같은 데이터를 본다(원칙 7, AC-13).
- 실패하면 stdout에는 아무것도 쓰지 않는다. `--json`이면 stderr에 `{"schemaVersion": 1, "error": {code, message, details, requestId}}`를 쓴다.
- 진행 상황, 경고, 사람이 읽는 진단은 모두 stderr로 보낸다. stdout에는 데이터만 둔다.
- `schemaVersion`은 정수다. 필드 추가는 같은 버전에서 허용하고, 제거·의미 변경 때만 올린다. 사용자는 모르는 필드를 무시한다.
- `--json` 없는 사람용 출력은 계약이 아니다. 형식을 바꿀 수 있다.

### 3. 종료 코드

서버 오류 코드마다 종료 코드가 하나로 정해진다(ADR-0006 §6).

| 종료 코드 | 의미 | 서버 오류 코드 또는 CLI 상황 |
| --- | --- | --- |
| 0 | 성공 | dry-run 검증 통과 포함. `warnings`가 있어도 0 |
| 1 | 기타 오류 | `INTERNAL`, `CLIENT_VERSION_UNSUPPORTED`, 서버 연결 실패·TLS 검증 실패(CLI 진단) |
| 2 | 사용법 오류·입력 누락 | 서버 호출 전 CLI가 찾은 오류: 알 수 없는 옵션, 필수 인자 누락. 그리고 파괴적 변경의 `--yes` 누락(서버 dry-run으로 영향을 보여 준 뒤 종료, §4) |
| 3 | 검증 실패 | `VALIDATION_INPUT`, `VALIDATION_SELF_LOOP`, `VALIDATION_DUPLICATE_EDGE`, `VALIDATION_CYCLE`, `REFERENCE_NOT_FOUND`, `CROSS_PROJECT_REFERENCE` |
| 4 | 인증·권한 | `UNAUTHENTICATED`, `FORBIDDEN`, 인증값을 찾지 못하거나 토큰 파일 권한이 너무 넓음(CLI 진단) |
| 5 | 동시 수정 충돌 | `CONFLICT`(AC-17) |
| 6 | 대상 없음 | `NOT_FOUND` |
| 7 | 외부 연동 실패 — 예약 | `EXTERNAL_INTEGRATION_FAILED`(Jira 단계) |

- `--yes` 없는 파괴적 변경은 미리 보기를 위해 서버 dry-run을 호출한다. dry-run이 오류로 끝나면 그 오류의 종료 코드(예: `NOT_FOUND`면 6, `UNAUTHENTICATED`면 4)를, 통과하면 2를 반환한다.
- Commander.js의 기본 사용 오류 처리 동작(종료 코드 포함)을 채택 버전에서 확인하고, 계약의 2로 맞춘다.
- 서버 연결 실패를 1과 다른 코드로 분리할지는 결정 필요. 에이전트가 재시도 대상을 구분하는 데 쓸 수 있다.
- Jira 일괄 작업의 부분 성공(AC-10)을 어떤 종료 코드로 알릴지는 Jira 단계에서 정한다.

### 4. 비대화형·파괴적 변경·dry-run

- 어떤 경우에도 프롬프트를 띄우지 않는다. 터미널 여부에 따라 동작을 바꾸지 않는다(F-C03).
- 데이터를 지우는 명령(`delete`, `remove`)과 삭제 작업을 포함한 `graph apply`는 `--yes`가 있어야 실행한다. `--yes`가 없으면 아무것도 바꾸지 않고, 서버 dry-run(ADR-0006 §4)으로 얻은 영향 미리 보기를 stderr에 쓴 뒤 종료 코드 2로 끝낸다. 그 dry-run이 오류로 끝나면 그 오류의 종료 코드를 따른다(§3). `dependency remove`를 이 규칙에서 뺄지는 결정 필요.
- 영향이 큰 작업은 `--dry-run`을 제공한다. 기계가 읽을 미리 보기가 필요하면 `--dry-run --json`을 쓴다. 성공하면 stdout에 결과를 쓰고 종료 코드 0이다. 실패하면 stderr에 오류를 쓰고(§2), 종료 코드는 실제 실행과 같은 오류 코드 매핑(§3)을 따른다. 예를 들어 검증 실패는 3, `--expected-revision` 불일치는 5, 대상 없음은 6, 인증 실패는 4다. `--dry-run`에는 `--yes`가 필요 없다.
- dry-run 결과의 `baseGraphRevision`을 실제 실행의 `--expected-revision`으로 넘기면, 그 사이 구조가 바뀐 경우 종료 코드 5로 거부된다(ADR-0006 §4, F-C07).
- 조회 명령(`list`, `show`, `graph show`, `graph validate`)은 데이터를 바꾸지 않는다(F-C06).

### 5. 서버 주소·인증값·사내 CA

| 항목 | 1순위: 플래그 | 2순위: 환경변수 | 3순위: 설정 파일 |
| --- | --- | --- | --- |
| 서버 주소 | `--server <URL>` | `TEVRO_SERVER` | `server` |
| 인증 토큰 | `--token-file <경로>`(경로만 받음) | `TEVRO_TOKEN` | `token`(권한 600 파일) |
| 추가 신뢰 CA | `--ca-file <PEM 경로>` | `TEVRO_CA_FILE` | `caFile` |

환경변수와 설정 키 이름은 제안이며 구현할 때 확정한다.

- 토큰 값을 받는 명령행 인자는 두지 않는다. 프로세스 목록과 셸 이력에 남기 때문이다(F-C09, ADR-0004). 토큰 파일 경로는 비밀값이 아니므로 인자로 받는다.
- 토큰 등록은 표준 입력으로 받는다(`config set-token --stdin`). CLI가 권한 600 설정 파일에 저장한다.
- 토큰 파일이나 설정 파일의 권한이 소유자 외에도 읽을 수 있게 열려 있으면 사용을 거부한다(종료 코드 4). Windows 호스트에서의 동등한 규칙은 확인 필요.
- 토큰 값은 어떤 출력·오류·디버그 로그에도 쓰지 않는다. 토큰 접두사(ADR-0004)로 찾아 가린다(AC-20).
- `--ca-file`은 기본 신뢰 목록에 '더하는' 방식으로 구현한다. Node.js에서 TLS 클라이언트의 `ca` 옵션을 직접 지정하면 기본·추가 인증서가 쓰이지 않기 때문이다. Node.js로 실행하는 CLI는 `NODE_EXTRA_CA_CERTS`(프로세스 시작 시 읽음)도 쓸 수 있다. [Node.js CLI 문서][node-cli] 단일 실행 파일 번들에서도 같은지는 채택 전 확인한다.
- 인증서 검증을 끄는 옵션(`--insecure` 류)은 기본 제공하지 않는다(N-08, OSS §11.2).

### 6. CLI-서버 버전 호환성

- CLI는 요청마다 자기 버전을 헤더로 보낸다(예: `Tevro-Client-Version`).
- 서버는 API 버전과 지원하는 최소 CLI 버전을 응답 헤더로 알린다(예: `Tevro-Api-Version`).
- 지원하지 않는 CLI면 서버가 `CLIENT_VERSION_UNSUPPORTED`로 거부하고, CLI는 종료 코드 1과 함께 업그레이드 안내를 stderr에 쓴다.
- `version --json`으로 CLI 버전, `schemaVersion`, 서버 API 버전을 한 번에 확인한다.
- 헤더 이름은 제안이며 구현할 때 확정한다.

### 도움말(F-C10)

- 명령마다 `--help`로 필수 인자, 선택 옵션, `--json` 출력의 `data` 형태, 가능한 종료 코드를 보여 준다.
- 종료 코드 표 전체를 도구 안에서 확인하는 방법(예: `help exit-codes`)을 둔다.

### Commander.js 주 버전

2026-10-07 기준 사실은 다음과 같다. [Commander.js CHANGELOG][commander-changelog], [Node.js 릴리스 일정][node-release]

| 항목 | 내용 |
| --- | --- |
| Commander.js 15.x | 15.0.0(2026-05-29). ESM 전용, Node.js 22.12.0 이상 필요. MIT |
| Commander.js 14.x | 2027-05까지 보안 업데이트 제공 |
| Node.js 22 | Maintenance LTS, 2027-04-30 지원 종료 |
| Node.js 24 | Active LTS, 2028-04-30 지원 종료 |

CLI 호스트의 Node.js가 22.12.0 이상임이 확인되거나 CLI 배포 선택지 B(단일 실행 파일 번들, 아래 '검토한 선택지')를 고르면 15.x를 제안한다. 14.x로 시작하면 2027-05 보안 지원 종료 전에 올려야 한다.

## 검토한 선택지

계약(위 1~6)은 배포 형태와 무관하게 제안한다. 배포 형태는 두 선택지 중에서 CLI 호스트의 Node.js 유무를 확인한 뒤 고른다.

### 선택지 A: 내부 npm 레지스트리 패키지 (호스트에 Node.js 필요)

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 낮음. 일반 npm 패키지로 빌드·게시한다 |
| 폐쇄망 반입·운영 부담 | 내부 npm 레지스트리가 있어야 한다([ADR-0002](./0002-deployment-packaging.md)). 호스트마다 지원되는 Node.js(Commander 15라면 22.12.0 이상)가 있어야 한다 |
| GUI·CLI 동등성(원칙 7) | 계약과 무관. 같은 서버 API를 쓴다 |
| 관련 요구사항 적합성 | N-03(설치 재현성)은 레지스트리와 버전 고정으로 충족한다. AC-14는 내부 레지스트리에서 설치하면 충족한다 |
| 팀 숙련도 | 확인 필요 |

장점: 빌드·배포가 가장 단순하다. `NODE_EXTRA_CA_CERTS` 등 Node.js 표준 설정을 그대로 쓴다.

단점: 호스트의 Node.js 버전에 묶인다. 에이전트 실행 환경마다 Node.js를 관리해야 한다.

### 선택지 B: 단일 실행 파일 번들 (Node.js SEA 등, 채택 전 검증)

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 중간. 모든 코드를 스크립트 하나로 번들한 뒤 실행 파일에 넣는다. OS·아키텍처별로 빌드한다 |
| 폐쇄망 반입·운영 부담 | 호스트에 Node.js가 필요 없다. 실행 파일 하나를 반입한다. 대신 Node.js 보안 패치마다 다시 빌드·배포한다 |
| GUI·CLI 동등성(원칙 7) | 계약과 무관 |
| 관련 요구사항 적합성 | N-03, AC-14를 충족한다. Node.js 문서상 SEA는 Stability 1.1(Active development)이다. 기본적으로 `require()`·`import`는 내장 모듈만 불러올 수 있어 번들이 전제다. 정기 시험 플랫폼도 문서에 제한되어 있다 [Node.js SEA][node-sea] |
| 팀 숙련도 | 확인 필요 |

장점: 호스트 환경 차이를 없앤다. 에이전트 실행 환경에 넣기 쉽다.

단점: 기능이 아직 활발히 바뀌는 단계다. 빌드 파이프라인과 OS별 시험 부담이 있다.

## 트레이드오프

- 출력 계약을 일찍 고정하면 에이전트가 안정적으로 쓸 수 있는 대신, 초기 실수를 고치려면 `schemaVersion`을 올려야 한다.
- 실패 정보를 stderr에만 쓰면 stdout이 깨끗한 대신, 에이전트는 두 스트림을 모두 읽어야 한다. stdout에 오류 객체를 쓰는 방식도 가능하며 결정 필요.
- `--yes` 규칙을 모든 삭제에 적용하면 예측 가능한 대신, 단순한 연결 삭제도 번거로워진다.
- 토큰을 인자로 받지 않으면 안전한 대신, 처음 설정할 때 한 단계가 늘어난다.
- 배포 선택지 A는 단순하지만 호스트에 묶이고, B는 호스트와 무관하지만 빌드가 복잡하다.

## 결과

쉬워지는 것:

- 에이전트가 종료 코드만으로 실패 종류를 구분할 수 있다(F-C05).
- dry-run과 실제 실행을 리비전으로 안전하게 이을 수 있다(F-C07, AC-19).
- GUI와 CLI가 같은 DTO를 보므로 AC-13 시험이 단순해진다.

어려워지는 것:

- 출력 스키마와 종료 코드 표를 공개 계약으로 관리해야 한다.
- 토큰 파일 권한 검사 등 OS별 동작을 시험해야 한다.

다시 검토할 시점:

- Jira 단계에 들어갈 때(부분 성공 종료 코드, `jira` 명령군).
- 재사용 단계에 들어갈 때(템플릿 편집 명령 형태).
- CLI 호스트의 Node.js 환경이 바뀔 때(배포 형태).
- Commander.js 14.x를 쓰는 경우 2027-05 전.

## 채택 전 확인할 사항

| 항목 | 확인 대상 |
| --- | --- |
| CLI 실행 호스트(개발자 PC, 에이전트 실행 환경)의 OS와 Node.js 유무·버전 | 개발 참여자, 에이전트 사용 담당 |
| 내부 npm 레지스트리 유무 | 사내 인프라 담당(ADR-0002) |
| 에이전트가 오류를 stdout과 stderr 중 어디서 읽기를 선호하는지 | 에이전트 사용 담당 |
| 서버 연결 실패를 별도 종료 코드로 둘지 | 에이전트 사용 담당 |
| `dependency remove`에도 `--yes`를 요구할지 | 프로젝트 담당자 |
| 사내 CA 파일 배포 방식(호스트에 설치되어 있는지) | 사내 보안·인프라 담당 |

## 후속 작업

- [ ] 종료 코드 표와 ADR-0006 오류 코드 표를 하나의 원천에서 생성하거나 시험으로 일치를 확인한다.
- [ ] `--json` 출력 스키마를 OpenAPI DTO에서 그대로 쓰도록 CLI 구조를 잡는다.
- [ ] 설정 우선순위, 토큰 파일 권한 검사, `--ca-file` 동작을 구현·시험한다.
- [ ] AC-17(충돌 시 종료 코드 5), AC-19(dry-run 무변경), AC-20(인증값 비노출) CLI 시험을 만든다.
- [ ] CLI 호스트 확인 후 배포 선택지 A 또는 B를 고른다. B라면 SEA 스파이크를 한다.
- [ ] Commander.js 주 버전을 정하고 고정한다.
- [ ] 채택하면 PRD §13-10과 §6.8 '명령 체계 예시'의 비고를 갱신한다.

## 출처

2026-10-07에 확인했다.

- [Commander.js CHANGELOG][commander-changelog]
- [Node.js 릴리스 일정][node-release]
- [Node.js CLI 문서 — NODE_EXTRA_CA_CERTS][node-cli]
- [Node.js Single executable applications][node-sea]

[commander-changelog]: https://github.com/tj/commander.js/blob/master/CHANGELOG.md
[node-release]: https://github.com/nodejs/Release
[node-cli]: https://nodejs.org/api/cli.html
[node-sea]: https://nodejs.org/api/single-executable-applications.html

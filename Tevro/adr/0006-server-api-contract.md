# ADR-0006: 서버 API 계약·변경 묶음·오류 분류

- 상태: 제안 (Proposed)
- 작성일: 2026-10-07
- 결정권자: 미정 — 프로젝트 담당자가 지정
- 관련 문서:
  - PRD: [제품 요구사항](../product-requirements.md) §2 P-09, §3.2 원칙 3·7, §6.2 F-D02·F-D04·F-D06, §6.4 F-S04, §6.8 F-C01·F-C02·F-C05·F-C06·F-C07·F-C08과 '명령 체계 예시', §8 N-07, §9, §10 AC-03·AC-04·AC-13·AC-16·AC-17·AC-18·AC-19, §13-13
  - OSS: [오픈소스와 구현 경계](../open-source-components.md) §5.1, §5.2, §8.2, §9
  - 선행 ADR: [ADR-0003](./0003-storage-and-concurrency.md), [ADR-0004](./0004-authentication-authorization.md), [ADR-0005](./0005-identifiers-and-deletion.md)
  - 후속 ADR: [ADR-0007](./0007-cli-contract.md)

## 배경

원칙 7은 GUI와 CLI의 기능과 검증 규칙이 같아야 한다고 한다. F-D06은 GUI, CLI, 템플릿 적용 어느 경로에서도 같은 DAG 검증을 요구하고, F-D04는 거부할 때 이유를 알려 주라고 한다. OSS §8.2는 GUI와 CLI가 같은 서버 API를 쓴다고 정리한다. GUI와 CLI를 나란히 개발하려면 공유 계약이 먼저 있어야 한다. PRD §13-13이 이 결정을 구현 전 결정 사항으로 둔다.

정할 것은 네 가지다.

1. 계약을 무엇으로 표현할지(스키마의 단일 원천).
2. 변경 단위. 여러 변경을 한 번에 검증·적용할지, dry-run을 실제 실행과 어떻게 묶을지(F-C07).
3. 기계가 읽을 수 있는 오류 분류(F-C05의 검증 실패·권한 부족·동시 수정 충돌·외부 연동 실패, N-07).
4. 실시간 반영이 필요한지.

PRD 원문에는 모호한 점이 하나 있다. 서버가 잘못된 그래프를 항상 거부한다면 저장된 그래프는 늘 유효하다. 그러면 §6.8 예시의 `tevro graph validate --project <project-id>`가 무엇을 검증하는지 분명하지 않다.

변경 묶음에 대해 사실 관계를 먼저 밝혀 둔다. PRD는 원자적 일괄 적용을 요구하지 않는다. P-09의 일괄 작업은 단건 명령을 반복해서도 할 수 있다. 연결 방향을 바꿀 때도 기존 연결을 먼저 지우면 중간 단계의 순환은 피할 수 있다. 아래의 변경 묶음은 요구사항이 아니라 설계 제안이며, 근거는 다음과 같다.

- OSS §5.2: '여러 관계를 함께 바꿀 때 최종 변경 결과를 일관되게 검증한다'.
- 방향 변경(F-D02)을 삭제와 추가 두 요청으로 나누면, 삭제만 성공하고 추가가 실패하는 부분 실패가 생길 수 있다.
- 템플릿 적용(F-T04)은 본질적으로 여러 공정과 관계를 한 번에 만드는 작업이며, F-D06에 따라 같은 검증 경로를 타야 한다.
- 구조 변경은 어차피 프로젝트 단위로 직렬화한다(ADR-0003). 묶음 하나를 같은 잠금 안에서 처리하는 비용이 작다.

## 제안하는 결정

### 1. REST + OpenAPI 단일 스키마

- 서버 API는 REST로, 경로 버전 `/api/v1`을 붙인다.
- OpenAPI 문서 하나를 계약의 단일 원천으로 두고, 웹 클라이언트와 CLI 클라이언트 타입을 생성한다. 동등성을 구조적으로 강제하기 위해서다(원칙 7).
- 스키마를 먼저 쓰고 코드를 생성할지, 서버 코드에서 스키마를 생성할지는 결정 필요. ADR-0001 선택지 B(Python 서버)를 고르면 OpenAPI가 두 언어를 잇는 유일한 계약이 된다.
- 하위 호환 규칙: 필드 추가는 같은 버전 안에서 허용한다. 클라이언트는 모르는 필드를 무시한다. 필드 제거·의미 변경은 `/api/v2`로 한다.

### 2. 이름 통일

| 개념 | DB 이름 | API 필드·헤더 | CLI 옵션 |
| --- | --- | --- | --- |
| 프로젝트 구조 리비전 | `graph_revision` | `graphRevision`, 기대값 `expectedGraphRevision` | `--expected-revision` |
| 공정 필드 버전 | `version` | `version`, 기대값 `expectedVersion`, HTTP `If-Match` | `--expected-version` |
| 변경 묶음 | — | `change-sets` 엔드포인트, `operations` | `graph apply --file` |
| 임시 ID | — | `tmp_` 접두사 | 변경 묶음 파일 안에서만 |

`graph_revision`과 `version`의 의미는 [ADR-0003](./0003-storage-and-concurrency.md), ID 접두사는 [ADR-0005](./0005-identifiers-and-deletion.md)를 따른다.

### 3. 변경 묶음(change set) 엔드포인트

`POST /api/v1/projects/{projectId}/change-sets`

한 요청에 공정 생성(임시 ID 참조 허용)·수정·삭제와 종속성 추가·삭제를 담는다. 서버는 작업을 순서대로 메모리 사본에 적용하고, 최종 상태를 한 번 검증한 뒤 원자적으로 적용한다. 중간 상태는 검증하지 않으므로, 서로 다른 연결을 지우고 추가하는 순서 때문에 중간 순환 오류가 나지는 않는다.

같은 대상을 다루는 작업이 한 묶음에 함께 있으면 순서에 따라 결과가 달라진다. 예를 들어 같은 연결에 `dependency.remove` 후 `dependency.add`를 하면 연결이 남지만, 순서를 바꾸면 사라지거나 중복 오류가 난다. `task.delete X` 후 `dependency.add X → Y`는 `REFERENCE_NOT_FOUND`지만, 순서를 바꾸면 연결이 함께 지워져 성공한다. 이런 묶음을 순서대로 적용할지, `VALIDATION_INPUT`으로 거부할지는 결정 필요.

요청 예시(형식 제안, 최종 스키마 아님):

```json
{
  "expectedGraphRevision": 41,
  "dryRun": false,
  "operations": [
    { "op": "task.create", "tempId": "tmp_1", "title": "CI 구성" },
    { "op": "task.update", "taskId": "tsk_…", "expectedVersion": 3, "set": { "title": "저장소 준비" } },
    { "op": "dependency.add", "from": "tsk_…", "to": "tmp_1" },
    { "op": "dependency.remove", "from": "tsk_…", "to": "tsk_…" },
    { "op": "task.delete", "taskId": "tsk_…" }
  ]
}
```

| 작업 | 내용 |
| --- | --- |
| `task.create` | 공정을 만든다. `tempId`(`tmp_` 접두사)로 같은 묶음의 다른 작업이 참조한다 |
| `task.update` | 공정 필드를 바꾼다. `expectedVersion`은 ADR-0003 1.3의 결정을 따른다 |
| `task.delete` | 공정을 지운다. 연결은 함께 지워진다(ADR-0005) |
| `dependency.add` | 선행 → 후속 연결을 추가한다. 실제 ID 또는 `tmp_` 임시 ID를 쓴다 |
| `dependency.remove` | 연결을 지운다 |

응답 예시(실제 적용):

```json
{
  "applied": true,
  "graphRevision": 42,
  "idMap": { "tmp_1": "tsk_…" },
  "tasks": [ { "id": "tsk_…", "version": 4 } ],
  "warnings": []
}
```

처리 규칙을 제안한다.

| 규칙 | 내용 |
| --- | --- |
| 원자성 | 모두 적용하거나 하나도 적용하지 않는다 |
| 검사 순서 | 인증·권한 → 작업 대상 존재(경로 대상, `task.update`·`task.delete`의 공정) → 기대 리비전·버전 → 구조 검증. 앞 단계에서 실패하면 뒤 단계를 하지 않는다 |
| 오류 수집 | 구조 검증 오류는 모두 모아 `details.errors` 배열에 담는다. 각 항목은 `{code, operationIndex, cycle?}`이다(§6). 최상위 `code`는 첫 오류의 코드다 |
| 리비전 | 구조 작업(공정 생성·삭제, 종속성 추가·삭제)이 하나라도 있으면 `graph_revision`을 1 올린다. 필드 수정만 있으면 올리지 않는다(ADR-0003) |
| 크기 제한 | 묶음당 최대 작업 수를 둔다. 값은 결정 필요 |
| 상태 전이 | 선행 조건 미충족은 실행 상태 변경의 거부 사유가 아니다(원칙 3, F-S04, AC-03). 필요하면 차단하지 않는 `warnings`로 알린다. Jira가 상태 원본인 공정의 수동 상태 변경을 어떻게 처리할지는 Jira 단계에서 정한다(PRD F-S02, §6.7 '정보의 원본 원칙', §13-7, 후속 ADR 후보 '실행 상태·선행 조건 판정 모델') |

단건 엔드포인트는 변경 묶음 위의 얇은 래퍼로 둔다. 예를 들어 `POST /api/v1/projects/{projectId}/dependencies`는 내부에서 `dependency.add` 하나짜리 묶음으로 바뀐다. 그래서 모든 경로가 같은 잠금·검증을 탄다(F-D06). 이후 템플릿 적용(F-T04)도 같은 내부 경로를 쓴다.

| 용도 | 엔드포인트 예시 |
| --- | --- |
| 프로젝트 목록·생성 | `GET`·`POST /api/v1/projects` |
| 프로젝트 조회·수정 | `GET`·`PATCH /api/v1/projects/{projectId}` |
| 그래프 전체 조회 | `GET /api/v1/projects/{projectId}/graph` — 공정, 종속성, `graphRevision`, 공정별 `version` |
| 공정 생성 | `POST /api/v1/projects/{projectId}/tasks` |
| 공정 조회·수정·삭제 | `GET`·`PATCH`·`DELETE /api/v1/tasks/{taskId}` — `PATCH`는 `If-Match` |
| 연결 추가·삭제 | `POST`·`DELETE /api/v1/projects/{projectId}/dependencies` — (선행, 후속) 쌍으로 지정 |
| 변경 묶음 | `POST /api/v1/projects/{projectId}/change-sets` |

### 4. dry-run과 실제 실행의 결합

- `dryRun: true`면 같은 잠금·검증을 거치되 커밋하지 않는다.
- dry-run 응답은 실제 실행과 같은 형식이다. 성공이면 `applied: false`와 함께 기준 리비전(`baseGraphRevision`)과 영향 정보를 돌려준다. 검증 실패면 실제 실행과 같은 오류를 돌려준다. 그래서 CLI 종료 코드도 같다(ADR-0007).
- 영향 정보에는 함께 지워지는 연결과 끊기는 선후 경로를 담는다(ADR-0005). 공정 삭제 전 미리 보기가 이것으로 구현된다(F-P06, AC-21).
- 실제 실행 요청에 dry-run이 돌려준 `baseGraphRevision`을 `expectedGraphRevision`으로 넘기면, 그 사이 구조가 바뀌었을 때 `CONFLICT`로 거부된다. 미리 본 것과 다른 대상을 바꾸지 않는다(F-C07 보강, PRD §6.8 표 아래 문단).
- 필드 수정은 리비전을 올리지 않으므로, 필드 수정까지 묶으려면 작업별 `expectedVersion`을 함께 넘긴다.
- dry-run은 Tevro 데이터를 바꾸지 않는다(AC-19). Jira 일괄 생성의 dry-run(4단계)도 같은 원칙으로, 리비전과 대상 집합 식별값을 실제 실행에 넘기는 방식을 그때 정한다.

응답 예시(dry-run):

```json
{
  "applied": false,
  "baseGraphRevision": 41,
  "impact": {
    "removedDependencies": [ { "from": "tsk_A…", "to": "tsk_B…" } ],
    "brokenPaths": [ { "from": "tsk_A…", "to": "tsk_C…", "via": "tsk_B…" } ]
  },
  "warnings": []
}
```

**응답을 받지 못한 재시도**

요청 시간 초과로 적용 여부를 모를 때 같은 묶음을 다시 보내면 공정이 중복 생성될 수 있다. `expectedGraphRevision`을 넣어 보내면, 앞선 요청이 이미 적용된 경우 리비전이 바뀌어 `CONFLICT`가 난다. 클라이언트는 그래프를 다시 읽어 확인한다. 별도의 멱등 키(`Idempotency-Key` 같은 요청 헤더)는 Jira 단계에서 다시 검토한다.

### 5. `graph validate`의 정의

| 형태 | 정의 |
| --- | --- |
| `graph validate --project <id> --file <변경 묶음 파일>` | 변경 묶음 파일의 사전 검증이다. `dryRun: true` 요청과 같다. 에이전트가 여러 공정과 관계를 한 번에 준비할 때 쓴다(P-09) |
| `graph validate --project <id>` | 저장된 그래프의 무결성을 서버가 다시 검사한다. 정상 운영에서는 항상 통과해야 한다. 백업 복구나 마이그레이션 후 확인에 쓴다(AC-24, ADR-0003) |

### 6. 오류 형식과 코드

오류 응답 형식은 `{code, message, details}`다. `message`는 사람이 읽는 한국어 문장, `details`는 기계가 읽는 구조화 정보다. 로그 대조를 위해 `requestId`를 함께 둔다.

```json
{
  "code": "VALIDATION_CYCLE",
  "message": "이 연결을 추가하면 순환이 생겨 저장할 수 없습니다: B → A → B",
  "details": {
    "errors": [
      { "code": "VALIDATION_CYCLE", "operationIndex": 0, "cycle": ["tsk_B…", "tsk_A…", "tsk_B…"] }
    ]
  },
  "requestId": "…"
}
```

구조 검증 오류(`VALIDATION_*`, `REFERENCE_NOT_FOUND`, `CROSS_PROJECT_REFERENCE`)의 `details`는 이 `errors` 배열 하나로 담는다. 각 항목의 `operationIndex`는 변경 묶음 안 작업의 순번(0부터)이다. 순환 오류 항목의 `cycle`에는 순환 경로의 공정 ID 목록을 담는다. Graphlib의 `alg.findCycles()` 또는 자체 깊이 우선 탐색으로 구한다(OSS §5.1).

| code | 의미 | HTTP 상태(제안) | CLI 종료 코드(ADR-0007) |
| --- | --- | --- | --- |
| `VALIDATION_INPUT` | 필수 값 누락, 형식·길이 오류, ID 접두사 불일치 | 422 | 3 |
| `VALIDATION_SELF_LOOP` | 자기 자신으로 연결(F-D04, AC-16) | 422 | 3 |
| `VALIDATION_DUPLICATE_EDGE` | 이미 있는 연결과 같은 연결(F-D04, AC-16) | 422 | 3 |
| `VALIDATION_CYCLE` | 순환을 만드는 변경(F-D04, AC-04, AC-18) | 422 | 3 |
| `REFERENCE_NOT_FOUND` | `dependency.add`·`dependency.remove`가 참조한 공정·임시 ID가 없음(F-D04 '존재하지 않는 공정 참조', ADR-0005) | 422 | 3 |
| `CROSS_PROJECT_REFERENCE` | 다른 프로젝트의 공정을 참조(PRD §6.2 하단, OSS §5.2) | 422 | 3 |
| `NOT_FOUND` | 작업 대상(경로로 지정한 대상, `task.update`·`task.delete`의 공정)이 없거나 삭제됨(ADR-0005) | 404 | 6 |
| `CONFLICT` | 기대 리비전·버전 불일치(ADR-0003, AC-17) | 409. `If-Match` 불일치는 412 | 5 |
| `UNAUTHENTICATED` | 인증 없음, 만료·폐기된 토큰(ADR-0004) | 401 | 4 |
| `FORBIDDEN` | 역할·토큰 범위 부족(ADR-0004) | 403 | 4 |
| `EXTERNAL_INTEGRATION_FAILED` | 외부 연동 실패. Jira 단계용 예약 | 502 | 7 |
| `CLIENT_VERSION_UNSUPPORTED` | 서버가 지원하지 않는 CLI 버전(ADR-0007) | 400 | 1 |
| `INTERNAL` | 그 밖의 서버 오류 | 500 | 1 |

- `If-Match` 조건이 거짓이면 서버는 요청을 수행하지 않고 412로 응답한다는 HTTP 의미를 따른다. [RFC 9110][rfc9110] 클라이언트는 HTTP 상태보다 `code`로 판단한다.
- `CONFLICT`의 `details`에는 현재 `graphRevision` 또는 공정의 현재 `version`을 담는다. 클라이언트가 무엇을 다시 읽어야 하는지 알 수 있게 하기 위해서다.
- 표준 오류 형식인 RFC 9457(Problem Details, `application/problem+json`)은 확장 필드를 허용한다. [RFC 9457][rfc9457] `code`·`details`를 확장 필드로 두어 이 형식에 맞출지는 결정 필요.
- 오류 메시지와 `details`에 인증값을 넣지 않는다(F-C09, AC-20).

### 7. 실시간 반영

실시간 push는 두지 않는 것을 제안한다. 실시간 공동 커서 등 협업 고도화는 초기 범위 밖이고(PRD §9), AC-13도 'GUI를 갱신하면'이라고 쓴다. GUI는 수동 새로고침이나 간단한 폴링으로 시작하고, 오래된 화면에서의 저장은 리비전·버전 충돌 감지로 막는다.

그래프 조회 응답의 캐시 검증값(ETag)은 구조와 필드 변경을 모두 반영해야 한다. `graph_revision`은 필드 수정으로 바뀌지 않으므로 그것만으로 ETag를 만들지 않는다. 예를 들어 응답 내용의 해시를 쓴다.

## 검토한 선택지

### 선택지 A: REST + OpenAPI + 변경 묶음(단건 엔드포인트는 래퍼)

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 중간. 변경 묶음 적용기(임시 ID 해석, 최종 상태 검증)를 만들어야 한다 |
| 폐쇄망 반입·운영 부담 | 낮음. 표준 HTTP와 JSON만 쓴다. 생성 도구는 빌드 시점에만 필요하다 |
| GUI·CLI 동등성(원칙 7) | 높음. 모든 쓰기가 한 경로를 타고, 타입을 같은 스키마에서 생성한다 |
| 관련 요구사항 적합성 | F-D06(단일 검증 경로), F-D02(방향 변경 원자 처리), F-C07(dry-run과 실행 결합), F-P06(삭제 영향 미리 보기), AC-18을 한 구조로 다룬다 |
| 팀 숙련도 | 확인 필요. REST·OpenAPI는 일반적이다 |

장점: dry-run, 삭제 미리 보기, 일괄 등록, 템플릿 적용이 같은 프리미티브를 공유한다.

단점: 단건 REST보다 서버 구현이 크다. 묶음 파일 형식이 공개 계약이 되므로 신중하게 정해야 한다.

### 선택지 B: 단건 REST 엔드포인트만

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 낮음 |
| 폐쇄망 반입·운영 부담 | 낮음 |
| GUI·CLI 동등성(원칙 7) | 중간. 같은 API를 쓰지만 여러 단계 작업은 클라이언트마다 순서를 따로 구현한다 |
| 관련 요구사항 적합성 | P-09는 반복 호출로 충족할 수 있다. 방향 변경은 두 요청이라 부분 실패가 생길 수 있다. dry-run 결합과 삭제 미리 보기는 별도 엔드포인트가 필요하다. 템플릿 적용은 결국 서버 내부 일괄 경로가 필요하다 |
| 팀 숙련도 | 확인 필요 |

장점: 가장 단순하고 시작이 빠르다.

단점: 여러 단계 작업의 원자성과 검증 일관성을 클라이언트가 떠안는다.

### 선택지 C: GraphQL

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 중간~높음. 스키마·리졸버·뮤테이션 설계와 도구 체인이 필요하다 |
| 폐쇄망 반입·운영 부담 | 중간. 서버·클라이언트 라이브러리를 추가로 반입한다 |
| GUI·CLI 동등성(원칙 7) | 높음. 타입 스키마를 공유한다 |
| 관련 요구사항 적합성 | 조회 유연성은 높지만 Tevro 화면은 프로젝트 그래프 전체 조회가 중심이라 이점이 작다. 원자 묶음과 dry-run은 결국 별도 뮤테이션으로 설계해야 한다. HTTP 상태와 CLI 종료 코드 매핑이 덜 직접적이다 |
| 팀 숙련도 | 확인 필요 |

장점: 강한 타입 스키마와 유연한 조회.

단점: Tevro 규모에 비해 도구 부담이 크고, 핵심 문제(원자 묶음, 충돌, dry-run)를 대신 해결하지 않는다.

## 트레이드오프

- 변경 묶음을 핵심 프리미티브로 두면 서버 구현이 커지는 대신, 모든 쓰기 경로의 검증이 하나로 모인다.
- 최종 상태만 검증하면 중간 순환을 피하려고 작업 순서를 맞추지 않아도 되는 대신, 오류가 어느 작업 때문인지 설명하기가 조금 어려워진다. 작업 순번을 오류에 담아 보완한다.
- 실시간 push를 두지 않으면 구현이 단순한 대신, 다른 사용자의 변경은 새로고침해야 보인다. 오래된 화면에서 저장하면 충돌로 알린다.
- 자체 오류 형식은 단순한 대신 표준(RFC 9457) 도구와의 호환은 별도로 챙겨야 한다.

## 결과

쉬워지는 것:

- 웹과 CLI를 같은 계약으로 나란히 개발할 수 있다.
- 오류 코드마다 CLI 종료 코드 하나로 매핑할 수 있다(여러 오류 코드가 한 종료 코드에 대응하는 N:1, ADR-0007).
- dry-run과 실제 실행을 리비전으로 묶을 수 있다(F-C07, AC-19).
- 공정 삭제 미리 보기, 일괄 등록, 템플릿 적용이 같은 경로를 쓴다.

어려워지는 것:

- 변경 묶음 파일 형식을 공개 계약으로 관리해야 한다.
- OpenAPI 생성 절차를 빌드에 넣고 유지해야 한다.

다시 검토할 시점:

- 실시간 협업 요구가 생길 때(push 도입).
- Jira 단계에 들어갈 때(외부 연동 오류 세분화, 부분 성공 응답 형식, 멱등 키, 상태 원본 위반에 대한 거부 코드 필요 여부).
- 프로젝트 그래프가 커져 전체 조회가 느려질 때(부분 조회·페이지네이션).

## 채택 전 확인할 사항

| 항목 | 확인 대상 |
| --- | --- |
| OpenAPI를 스키마 우선으로 쓸지 코드에서 생성할지 | 개발 참여자 |
| 오류 형식을 RFC 9457에 맞출지 | 개발 참여자, 에이전트 사용 담당 |
| 변경 묶음당 최대 작업 수와 요청 크기 제한 | 프로젝트 담당자 |
| GUI 자동 폴링을 둘지, 둔다면 주기 | 프로젝트 담당자 |
| 예상 프로젝트 규모(그래프 전체 조회가 충분한지) | 프로젝트 담당자 |

## 후속 작업

- [ ] OpenAPI 초안을 만든다: 프로젝트, 공정, 종속성, 그래프 조회, 변경 묶음, 세션, 토큰.
- [ ] 변경 묶음 적용기와 최종 상태 검증을 서버 공용 함수로 구현한다(ADR-0003 구조 변경 트랜잭션 안).
- [ ] 오류 코드 목록을 OpenAPI와 CLI 종료 코드 표에 같은 이름으로 넣는다(ADR-0007).
- [ ] AC-04, AC-16, AC-17, AC-18, AC-19 시험을 API 수준에서 만든다.
- [ ] 실행 상태·선행 조건 응답 필드는 후속 ADR 후보 '실행 상태·선행 조건 판정 모델'과 맞춘다([README](./README.md)).
- [ ] 채택하면 PRD §13-13과 §6.8 F-C07 아래 문단을 갱신한다.

## 출처

2026-10-07에 확인했다.

- [RFC 9110 — HTTP Semantics, If-Match와 412][rfc9110]
- [RFC 9457 — Problem Details for HTTP APIs][rfc9457]

[rfc9110]: https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match
[rfc9457]: https://www.rfc-editor.org/rfc/rfc9457.html

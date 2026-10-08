# ADR-0007: CLI 최소 계약

- 상태: 채택 (Accepted)
- 작성일: 2026-10-07
- 개정: 2026-10-07 공정 계층 요구 반영
- 개정: 2026-10-08 채택(최소 계약 6가지, 내부 npm 패키지 배포, Commander.js 15.x, 종료 코드 8 추가, `task move --detach` 추가)
- 결정일: 2026-10-08
- 결정권자: 프로젝트 담당자(soonsm)
- 관련 문서:
  - PRD: [제품 요구사항](../product-requirements.md) §3.2 원칙 7, §6.8 F-C01~F-C10, '명령 체계 예시 — 미확정'과 마지막 문장, §6.9 F-H11, §8 N-03·N-08, §10 AC-13·AC-14·AC-17·AC-19·AC-20·AC-27·AC-31·AC-32, §11 표 아래 문단, §13-10
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

이 결정은 서버 착수를 막지 않는다. 그러나 에이전트가 의존하는 출력 스키마와 종료 코드는 한 번 공개하면 바꾸기 어렵다. 이 ADR 작성 당시(2026-10-07)에는 ADR-0006의 오류 코드가 정해지면 바로 확정할 수 있다고 보았다. 2026-10-08 ADR-0006이 채택되어 오류 형식이 RFC 9457(Problem Details)로 정해졌고, 이 ADR도 같은 날 채택됐다. CLI가 돌아갈 호스트(개발자 PC, 에이전트 실행 환경)에 Node.js가 있는지도 배포 형태를 좌우한다.

## 결정

2026-10-08 결정권자가 제안한 최소 계약 여섯 가지(아래 1~6)를 채택했다. CLI 배포는 선택지 A(내부 npm 패키지), 명령 해석은 Commander.js 15.x로 정했다.

| 항목 | 결정 |
| --- | --- |
| 1. 명사-동사 문법 | 제안대로 채택. `task move --detach`를 지금 추가한다(제안과 달라진 점). `task delete --reconnect`를 둔다([ADR-0005](./0005-identifiers-and-deletion.md)) |
| 2. 구조화 출력 | 제안대로 채택. 성공은 stdout에 `{"schemaVersion": 1, "data": …}`. 오류는 `--json`이면 stderr에 `{"schemaVersion": 1, "error": …}`이고, `error`는 ADR-0006의 RFC 9457 오류 객체를 그대로 담는다 |
| 3. 종료 코드 | 제안한 0~7에 8(서버 연결 실패·시간 초과, CLI 진단)을 더한다. TLS 검증 실패를 1과 8 중 어디에 둘지는 결정 필요 |
| 4. 비대화형·`--yes`·`--dry-run` | 제안대로 채택. `dependency remove`는 `--yes` 없이 실행한다. `task move --detach`는 `--yes`가 필요하다 |
| 5. 서버 주소·토큰·CA 우선순위 | 제안대로 채택. 환경변수·설정 키 이름은 구현 시 확정 |
| 6. CLI-서버 버전 호환 헤더 | 제안대로 채택. 헤더 이름은 구현 시 확정 |
| CLI 배포 | 선택지 A: 내부 npm 레지스트리 패키지(호스트에 Node.js 필요). 에이전트 실행 환경에 Node.js가 없다고 확인되면 선택지 B(단일 실행 파일)를 재검토한다 |
| Commander.js | 15.x(ESM 전용, Node.js 22.12.0 이상) |

결정권자가 명시적으로 답한 범위는 최소 계약 여섯 가지의 제안대로 채택, CLI 배포 선택지 A, Commander.js 15.x, `dependency remove`의 `--yes` 제외, 서버 연결 실패·시간 초과의 종료 코드 8 분리, `task move --detach` 추가다. 환경변수·헤더 이름 같은 세부 표기는 구현 시 확정하기로 했다. `dependency remove`는 결정 과정의 제안 근거(연결 하나는 지워도 다시 추가하기 쉽다)대로 정했다. 그 밖의 선택 사유는 따로 기록되지 않았다. 제안 단계의 판단은 '검토한 선택지'와 각 절의 '제안 단계 원문(기록)'에 둔다.

제안과 달라진 점:

- `task move --detach`: 결정 과정에서는 나중에 더하는 것을 제안했다(이 ADR 본문에서는 '둘지는 결정 필요'). 결정권자가 지금 추가하기로 골랐다. 선택 사유는 기록되지 않았다.

다른 ADR의 결정(2026-10-08)에 맞춰 고친 것:

- §2 오류 출력의 `error`를 ADR-0006이 채택한 RFC 9457 오류 객체로 바꿨다. 제안 단계의 `message`는 `detail`로, `details.errors`는 `errors`로, `CONFLICT`의 현재 값은 `current`로 옮겨졌다.
- `task delete`를 ADR-0005의 결정에 맞췄다. 하위가 있으면 자손까지 지우고, 하위를 한 단계 올리는 옵션은 두지 않는다. `--reconnect`를 둔다.
- `project delete`를 명령 표에 더했다. ADR-0005가 프로젝트의 관리자 삭제(영향 확인 + 명시적 확인)를 초기 핵심에 넣었기 때문이다(PRD §11, F-C01). ADR-0007에 대한 결정권자의 답에는 없는 항목이다. 서버 호출과 영향 미리 보기의 형태는 '남은 확인 사항'이다.

제안 단계에서 결정 필요로 둔 것 중 서버 연결 실패의 별도 종료 코드(8), `dependency remove`의 `--yes` 제외, `--detach`, 배포 형태(A), Commander.js 주 버전(15.x)이 이번에 정해졌다.

이번 결정에서 정하지 않은 것은 다음과 같다. 모두 '남은 확인 사항'에 둔다.

- TLS 검증 실패를 종료 코드 1과 8 중 어디에 둘지.
- 최상위로 올리는 표기(예: `task move --top`).
- 에이전트가 오류를 stdout과 stderr 중 어디서 읽기를 선호하는지. 계약은 제안대로 stderr다.
- 서버 응답 없이 CLI가 판단한 오류(사용법 오류, 토큰 파일 권한, 연결 실패·시간 초과)를 `--json`에서 어떤 오류 객체로 쓸지.
- Windows 호스트의 토큰 파일 권한 규칙.
- `project delete`의 서버 호출과 영향 미리 보기 형태.
- Jira 일괄 작업의 부분 성공 종료 코드(Jira 단계), 템플릿 명령(재사용 단계), 실행 상태 값 표기(후속 ADR 후보).

제안 단계 원문(기록): '초기 핵심에서 다음 여섯 가지를 최소 계약으로 확정하는 것을 제안한다.'

### 1. 명사-동사 문법 — 제안대로 채택(`--detach` 추가)

PRD §6.8 예시의 명사(`project`, `task`, `dependency`, `graph`)와 동사 구성을 유지한다.

| 명령 | 서버 호출(ADR-0006) | 비고 |
| --- | --- | --- |
| `project create`·`list`·`show`·`update` | 프로젝트 API | |
| `project delete <project-id>` | 프로젝트 삭제(ADR-0005 §3) | 관리자만(ADR-0004). `--yes` 필요, `--dry-run`으로 영향(공정·연결 수) 확인(§4). 서버 호출과 영향 미리 보기의 형태는 남은 확인 사항. 보관·보관 해제 명령은 보관을 도입하는 다음 단계에서 더한다(ADR-0005) |
| `task add`·`list`·`show`·`update`·`status` | 공정 API | `update`·`status`는 `--expected-version` 선택. `add --parent <task-id>`로 상위 공정을 지정한다(F-H01, AC-31). `list --parent <task-id>`는 그 상위의 직접 하위만, `--depth <n>`은 n층까지 보여 준다. 둘 다 없으면 프로젝트의 모든 공정을 평면으로 보여 주고 각 항목에 `parentId`가 있다. `status`의 결과에는 자동으로 바뀐 상위 목록이 포함된다(ADR-0006 §8) |
| `task move <task-id> --parent <task-id> [--detach]` | 변경 묶음(`task.move`. `--detach`면 `dependency.remove`들 + `task.move`) | 상위를 바꾼다(F-H08). `--expected-revision` 선택. 연결이 남아 있으면 종료 코드 3과 `HAS_DEPENDENCIES`. `--dry-run`은 같은 오류와 함께 끊어야 할 연결 목록을 보여 준다(AC-32). `--detach` 없이는 데이터를 지우지 않으므로 `--yes`는 필요 없다. `--detach`는 대상 공정의 선행·후속 연결을 지우고 이동한다. 연결 제거와 이동이 한 변경 묶음이다. `--yes` 필요, `--dry-run` 지원. 미리 보기는 끊길 연결 목록이다(아래 문단, 2026-10-08 결정). 최상위로 올리는 표기(예: `--top`)는 정하지 않았다(남은 확인 사항) |
| `task delete <task-id> [--reconnect]` | 변경 묶음(`task.delete`. `--reconnect`면 `task.delete` + 끊기는 쌍의 `dependency.add`) | `--yes` 필요. `--dry-run`으로 영향 확인. `--expected-revision` 선택. 영향 미리 보기는 함께 지워지는 연결(`removedDependencies`), 끊기는 선후 경로(`brokenPaths`), 함께 지워지는 자손 공정(`removedTasks`)이다(ADR-0006 §4). 하위가 있으면 자손까지 지운다. 하위를 한 단계 올리는 옵션은 두지 않는다(ADR-0005, 2026-10-08 결정). `--reconnect`는 끊기는 선후 경로를 모두 다시 잇는다(ADR-0005, 2026-10-08 결정, 아래 문단). 변경 묶음 경로에 필요한 프로젝트는 `GET /api/v1/tasks/{taskId}`로 찾는다. 이때 `NOT_FOUND`면 종료 코드 6으로 끝낸다 |
| `dependency add`·`remove` | 연결 API | (선행, 후속) 공정 쌍으로 지정. 두 공정의 상위가 다르면 `CROSS_LEVEL_DEPENDENCY`로 거부된다(AC-27). `remove`는 `--yes` 없이 실행한다(2026-10-08 결정, §4) |
| `graph show --project <id> [--root <task-id>]` | 그래프 조회 | `--root`는 그 상위 안의 층(직접 하위와 그 사이 연결)만 보여 준다. 없으면 전체 그래프이며 층 구성은 `parentId`로 한다. `--json`에는 공정별 `parentId`·`childCount`·`doneChildCount`가 있다(F-H07, F-H11) |
| `graph apply --project <id> --file <파일>` | 변경 묶음 | `--dry-run`, `--expected-revision` 선택. 삭제 작업이 있으면 `--yes` 필요(§4). 같은 대상을 겹쳐 다루는 애매한 조합은 서버가 `VALIDATION_INPUT`으로 거부한다(종료 코드 3, ADR-0006 §3) |
| `graph validate --project <id> [--file <파일>]` | 변경 묶음 dry-run 또는 무결성 검사 | ADR-0006 §5 정의를 따름 |
| `config set-token --stdin`, `config show` | 로컬 설정 | `config show`는 토큰 값을 출력하지 않음 |
| `version` | 버전 확인 | CLI 버전, 출력 스키마 버전, 서버 API 버전 |

템플릿 명령은 재사용 단계, Jira 명령은 Jira 단계에서 정한다. 템플릿 편집에 별도 명령을 둘지 공통 공정 명령에 대상을 지정할지(§6.8 마지막 문장)는 재사용 단계로 이월한다. 실행 상태 값의 표기(예시의 `in-progress`)는 후속 ADR 후보 '실행 상태·선행 조건 판정 모델'에서 정한다([README](./README.md)).

계층 명령(`--parent`, `task move`, `--depth`, `--root`)의 문법도 예시이며 최종 문법이 아니다(PRD §6.9 F-H11).

**`task move --detach` — 2026-10-08 결정**

- 대상 공정의 선행·후속 연결을 모두 지우고 상위를 바꾼다. 내부에서 그 연결들의 `dependency.remove`와 대상의 `task.move`를 한 변경 묶음으로 보낸다(ADR-0006 §3). 모두 적용되거나 하나도 적용되지 않는다.
- 연결을 지우므로 `--yes`가 필요하다. `--yes`가 없으면 아무것도 바꾸지 않고, 서버 dry-run으로 끊길 연결 목록을 stderr에 쓴 뒤 종료 코드 2로 끝낸다(§4).
- `--dry-run`을 지원한다. 미리 보기는 끊길 연결 목록이다. `--dry-run`에는 `--yes`가 필요 없다.
- `--detach` 없이도 `graph apply --file`에 `dependency.remove`와 `task.move`를 함께 담아 같은 결과를 얻을 수 있다(ADR-0006 §4).
- 제안 단계 원문(기록): '연결 제거와 이동을 한 명령으로 묶는 옵션(예: `task move --detach`, 연결을 지우므로 `--yes` 필요)을 둘지는 결정 필요다. 두지 않으면 `graph apply --file`에 `dependency.remove`와 `task.move`를 함께 담는다(ADR-0006 §4).'

**`task delete --reconnect` — 2026-10-08 결정(ADR-0005)**

- 자동 재연결은 없다. `--reconnect`를 주지 않으면 끊기는 선후 경로를 잇지 않는다.
- `--reconnect`는 끊기는 쌍을 모두 다시 잇는다. 내부에서 대상의 `task.delete`와 끊기는 쌍마다의 `dependency.add`를 한 변경 묶음으로 보낸다. 끊기는 쌍은 삭제 미리 보기의 `brokenPaths`에 나오는 쌍이다. 정의는 ADR-0005를 따른다.
- 일부 쌍만 잇고 싶으면 `graph apply --file`에 `task.delete`와 고른 쌍의 `dependency.add`를 함께 담는다. 사용자가 고른 쌍만 같은 변경 묶음에서 잇는다는 ADR-0005 결정과 같다.
- `task delete`이므로 `--yes`가 필요하다.

### 2. 구조화 출력: `--json` = API DTO + `schemaVersion` — 제안대로 채택(오류는 RFC 9457 객체)

- `--json`을 주면 성공 결과를 stdout에 JSON 하나로 쓴다. 형태는 `{"schemaVersion": 1, "data": <API 응답 DTO>}`다. 목록도 `data` 안에 둔다.
- `data`는 ADR-0006의 응답 DTO를 그대로 쓴다. CLI가 따로 변형하지 않는다. 그래야 GUI와 CLI가 같은 데이터를 본다(원칙 7, AC-13).
- 실패하면 stdout에는 아무것도 쓰지 않는다. `--json`이면 stderr에 `{"schemaVersion": 1, "error": <RFC 9457 오류 객체>}`를 쓴다. `error`는 서버가 보낸 `application/problem+json` 객체(ADR-0006 §6)를 그대로 담는다. CLI가 변형하지 않는다.
- `--json` 없이 실패하면 stderr에 사람이 읽는 진단(`detail` 등)을 쓴다. 형식은 계약이 아니다.
- 서버 응답 없이 CLI가 판단한 오류(사용법 오류, 인증값 없음·토큰 파일 권한, 연결 실패·시간 초과)를 `--json`에서 어떤 오류 객체로 쓸지는 결정 필요(남은 확인 사항). 종료 코드는 §3을 따른다.
- 진행 상황, 경고, 사람이 읽는 진단은 모두 stderr로 보낸다. stdout에는 데이터만 둔다.
- `schemaVersion`은 정수다. 필드 추가는 같은 버전에서 허용하고, 제거·의미 변경 때만 올린다. 사용자는 모르는 필드를 무시한다.
- 공정 DTO에는 `parentId`(최상위면 `null`), `childCount`, `doneChildCount`가 있다. 상태 변경 결과에는 자동으로 바뀐 상위 목록 `autoTransitions`가 있다(ADR-0006 §8). CLI는 이 필드를 더하거나 빼지 않는다(F-H11).
- `--json` 없는 사람용 출력은 계약이 아니다. 형식을 바꿀 수 있다.
- 오류를 stderr에 쓰는 것은 제안대로 채택했다. 에이전트가 stdout을 선호하는지는 남은 확인 사항이다.

`error` 객체의 멤버는 ADR-0006 §6을 따른다.

| 멤버 | 구분 | 내용 |
| --- | --- | --- |
| `type` | 표준 | 오류 코드별 URI 참조. 정확한 URI 형식은 구현 시 확정 |
| `title` | 표준 | 짧은 요약 |
| `status` | 표준 | HTTP 상태 |
| `detail` | 표준 | 사람이 읽는 한국어 문장. 제안 단계의 `message`를 대신한다 |
| `instance` | 표준(선택) | 이 오류 발생 건을 가리키는 URI 참조 |
| `code` | 확장 | 오류 코드 문자열(예: `VALIDATION_CYCLE`). 종료 코드는 이것으로 정한다(§3) |
| `errors` | 확장 | 구조 검증 오류 목록. 각 항목은 `{code, operationIndex, cycle?, path?, parentIds?, dependencies?}`. 제안 단계의 `details.errors`와 같다 |
| `requestId` | 확장 | 로그 대조용 |
| `current` | 확장 | `CONFLICT`일 때 현재 `graphRevision` 또는 `version`을 담는 객체 |

오류 객체에는 인증값을 넣지 않는다(F-C09, AC-20).

`--json` 오류 출력 예시(stderr):

```json
{
  "schemaVersion": 1,
  "error": {
    "type": "…",
    "title": "순환을 만드는 변경",
    "status": 422,
    "detail": "이 연결을 추가하면 순환이 생겨 저장할 수 없습니다: B → A → B",
    "code": "VALIDATION_CYCLE",
    "errors": [
      { "code": "VALIDATION_CYCLE", "operationIndex": 0, "cycle": ["tsk_B…", "tsk_A…", "tsk_B…"] }
    ],
    "requestId": "…"
  }
}
```

`CONFLICT`면 `error`에 `"code": "CONFLICT"`와 `"current": { "graphRevision": 42 }`처럼 현재 값이 들어 있다. 에이전트는 이 값으로 무엇을 다시 읽어야 하는지 안다.

제안 단계 원문(기록): '실패하면 stdout에는 아무것도 쓰지 않는다. `--json`이면 stderr에 `{"schemaVersion": 1, "error": {code, message, details, requestId}}`를 쓴다.'

### 3. 종료 코드 — 제안대로 채택(8 추가)

서버 오류 코드마다 종료 코드가 하나로 정해진다(ADR-0006 §6). CLI는 오류 객체의 `code`로 종료 코드를 정한다. HTTP 상태(`status`)로 정하지 않는다.

| 종료 코드 | 의미 | 서버 오류 코드 또는 CLI 상황 |
| --- | --- | --- |
| 0 | 성공 | dry-run 검증 통과 포함. `warnings`가 있어도 0 |
| 1 | 기타 오류 | `INTERNAL`, `CLIENT_VERSION_UNSUPPORTED`. TLS 검증 실패(CLI 진단)를 1에 둘지 8에 둘지는 결정 필요 |
| 2 | 사용법 오류·입력 누락 | 서버 호출 전 CLI가 찾은 오류: 알 수 없는 옵션, 필수 인자 누락. 그리고 파괴적 변경의 `--yes` 누락(서버 dry-run으로 영향을 보여 준 뒤 종료, §4) |
| 3 | 검증 실패 | `VALIDATION_INPUT`, `VALIDATION_SELF_LOOP`, `VALIDATION_DUPLICATE_EDGE`, `VALIDATION_CYCLE`, `REFERENCE_NOT_FOUND`, `CROSS_PROJECT_REFERENCE`, `HIERARCHY_CYCLE`, `CROSS_LEVEL_DEPENDENCY`, `HAS_DEPENDENCIES`. `VALIDATION_INPUT`에는 변경 묶음에서 같은 대상을 겹쳐 다루는 애매한 조합의 거부가 포함된다(ADR-0006 §3) |
| 4 | 인증·권한 | `UNAUTHENTICATED`, `FORBIDDEN`, 인증값을 찾지 못하거나 토큰 파일 권한이 너무 넓음(CLI 진단) |
| 5 | 동시 수정 충돌 | `CONFLICT`(AC-17) |
| 6 | 대상 없음 | `NOT_FOUND` |
| 7 | 외부 연동 실패 — 예약 | `EXTERNAL_INTEGRATION_FAILED`(Jira 단계) |
| 8 | 서버 연결 실패·시간 초과 | CLI 진단: 서버에 연결하지 못함, 응답을 기다리다 시간이 지남(2026-10-08 추가) |

- `--yes` 없는 파괴적 변경은 미리 보기를 위해 서버 dry-run을 호출한다. dry-run이 오류로 끝나면 그 오류의 종료 코드(예: `NOT_FOUND`면 6, `UNAUTHENTICATED`면 4, 서버에 닿지 못하면 8)를, 통과하면 2를 반환한다.
- Commander.js의 기본 사용 오류 처리 동작(종료 코드 포함)을 채택 버전(15.x)에서 확인하고, 계약의 2로 맞춘다.
- 서버 연결 실패·시간 초과는 종료 코드 8로 분리한다(2026-10-08 결정). 기타 오류(1)와 구분해 에이전트가 재시도 여부를 판단하는 데 쓴다.
- 쓰기 명령이 시간 초과로 8이 되면 적용 여부를 알 수 없다. 다시 실행할 때 `--expected-revision`을 넣으면, 앞선 요청이 이미 적용된 경우 종료 코드 5로 거부된다. 그러면 그래프를 다시 읽어 확인한다(ADR-0006 §4 '응답을 받지 못한 재시도').
- TLS 검증 실패를 1에 둘지 8에 둘지는 결정 필요. 결정권자가 답하지 않았다.
- Jira 일괄 작업의 부분 성공(AC-10)을 어떤 종료 코드로 알릴지는 Jira 단계에서 정한다.

제안 단계 원문(기록): 1 행은 '`INTERNAL`, `CLIENT_VERSION_UNSUPPORTED`, 서버 연결 실패·TLS 검증 실패(CLI 진단)'였다. '서버 연결 실패를 1과 다른 코드로 분리할지는 결정 필요. 에이전트가 재시도 대상을 구분하는 데 쓸 수 있다.'

### 4. 비대화형·파괴적 변경·dry-run — 제안대로 채택(`dependency remove` 제외)

- 어떤 경우에도 프롬프트를 띄우지 않는다. 터미널 여부에 따라 동작을 바꾸지 않는다(F-C03).
- 아래 표에서 `--yes`가 필요한 명령은 `--yes`가 있어야 실행한다. `--yes`가 없으면 아무것도 바꾸지 않고, 서버 dry-run(ADR-0006 §4)으로 얻은 영향 미리 보기를 stderr에 쓴 뒤 종료 코드 2로 끝낸다. 그 dry-run이 오류로 끝나면 그 오류의 종료 코드를 따른다(§3).

| 명령 | `--yes` | 근거 |
| --- | --- | --- |
| `task delete` | 필요 | 공정과 연결을 지운다. 하위가 있으면 자손까지 지운다(ADR-0005) |
| 삭제 작업(`task.delete`, `dependency.remove`)을 포함한 `graph apply` | 필요 | 제안대로 |
| `task move --detach` | 필요 | 대상 공정의 연결을 지운다(2026-10-08 결정) |
| `project delete` | 필요 | 프로젝트의 공정·연결을 지운다. ADR-0005의 '명시적 확인' |
| `dependency remove` | 필요 없음 | 2026-10-08 결정. 연결 하나는 지워도 다시 추가하기 쉽다(결정 과정의 제안 근거). 이 예외는 `dependency remove` 단건 명령에만 적용한다 |
| `task move`(`--detach` 없이) | 필요 없음 | 데이터를 지우지 않는다 |

- 제안 단계 원문(기록): '데이터를 지우는 명령(`delete`, `remove`)과 삭제 작업을 포함한 `graph apply`는 `--yes`가 있어야 실행한다. … `dependency remove`를 이 규칙에서 뺄지는 결정 필요.'
- 영향이 큰 작업은 `--dry-run`을 제공한다. 기계가 읽을 미리 보기가 필요하면 `--dry-run --json`을 쓴다. 성공하면 stdout에 결과를 쓰고 종료 코드 0이다. 실패하면 stderr에 오류를 쓰고(§2), 종료 코드는 실제 실행과 같은 오류 코드 매핑(§3)을 따른다. 예를 들어 검증 실패는 3, `--expected-revision` 불일치는 5, 대상 없음은 6, 인증 실패는 4다. `--dry-run`에는 `--yes`가 필요 없다.
- dry-run 결과의 `baseGraphRevision`을 실제 실행의 `--expected-revision`으로 넘기면, 그 사이 구조가 바뀐 경우 종료 코드 5로 거부된다(ADR-0006 §4, F-C07).
- `task move`(`--detach` 없이)는 연결이 남아 있으면 서버가 `HAS_DEPENDENCIES`로 거부하고 종료 코드 3이다. `--dry-run`이면 같은 오류를 stderr(`--json`이면 `error.errors[].dependencies`)에 쓴다. 사용자는 연결을 지운 뒤 다시 실행하거나, `--detach --yes`로 제거와 이동을 한 번에 하거나, `graph apply`로 제거와 이동을 한 묶음에 담는다(AC-32).
- `graph apply --file`에 같은 대상을 겹쳐 다루는 작업(같은 연결의 `dependency.remove`와 `dependency.add`, 삭제한 공정을 다른 작업이 참조하는 경우 등)이 있으면 서버가 `VALIDATION_INPUT`으로 거부하고 종료 코드 3이다(ADR-0006 §3). 서로 다른 대상을 다루는 조합(예: 연결의 `dependency.remove`와 공정의 `task.move`)은 허용된다.
- 그래서 `--detach`(연결들의 `dependency.remove` + 대상의 `task.move`)와 `--reconnect`(대상의 `task.delete` + 끊기는 쌍의 `dependency.add`)가 만드는 묶음은 이 거부 규칙에 걸리지 않는다. `--reconnect`가 더하는 연결은 삭제할 공정 B의 직접 선행 p와 직접 후속 s를 잇는 p → s이므로 B를 참조하지 않는다(ADR-0005).
- 조회 명령(`list`, `show`, `graph show`, `graph validate`)은 데이터를 바꾸지 않는다(F-C06).

### 5. 서버 주소·인증값·사내 CA — 제안대로 채택

| 항목 | 1순위: 플래그 | 2순위: 환경변수 | 3순위: 설정 파일 |
| --- | --- | --- | --- |
| 서버 주소 | `--server <URL>` | `TEVRO_SERVER` | `server` |
| 인증 토큰 | `--token-file <경로>`(경로만 받음) | `TEVRO_TOKEN` | `token`(권한 600 파일) |
| 추가 신뢰 CA | `--ca-file <PEM 경로>` | `TEVRO_CA_FILE` | `caFile` |

우선순위(플래그 → 환경변수 → 설정 파일)는 채택했다. 환경변수와 설정 키 이름은 구현할 때 확정한다(2026-10-08 결정).

- 토큰 값을 받는 명령행 인자는 두지 않는다. 프로세스 목록과 셸 이력에 남기 때문이다(F-C09, ADR-0004). 토큰 파일 경로는 비밀값이 아니므로 인자로 받는다.
- 토큰 등록은 표준 입력으로 받는다(`config set-token --stdin`). CLI가 권한 600 설정 파일에 저장한다.
- 토큰 파일이나 설정 파일의 권한이 소유자 외에도 읽을 수 있게 열려 있으면 사용을 거부한다(종료 코드 4). Windows 호스트에서의 동등한 규칙은 확인 필요(남은 확인 사항).
- 토큰 값은 어떤 출력·오류·디버그 로그에도 쓰지 않는다. 토큰 접두사(ADR-0004)로 찾아 가린다(AC-20).
- `--ca-file`은 기본 신뢰 목록에 '더하는' 방식으로 구현한다. Node.js에서 TLS 클라이언트의 `ca` 옵션을 직접 지정하면 기본·추가 인증서가 쓰이지 않기 때문이다. Node.js로 실행하는 CLI는 `NODE_EXTRA_CA_CERTS`(프로세스 시작 시 읽음)도 쓸 수 있다. [Node.js CLI 문서][node-cli] 배포 선택지 A를 채택했으므로 CLI는 호스트의 Node.js로 실행된다. 단일 실행 파일 번들에서의 동작은 선택지 B를 재검토할 때 확인한다. 제안 단계 원문(기록): '단일 실행 파일 번들에서도 같은지는 채택 전 확인한다.'
- 인증서 검증을 끄는 옵션(`--insecure` 류)은 기본 제공하지 않는다(N-08, OSS §11.2).
- TLS 검증 실패의 종료 코드(1 또는 8)는 결정 필요(§3).

### 6. CLI-서버 버전 호환성 — 제안대로 채택

- CLI는 요청마다 자기 버전을 헤더로 보낸다(예: `Tevro-Client-Version`).
- 서버는 API 버전과 지원하는 최소 CLI 버전을 응답 헤더로 알린다(예: `Tevro-Api-Version`).
- 지원하지 않는 CLI면 서버가 `CLIENT_VERSION_UNSUPPORTED`로 거부하고, CLI는 종료 코드 1과 함께 업그레이드 안내를 stderr에 쓴다.
- `version --json`으로 CLI 버전, `schemaVersion`, 서버 API 버전을 한 번에 확인한다.
- 헤더 이름은 구현할 때 확정한다(2026-10-08 결정).

### 도움말(F-C10)

- 명령마다 `--help`로 필수 인자, 선택 옵션, `--json` 출력의 `data` 형태, 가능한 종료 코드를 보여 준다.
- 종료 코드 표 전체를 도구 안에서 확인하는 방법(예: `help exit-codes`)을 둔다.

### Commander.js 주 버전 — 15.x 채택

2026-10-08 결정권자가 Commander.js 15.x를 채택했다. 15.x는 ESM 전용이고 Node.js 22.12.0 이상이 필요하다. 배포 선택지 A(npm 패키지)를 채택했으므로 CLI 호스트에 Node.js 22.12.0 이상이 있어야 한다. CLI 호스트의 Node.js 유무·버전은 '남은 확인 사항'이다. 고정 버전은 ADR-0001 후속 작업(채택 패키지의 고정 버전 기록, OSS §11.1)에서 정한다. 14.x는 채택하지 않았다. 사유는 기록되지 않았다.

2026-10-07 기준 사실은 다음과 같다. [Commander.js CHANGELOG][commander-changelog], [Node.js 릴리스 일정][node-release]

| 항목 | 내용 |
| --- | --- |
| Commander.js 15.x | 15.0.0(2026-05-29). ESM 전용, Node.js 22.12.0 이상 필요. MIT |
| Commander.js 14.x | 2027-05까지 보안 업데이트 제공 |
| Node.js 22 | Maintenance LTS, 2027-04-30 지원 종료 |
| Node.js 24 | Active LTS, 2028-04-30 지원 종료 |

제안 단계 원문(기록): 'CLI 호스트의 Node.js가 22.12.0 이상임이 확인되거나 CLI 배포 선택지 B(단일 실행 파일 번들, 아래 '검토한 선택지')를 고르면 15.x를 제안한다. 14.x로 시작하면 2027-05 보안 지원 종료 전에 올려야 한다.'

## 검토한 선택지

제안 단계에서는 계약(위 1~6)을 배포 형태와 무관하게 제안했다. 배포 형태는 두 선택지 중에서 CLI 호스트의 Node.js 유무를 확인한 뒤 고르기로 했다(기록).

2026-10-08 결정권자가 선택지 A를 채택했다. CLI 호스트의 Node.js 유무·버전은 '남은 확인 사항'으로 남았다. 에이전트 실행 환경에 Node.js가 없다고 확인되면 선택지 B를 재검토한다.

### 선택지 A: 내부 npm 레지스트리 패키지 (호스트에 Node.js 필요) — 채택

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 낮음. 일반 npm 패키지로 빌드·게시한다 |
| 폐쇄망 반입·운영 부담 | 내부 npm 레지스트리가 있어야 한다([ADR-0002](./0002-deployment-packaging.md)). 호스트마다 지원되는 Node.js(Commander 15라면 22.12.0 이상)가 있어야 한다 |
| GUI·CLI 동등성(원칙 7) | 계약과 무관. 같은 서버 API를 쓴다 |
| 관련 요구사항 적합성 | N-03(설치 재현성)은 레지스트리와 버전 고정으로 충족한다. AC-14는 내부 레지스트리에서 설치하면 충족한다 |
| 팀 숙련도 | 확인 필요 |

장점: 빌드·배포가 가장 단순하다. `NODE_EXTRA_CA_CERTS` 등 Node.js 표준 설정을 그대로 쓴다.

단점: 호스트의 Node.js 버전에 묶인다. 에이전트 실행 환경마다 Node.js를 관리해야 한다.

결정 시점 판단(2026-10-08): 결정권자가 채택했다. 선택 사유는 기록되지 않았다.

### 선택지 B: 단일 실행 파일 번들 (Node.js SEA 등) — 채택하지 않음(에이전트 실행 환경에 Node.js가 없으면 재검토)

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 중간. 모든 코드를 스크립트 하나로 번들한 뒤 실행 파일에 넣는다. OS·아키텍처별로 빌드한다 |
| 폐쇄망 반입·운영 부담 | 호스트에 Node.js가 필요 없다. 실행 파일 하나를 반입한다. 대신 Node.js 보안 패치마다 다시 빌드·배포한다 |
| GUI·CLI 동등성(원칙 7) | 계약과 무관 |
| 관련 요구사항 적합성 | N-03, AC-14를 충족한다. Node.js 문서상 SEA는 Stability 1.1(Active development)이다. 기본적으로 `require()`·`import`는 내장 모듈만 불러올 수 있어 번들이 전제다. 정기 시험 플랫폼도 문서에 제한되어 있다 [Node.js SEA][node-sea] |
| 팀 숙련도 | 확인 필요 |

장점: 호스트 환경 차이를 없앤다. 에이전트 실행 환경에 넣기 쉽다.

단점: 기능이 아직 활발히 바뀌는 단계다. 빌드 파이프라인과 OS별 시험 부담이 있다.

제안 단계 제목은 '단일 실행 파일 번들 (Node.js SEA 등, 채택 전 검증)'이었다(기록).

결정 시점 판단(2026-10-08): 결정권자가 선택지 A를 채택했으므로 채택하지 않았다. 에이전트 실행 환경에 Node.js가 없다고 확인되면 다시 검토한다. 그때 SEA 스파이크를 하고, 번들에서의 `--ca-file`·`NODE_EXTRA_CA_CERTS` 동작도 확인한다(§5).

## 트레이드오프

- 출력 계약을 일찍 고정하면 에이전트가 안정적으로 쓸 수 있는 대신, 초기 실수를 고치려면 `schemaVersion`을 올려야 한다.
- 실패 정보를 stderr에만 쓰면 stdout이 깨끗한 대신, 에이전트는 두 스트림을 모두 읽어야 한다. 제안대로 stderr로 정했다. 에이전트의 선호는 남은 확인 사항이다.
- 서버의 RFC 9457 오류 객체를 그대로 전달하면 GUI와 CLI가 같은 오류 정보를 보는 대신, 서버 응답이 없는 CLI 진단 오류는 같은 모양을 CLI가 따로 만들어야 한다(남은 확인 사항).
- `--yes` 규칙을 모든 삭제에 적용하면 예측 가능한 대신, 단순한 연결 삭제도 번거로워진다. `dependency remove`를 이 규칙에서 빼서(2026-10-08 결정) 연결 하나 삭제는 간단하다. 대신 삭제 명령이라고 모두 `--yes`가 필요한 것은 아니게 되었다.
- `task move --detach`는 연결 제거와 이동을 한 명령으로 원자적으로 하는 대신, 한 번에 여러 연결을 지운다. `--yes`와 미리 보기로 보완한다.
- 연결 실패·시간 초과를 8로 분리하면 에이전트가 재시도 대상을 구분하기 쉬운 대신, 쓰기 명령의 시간 초과는 적용 여부를 알 수 없어 재시도 전에 리비전으로 확인해야 한다(§3).
- 토큰을 인자로 받지 않으면 안전한 대신, 처음 설정할 때 한 단계가 늘어난다.
- 배포 선택지 A는 단순하지만 호스트에 묶이고, B는 호스트와 무관하지만 빌드가 복잡하다. A를 채택했으므로 CLI 호스트마다 Node.js 22.12.0 이상을 관리해야 한다.

## 결과

쉬워지는 것:

- 에이전트가 종료 코드만으로 실패 종류를 구분할 수 있다(F-C05). 서버에 닿지 못한 경우(8)도 다른 오류와 구분한다.
- dry-run과 실제 실행을 리비전으로 안전하게 이을 수 있다(F-C07, AC-19).
- GUI와 CLI가 같은 DTO와 같은 오류 객체를 보므로 AC-13 시험이 단순해진다.
- `--parent`·`task move`·`--root`가 서버 계약의 필드와 작업에 그대로 대응하므로 AC-27·AC-31·AC-32를 GUI와 같은 서버 판정으로 시험한다.
- `task move --detach`와 `task delete --reconnect`로 에이전트가 변경 묶음 파일 없이 흔한 구조 변경을 한 번에 할 수 있다.

어려워지는 것:

- 출력 스키마와 종료 코드 표를 공개 계약으로 관리해야 한다.
- 토큰 파일 권한 검사 등 OS별 동작을 시험해야 한다.
- CLI 호스트마다 Node.js 22.12.0 이상을 유지해야 한다(선택지 A, Commander.js 15.x).

다시 검토할 시점:

- Jira 단계에 들어갈 때(부분 성공 종료 코드, `jira` 명령군).
- 재사용 단계에 들어갈 때(템플릿 편집 명령 형태).
- 에이전트 실행 환경에 Node.js가 없다고 확인될 때(선택지 B 재검토).
- CLI 호스트의 Node.js 환경이 바뀔 때(배포 형태, Commander.js 15.x의 Node.js 요구 버전).

## 남은 확인 사항

채택 시점(2026-10-08)에 아래 사항 중 '결정됨'으로 표시하지 않은 것은 아직 확인·결정되지 않았다. 확인 결과가 이 결정과 맞지 않으면 새 ADR을 써서 이 ADR을 대체한다([README §1](./README.md)).

| 항목 | 확인 대상 |
| --- | --- |
| CLI 실행 호스트(개발자 PC, 에이전트 실행 환경)의 OS와 Node.js 유무·버전. 선택지 A와 Commander.js 15.x에는 Node.js 22.12.0 이상이 필요하다. 에이전트 실행 환경에 Node.js가 없으면 선택지 B를 재검토한다 | 개발 참여자, 에이전트 사용 담당 |
| 내부 npm 레지스트리 유무 — 개발 PC용 미러는 있음(2026-10-08 확인). CLI 실행 호스트·에이전트 실행 환경에서 접근할 수 있는지는 미확인 | 사내 인프라 담당(ADR-0002) |
| 에이전트가 오류를 stdout과 stderr 중 어디서 읽기를 선호하는지. 계약은 제안대로 stderr | 에이전트 사용 담당 |
| 서버 연결 실패를 별도 종료 코드로 둘지 — 결정됨(2026-10-08): 연결 실패·시간 초과를 8로 분리 | 에이전트 사용 담당 |
| TLS 검증 실패를 종료 코드 1과 8 중 어디에 둘지 — 결정 필요 | 프로젝트 담당자, 에이전트 사용 담당 |
| 서버 응답 없이 CLI가 판단한 오류(사용법 오류, 인증값 없음·토큰 파일 권한, 연결 실패·시간 초과)의 `--json` 오류 객체 형태 — 결정 필요 | 프로젝트 담당자, 에이전트 사용 담당 |
| `dependency remove`에도 `--yes`를 요구할지 — 결정됨(2026-10-08): 요구하지 않음 | 프로젝트 담당자 |
| `task move`에 연결 제거를 묶는 옵션(`--detach`)을 둘지 — 결정됨(2026-10-08): 지금 둔다 | 프로젝트 담당자, 에이전트 사용 담당 |
| 최상위로 올리는 표기(예: `--top`) — 결정 필요 | 프로젝트 담당자, 에이전트 사용 담당 |
| Windows 호스트에서 토큰 파일·설정 파일 권한 검사의 동등한 규칙(§5) | 개발 참여자 |
| 사내 CA 파일 배포 방식(호스트에 설치되어 있는지) | 사내 보안·인프라 담당 |
| `project delete`의 서버 호출과 영향 미리 보기 형태 — ADR-0005·ADR-0006과 함께 확정 | 프로젝트 담당자 |
| Jira 일괄 작업의 부분 성공 종료 코드(AC-10) — Jira 단계 | 프로젝트 담당자 |
| 템플릿 편집 명령의 형태(§6.8 마지막 문장) — 재사용 단계 | 프로젝트 담당자 |

## 후속 작업

- [ ] 종료 코드 표와 ADR-0006 오류 코드 표를 하나의 원천에서 생성하거나 시험으로 일치를 확인한다. 종료 코드 8(CLI 진단)을 포함한다.
- [ ] `--json` 출력 스키마를 OpenAPI DTO에서 그대로 쓰도록 CLI 구조를 잡는다. 계층 필드(`parentId`, `childCount`, `doneChildCount`, `autoTransitions`)를 포함한다. 오류는 서버의 RFC 9457 객체를 그대로 `error`에 담는다.
- [ ] 설정 우선순위, 토큰 파일 권한 검사, `--ca-file` 동작을 구현·시험한다.
- [ ] AC-17(충돌 시 종료 코드 5), AC-19(dry-run 무변경), AC-20(인증값 비노출), AC-27(다른 층 연결 거부), AC-31(`--parent` 생성), AC-32(`task move` 미리 보기) CLI 시험을 만든다.
- [ ] `task move --detach`(`--yes` 누락 시 종료 코드 2, `--dry-run` 미리 보기), `task delete --reconnect`, 연결 실패·시간 초과(종료 코드 8) CLI 시험을 만든다.
- [x] 배포 선택지 A 또는 B를 고른다(2026-10-08 결정권자가 선택지 A 채택). CLI 호스트 확인은 남은 확인 사항으로 남았다.
- [ ] 에이전트 실행 환경에 Node.js가 없다고 확인되면 선택지 B를 재검토하고 SEA 스파이크를 한다.
- [x] Commander.js 주 버전을 정한다(2026-10-08 15.x 채택).
- [ ] Commander.js 고정 버전을 기록한다(ADR-0001 후속 작업, OSS §11.1). 15.x의 기본 사용 오류 처리 동작(종료 코드 포함)을 확인하고 계약의 2로 맞춘다.
- [x] PRD §13-10과 §6.8 '명령 체계 예시'의 비고를 채택 결과로 갱신한다(2026-10-08).

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

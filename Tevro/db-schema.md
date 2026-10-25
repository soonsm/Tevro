# Tevro — 테이블 설계서(ERD)

- 문서 상태: MVP 코드 기준 설명서. 스키마의 원본은 코드(`src/server/store.ts`의 `SCHEMA`와 `MIGRATIONS`)이며, 스키마를 바꾸면 이 문서도 함께 고친다.
- 스키마 버전: 2(공정 계층 추가). 버전 이력은 7장
- 작성 기준일: 2026-10-25
- 대상 DB: SQLite 3.53(`better-sqlite3`에 포함), 파일 하나(`data/tevro.db`, 위치는 `TEVRO_DATA_DIR`로 바꿈)
- 관련 문서: [ADR-0003 저장소와 동시 수정 모델](./adr/0003-storage-and-concurrency.md), [ADR-0005 식별자 체계와 삭제 정책](./adr/0005-identifiers-and-deletion.md), [제품 요구사항 §6.9 공정 계층, §7](./product-requirements.md)

## 1. ERD

```mermaid
erDiagram
    projects ||--o{ tasks : "포함한다"
    tasks ||--o{ tasks : "하위 공정 (parent_id)"
    tasks ||--o{ dependencies : "선행 공정 (from_task_id)"
    tasks ||--o{ dependencies : "후속 공정 (to_task_id)"

    projects {
        TEXT id PK "prj_ + ULID"
        TEXT name "프로젝트 이름"
        TEXT description "설명"
        TEXT created_at "만든 시각"
        TEXT updated_at "고친 시각"
    }

    tasks {
        TEXT id PK "tsk_ + ULID"
        TEXT project_id FK "소속 프로젝트"
        TEXT parent_id FK "상위 공정, 최상위면 NULL"
        TEXT title "제목"
        TEXT description "설명(작업 절차, 완료 기준)"
        TEXT status "todo, in-progress, done"
        TEXT jira_url "Jira 이슈 주소, NULL 가능"
        TEXT confluence_url "Confluence 문서 주소, NULL 가능"
        TEXT created_at "만든 시각"
        TEXT updated_at "고친 시각"
    }

    dependencies {
        TEXT project_id PK, FK "소속 프로젝트"
        TEXT from_task_id PK, FK "선행 공정"
        TEXT to_task_id PK, FK "후속 공정"
        TEXT created_at "연결한 시각"
    }
```

`dependencies` 한 행이 연결 하나다. `from_task_id → to_task_id`는 from 공정이 to 공정의 선행 공정이라는 뜻이다.

포함관계(상위·하위)와 선행관계(연결)는 다른 차원이라 섞지 않는다(PRD §5.3). 포함관계는 `tasks.parent_id`로, 선행관계는 `dependencies`로만 나타낸다. 같은 `parent_id`를 가진 공정들(최상위끼리 포함)이 한 층을 이루고, 연결은 같은 층 안에서만 맺는다.

## 2. 테이블 목록

| 테이블 | 담는 것 | 관계 |
| --- | --- | --- |
| `projects` | 프로젝트 | 공정을 0개 이상 가진다 |
| `tasks` | 공정(할 일) | 한 프로젝트에 속하고, 상위 공정을 0~1개 가지며, 연결의 선행·후속이 된다 |
| `dependencies` | 선후관계(연결) | 같은 프로젝트, 같은 층의 공정 둘을 잇는다 |

## 3. 관계

| 관계 | 카디널리티 | 연결 키 | 부모를 지우면 |
| --- | --- | --- | --- |
| projects → tasks | 1 : 0..N | `tasks.project_id` → `projects.id` | 공정도 지워진다(CASCADE). MVP에는 프로젝트 삭제 기능이 없다 |
| tasks → tasks(상위 → 하위) | 0..1 : 0..N | `(project_id, parent_id)` → `tasks(project_id, id)` | 하위 공정이 지워지고, 그 하위의 하위까지 차례로 지워진다(CASCADE, ADR-0005) |
| tasks → dependencies(선행) | 1 : 0..N | `(project_id, from_task_id)` → `tasks(project_id, id)` | 그 공정의 연결이 지워진다(CASCADE) |
| tasks → dependencies(후속) | 1 : 0..N | `(project_id, to_task_id)` → `tasks(project_id, id)` | 그 공정의 연결이 지워진다(CASCADE) |

`dependencies`에는 `projects`로 가는 외래 키가 따로 없다. 두 복합 외래 키가 같은 `project_id`를 쓰므로 선행·후속 공정이 모두 그 프로젝트에 속해야만 저장된다. 다른 프로젝트의 공정끼리는 DB 수준에서도 이을 수 없다. `parent_id`도 같은 방식이라 다른 프로젝트의 공정을 상위로 둘 수 없다.

## 4. 테이블 정의

NULL 열의 `N`은 NOT NULL이다. 길이 제한과 형식 검사는 서버가 한다(SQLite는 TEXT 길이를 제한하지 않는다).

### 4.1 projects — 프로젝트

| 컬럼 | 타입 | NULL | 기본값 | 키 | 설명 |
| --- | --- | --- | --- | --- | --- |
| `id` | TEXT | N | | PK | `prj_` + ULID 26자(소문자). 예: `prj_01m5rz3a4a288bbvgc0rbsvc51` |
| `name` | TEXT | N | | | 프로젝트 이름. 앞뒤 공백을 지우고 1~100자 |
| `description` | TEXT | N | `''` | | 설명, 최대 10,000자. MVP 화면에는 입력란이 없고 API로만 넣는다 |
| `created_at` | TEXT | N | | | 만든 시각. ISO 8601 UTC 문자열(예: `2026-10-25T07:14:17.026Z`) |
| `updated_at` | TEXT | N | | | 고친 시각. MVP에는 프로젝트 수정 기능이 없어 만든 시각과 같다 |

### 4.2 tasks — 공정

| 컬럼 | 타입 | NULL | 기본값 | 키 | 설명 |
| --- | --- | --- | --- | --- | --- |
| `id` | TEXT | N | | PK | `tsk_` + ULID 26자(소문자). 제목을 바꾸거나 상위를 옮겨도 그대로다 |
| `project_id` | TEXT | N | | FK | 소속 프로젝트. `projects.id` 참조, ON DELETE CASCADE |
| `parent_id` | TEXT | Y | NULL | FK | 상위 공정. NULL이면 최상위. `(project_id, parent_id)` → `tasks(project_id, id)`, ON DELETE CASCADE. 만들 때 정하고, 바꿀 때는 이동 API(`POST /api/v1/tasks/{id}/move`)만 쓴다 |
| `title` | TEXT | N | | | 제목. 앞뒤 공백을 지우고 1~200자 |
| `description` | TEXT | N | `''` | | 설명(작업 절차, 완료 기준 등). 최대 10,000자 |
| `status` | TEXT | N | `'todo'` | CHECK | 실행 상태. `todo`(미착수), `in-progress`(진행 중), `done`(완료). 하위 공정이 있으면 서버가 자동으로 바꾸기도 한다(5장) |
| `jira_url` | TEXT | Y | NULL | | Jira 이슈 주소. http·https만, 최대 2,000자. 링크만 저장하며 Jira 상태는 가져오지 않는다 |
| `confluence_url` | TEXT | Y | NULL | | Confluence 문서 주소. http·https만, 최대 2,000자 |
| `created_at` | TEXT | N | | | 만든 시각(ISO 8601 UTC) |
| `updated_at` | TEXT | N | | | 고친 시각. 제목·설명·상태·링크·상위를 바꿀 때와 자동 전이 때 갱신 |

제약과 인덱스:

- `UNIQUE (project_id, id)`: `dependencies`의 복합 외래 키와 `parent_id` 외래 키가 가리키는 키다. `id`만으로도 유일하지만, 프로젝트까지 묶어야 "같은 프로젝트의 공정"인지 DB가 확인할 수 있다.
- `CHECK (status IN ('todo', 'in-progress', 'done'))`: 세 값 밖의 상태를 막는다.
- `CHECK (parent_id IS NULL OR parent_id <> id)`: 공정을 자기 자신의 상위로 두지 못한다. 자손을 상위로 두는 고리는 여러 행에 걸친 조건이라 서버가 검사한다(5장).
- `FOREIGN KEY (project_id, parent_id) REFERENCES tasks (project_id, id) ON DELETE CASCADE`: 상위는 같은 프로젝트의 있는 공정이어야 한다. `parent_id`가 NULL이면 검사하지 않는다(SQLite 복합 외래 키 규칙).
- `INDEX tasks_by_project (project_id)`: 프로젝트의 공정 목록 조회용.
- `INDEX tasks_by_parent (project_id, parent_id)`: 하위 공정 찾기와, 공정을 지울 때 CASCADE가 하위를 찾는 데 쓴다.

깊이 제한은 두지 않는다(PRD §5.3).

### 4.3 dependencies — 선후관계

| 컬럼 | 타입 | NULL | 기본값 | 키 | 설명 |
| --- | --- | --- | --- | --- | --- |
| `project_id` | TEXT | N | | PK, FK | 소속 프로젝트. 아래 두 외래 키에 함께 쓰인다 |
| `from_task_id` | TEXT | N | | PK, FK | 선행 공정. `(project_id, from_task_id)` → `tasks(project_id, id)`, ON DELETE CASCADE |
| `to_task_id` | TEXT | N | | PK, FK | 후속 공정. `(project_id, to_task_id)` → `tasks(project_id, id)`, ON DELETE CASCADE |
| `created_at` | TEXT | N | | | 연결한 시각(ISO 8601 UTC) |

제약:

- `PRIMARY KEY (project_id, from_task_id, to_task_id)`: 같은 연결을 두 번 넣지 못한다.
- `CHECK (from_task_id <> to_task_id)`: 공정을 자기 자신과 잇지 못한다.

연결 목록은 연결한 순서(rowid)로 돌려준다. 두 공정의 `parent_id`가 같아야 한다는 규칙(같은 층)은 DB 제약이 아니라 서버가 검사한다(5장).

## 5. 무결성: DB 제약과 서버 검증

순환과 계층 고리, 같은 층 규칙은 여러 행에 걸친 조건이라 DB 제약으로 표현할 수 없다. 서버는 모든 쓰기를 `BEGIN IMMEDIATE` 트랜잭션으로 열고, 그 안에서 현재 상태를 읽어 검사한 뒤 저장한다. 그래서 A → B와 B → A가 동시에 들어와도 하나만 저장되고(ADR-0003, AC-18), 하위 두 개의 완료가 동시에 들어와도 상위 자동 완료를 놓치지 않는다(ADR-0003 1.7).

| 규칙 | DB 제약 | 서버 검증 | 거부할 때 오류 코드 |
| --- | --- | --- | --- |
| 같은 연결 중복 금지 | PK | 저장 전 검사 | `VALIDATION_DUPLICATE_EDGE` |
| 자기 자신 연결 금지 | CHECK | 저장 전 검사 | `VALIDATION_SELF_LOOP` |
| 없는 공정과 연결 금지 | 외래 키 | 저장 전 검사 | `REFERENCE_NOT_FOUND` |
| 다른 프로젝트 공정과 연결 금지 | 복합 외래 키 | 저장 전 검사 | `CROSS_PROJECT_REFERENCE` |
| 다른 층(상위가 다른) 공정과 연결 금지 | 없음 | 저장 전 검사 | `CROSS_LEVEL_DEPENDENCY`(두 공정의 `parentIds` 포함) |
| 순환 금지 | 없음(표현할 수 없음) | 트랜잭션 안에서 검사. 연결이 모두 같은 층 안에 있으므로 전체 검사가 곧 층별 검사다 | `VALIDATION_CYCLE`(순환 경로 포함) |
| 없는 공정을 상위로 지정 금지 | 외래 키 | 저장 전 검사 | `REFERENCE_NOT_FOUND` |
| 다른 프로젝트 공정을 상위로 지정 금지 | 복합 외래 키 | 저장 전 검사 | `CROSS_PROJECT_REFERENCE` |
| 자기 자신을 상위로 지정 금지 | CHECK | 저장 전 검사 | `HIERARCHY_CYCLE` |
| 자손을 상위로 지정 금지 | 없음 | 새 상위부터 조상을 따라 올라가며 검사 | `HIERARCHY_CYCLE`(새 상위부터 옮길 공정까지의 `path` 포함) |
| 연결이 남은 공정의 상위 변경 금지 | 없음 | 이동 요청의 `removeDependencies`로 지우지 않은 연결이 남으면 거부 | `HAS_DEPENDENCIES`(남은 `dependencies` 포함) |
| 실행 상태 값 | CHECK | 저장 전 검사 | `VALIDATION_INPUT` |
| 길이 제한, 링크 형식(http·https) | 없음 | 저장 전 검사 | `VALIDATION_INPUT` |
| 공정을 지울 때 연결·자손 정리 | 외래 키 CASCADE | — | — |

DB 제약은 서버 검증이 놓친 경우를 막는 두 번째 방어선이다. 사용자에게 보이는 오류 문구는 서버 검증에서 나온다.

상위 공정의 자동 전이(PRD §6.9, §13-16 결정 2026-10-25)는 같은 쓰기 트랜잭션 안에서 `tasks.status`를 바꾼다. 바뀐 상위는 응답의 `autoTransitions`로 알린다.

| 무엇이 바뀌었나 | 그 하위의 상위에 적용하는 규칙 |
| --- | --- |
| 하위의 실행 상태 | 하위가 모두 완료면 상위를 완료로(`CHILDREN_DONE`). 아니면, 하위 하나라도 진행 중·완료이고 상위가 미착수일 때 진행 중으로(`CHILD_STARTED`) |
| 하위가 빠짐(삭제, 다른 층으로 이동) | 위와 같다 |
| 하위가 들어옴(생성, 다른 층에서 옮겨 옴) | 진행 중 전환(`CHILD_STARTED`)만. 하위가 늘었다고 일이 끝난 것은 아니라 자동 완료하지 않는다 |

상위가 바뀌면 그 위 상위에도 같은 규칙을 적용한다. 상태를 뒤로 되돌리지는 않는다. 사용자가 상위의 상태를 직접 바꾸면 그 상위는 자기 하위를 보고 다시 바뀌지 않는다.

## 6. 저장하지 않고 계산하는 값

API 응답에는 있지만 테이블에는 없는 값이다. 저장하면 상태나 구조가 바뀔 때마다 함께 고쳐야 하고 어긋날 수 있어서, 조회할 때 계산한다(PRD §7.2, ADR-0003 1.7).

| API 필드 | 계산 방법 |
| --- | --- |
| `jiraKey` | `jira_url`에서 `ABC-123` 꼴의 이슈 키를 꺼낸다. 없으면 null |
| `predecessorIds`, `successorIds` | `dependencies`에서 찾은 직접 선행·후속 공정(같은 층) |
| `inheritedPredecessors` | 조상 공정들의 직접 선행. 가까운 조상부터, 각 항목에 그 선행이 맺힌 조상(`inheritedFrom`)을 적는다(F-H04) |
| `unmetPrerequisiteIds` | 직접 선행과 물려받은 선행 중 `status`가 `done`이 아닌 공정 |
| `prerequisitesMet` | `unmetPrerequisiteIds`가 비어 있는지 |
| `childCount`, `doneChildCount` | 직접 하위 공정 수와 그중 `done`인 수 |
| `inconsistency` | 상위·하위 상태 어긋남. 상위가 완료인데 미완료 하위가 있으면 `PARENT_DONE_CHILD_OPEN`, 하위가 모두 완료인데 상위가 완료가 아니면 `CHILDREN_DONE_PARENT_OPEN`, 아니면 null. 막지 않고 표시만 한다(F-H06) |
| `summary` | 상태별 공정 수. 하위가 있는 공정은 빼고 말단 공정만 센다(F-H09) |

## 7. 저장소 설정과 운영

- 연결할 때마다 `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`을 설정한다. SQLite는 외래 키 검사가 기본으로 꺼져 있다.
- 시각과 ID는 TEXT로 저장한다. SQLite에는 날짜 타입이 없다.
- 스키마 버전은 `PRAGMA user_version`에 둔다. 서버가 시작할 때 버전을 보고 맞춘다.
  - 빈 파일이면 최신 스키마(`SCHEMA`)를 바로 만들고 최신 버전을 적는다.
  - 예전 버전이면 `MIGRATIONS`를 한 단계씩 적용한다. 각 단계는 트랜잭션 하나이고, 커밋 전에 `PRAGMA foreign_key_check`로 외래 키를 확인한다. 실패하면 그 단계가 통째로 되돌려지고 서버가 뜨지 않는다.
  - 올리기 전 파일을 같은 폴더에 `tevro.db.schema{이전 버전}-{시각}.bak`으로 남긴다(`VACUUM INTO`). 확인이 끝나면 지워도 된다.
  - 이 서버보다 새 버전의 파일이면 열지 않는다.
- 버전 이력:

| 버전 | 바뀐 것 | 올리는 방법 |
| --- | --- | --- |
| 1 | 첫 MVP. `user_version`을 쓰지 않아 0으로 남아 있다. 테이블이 있고 `user_version`이 0이면 1로 본다 | — |
| 2 | `tasks.parent_id`, 자기 자신 금지 CHECK, 상위 복합 외래 키, `tasks_by_parent` 인덱스 | 복합 외래 키는 `ALTER TABLE`로 더할 수 없어, SQLite 문서의 12단계 절차대로 `tasks`를 새로 만들어 옮긴다(외래 키 검사를 끈 채로 새 표 생성 → rowid까지 복사 → 옛 표 삭제 → 이름 바꾸기 → 인덱스 재생성 → 외래 키 확인). 기존 공정은 모두 최상위(`parent_id` NULL)가 된다 |

- 새 단계를 더할 때는 `SCHEMA`(새 DB용)와 `MIGRATIONS`(올리기용)를 함께 고치고, 한 번 배포한 단계는 고치지 않는다. `test/migration.test.ts`가 예전 DB를 올린 결과와 새로 만든 DB의 구조가 같은지 확인한다.
- 백업 기능은 아직 없다. 서버를 멈춘 뒤 `data` 폴더를 통째로 복사하면 된다.

## 8. ADR에 있지만 MVP에서 미룬 것

| 항목 | 근거 | 추가될 것 |
| --- | --- | --- |
| 구조 리비전 | ADR-0003 1.1 | `projects.graph_revision` INTEGER |
| 공정 버전(낙관적 잠금) | ADR-0003 1.2 | `tasks.version` INTEGER. 자동 전이 응답의 `version`도 이때 더한다(ADR-0006 §8) |
| 사용자·인증 | ADR-0004 | 사용자, 인증 수단, 세션, 개인 액세스 토큰 테이블과 생성·수정 행위자 컬럼 |
| 노드 좌표 | README의 ADR 후보 '그래프 배치·좌표 저장' | 구조 리비전·버전과 분리한 별도 테이블. 층별 좌표 포함 |
| Jira 매핑 | PRD §6.7(Jira 선택 연동 단계) | 매핑·반영 결과 테이블. MVP의 `jira_url`은 링크일 뿐 매핑이 아니다 |

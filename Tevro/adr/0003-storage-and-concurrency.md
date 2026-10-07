# ADR-0003: 저장소와 동시 수정 모델

- 상태: 제안 (Proposed)
- 작성일: 2026-10-07
- 결정권자: 미정 — 프로젝트 담당자가 지정
- 관련 문서:
  - PRD: [제품 요구사항](../product-requirements.md) §6.1 F-P06·F-P08, §6.2 F-D02·F-D04·F-D06, §6.8 F-C05·F-C08, §7.2, §8 N-04·N-07, §10 AC-04·AC-16·AC-17·AC-18·AC-24, §13-2
  - OSS: [오픈소스와 구현 경계](../open-source-components.md) §5.2, §8.2, §9
  - 선행 ADR: [ADR-0001](./0001-tech-stack.md), [ADR-0002](./0002-deployment-packaging.md)
  - 후속 ADR: [ADR-0004](./0004-authentication-authorization.md), [ADR-0005](./0005-identifiers-and-deletion.md), [ADR-0006](./0006-server-api-contract.md), [ADR-0007](./0007-cli-contract.md)

## 배경

PRD §7.2는 다음 세 가지를 요구한다.

- 삭제되는 공정을 참조하는 연결이 남지 않도록 일관성을 유지한다.
- 오래된 화면이나 에이전트가 다른 사용자의 변경을 무조건 덮어쓰지 않도록 충돌을 식별한다.
- 동시에 들어온 여러 구조 변경도 최종 저장 결과가 DAG 규칙을 만족해야 한다.

§13-2는 저장 방식, 백업·복구, 동시 수정 충돌 처리를 구현 전 결정 사항으로 둔다. F-C05는 동시 수정 충돌을 구분하는 종료 코드를, N-04는 백업·복구를 요구한다. 스키마와 트랜잭션 경계, 충돌 오류가 정해지지 않으면 공정·종속성 API([ADR-0006](./0006-server-api-contract.md))와 CLI 종료 코드([ADR-0007](./0007-cli-contract.md))를 확정할 수 없다.

핵심 함정은 순환 금지가 프로젝트 전체에 걸린 불변식이라는 점이다. 행 단위 잠금이나 유니크 제약만으로는 막을 수 없다. 공정 A, B가 있고 연결이 없는 프로젝트(graph_revision = 7)에서 사용자가 A → B를, 에이전트가 동시에 B → A를 추가하는 경우를 보자.

행 단위 검증만 할 때:

| 시점 | 요청 1(사용자, A → B) | 요청 2(에이전트, B → A) |
| --- | --- | --- |
| t1 | 현재 연결을 읽음: 없음 | 현재 연결을 읽음: 없음 |
| t2 | 순환 없음으로 판정 | 순환 없음으로 판정 |
| t3 | (A, B) 행 삽입. 유니크 제약 통과 | (B, A) 행 삽입. 다른 행이므로 유니크 제약 통과 |
| t4 | 커밋 | 커밋. A → B와 B → A가 함께 저장되어 순환이 생김 |

결과는 F-D04, F-D06, AC-18 위반이다.

프로젝트 단위로 구조 변경을 직렬화할 때:

| 시점 | 요청 1(사용자, A → B) | 요청 2(에이전트, B → A) |
| --- | --- | --- |
| t1 | 프로젝트 잠금 획득 | 같은 프로젝트 잠금을 기다림 |
| t2 | 연결 없음 → A → B 검증 통과 → 삽입 → graph_revision 8 → 커밋, 잠금 해제 | 대기 |
| t3 | — | 잠금 획득 → 연결 A → B를 읽음 → B → A는 순환 → `VALIDATION_CYCLE`(경로 B → A → B)로 거부 |

저장된 그래프에 순환이 없고, 거부된 요청은 이유를 받는다. AC-18을 만족한다.

## 제안하는 결정

### 1. 동시 수정 모델 — 저장소 선택과 무관하게 제안

**1.1 graph_revision: 구조 변경의 직렬화**

- 프로젝트마다 정수 `graph_revision`을 둔다.
- '구조 변경'은 공정 생성·삭제와 종속성 추가·삭제, 그리고 이를 포함한 변경 묶음(change set, ADR-0006)이다.
- 구조 변경은 한 트랜잭션 안에서 다음 순서로 처리한다.
  1. 프로젝트 잠금을 얻는다. PostgreSQL은 프로젝트 행 `SELECT … FOR UPDATE`, SQLite는 `BEGIN IMMEDIATE`로 시작하는 단일 writer다.
  2. 그 프로젝트의 현재 공정·종속성을 읽는다.
  3. 변경을 적용한 최종 상태를 한 번 검증한다(자기 참조, 중복, 존재하지 않는 참조, 다른 프로젝트 참조, 순환).
  4. 쓴다.
  5. `graph_revision`을 1 올린다.
  6. 커밋한다.
- 클라이언트가 기대 리비전(`expectedGraphRevision`)을 보냈는데 현재 값과 다르면 `CONFLICT`로 거부한다. 보내지 않으면 현재 그래프 기준으로 검증만 한다. 검증은 항상 잠금 안에서 하므로 기대 리비전이 없어도 DAG 불변식은 지켜진다.
- 공정 생성도 구조 변경에 넣는다. dry-run과 실제 실행을 묶을 때(ADR-0006) 그 사이에 추가된 공정도 감지해야 하기 때문이다.

**1.2 version: 공정 필드의 낙관적 잠금**

- 공정마다 정수 `version`을 둔다.
- 필드 수정(제목, 설명, 실행 상태, 선택 정보)은 `UPDATE … SET …, version = version + 1 WHERE id = ? AND version = ?`로 처리한다.
- 영향받은 행이 0이면, 공정이 있으면 `CONFLICT`, 없으면 `NOT_FOUND`다. 변경 묶음 안의 `task.update`도 같다([ADR-0005](./0005-identifiers-and-deletion.md) '삭제된 ID의 오류').
- HTTP는 `If-Match`(ETag = version), 변경 묶음은 작업별 `expectedVersion`, CLI는 `--expected-version`으로 기대 버전을 전달한다.
- 필드 수정은 `graph_revision`을 올리지 않는다. 그래서 제목 편집과 종속성 추가가 서로 충돌로 처리되지 않는다.

**1.3 기대 버전 생략 허용 여부 — 결정 필요**

| 방식 | 내용 | 영향 |
| --- | --- | --- |
| 생략 허용(제안) | GUI는 항상 보낸다. CLI·스크립트는 생략할 수 있고, 생략하면 지정한 필드만 바꾸는 부분 수정으로 처리한다. 응답에 새 version을 돌려준다 | 비대화형 스크립트(F-C03)가 쓰기 쉽다. AC-17은 기대 버전을 보낸 요청에 대해서만 보장된다 |
| 항상 필수 | 기대 버전이 없는 수정은 입력 오류로 거부한다 | §7.2를 가장 엄격하게 만족한다. 스크립트는 매번 조회 후 수정해야 한다 |

**1.4 DB 제약으로 한 번 더 막기**

| 제약 | 막는 것 |
| --- | --- |
| 종속성 `UNIQUE(project_id, from_task_id, to_task_id)` | 중복 연결(F-D04, AC-16) |
| 종속성 `CHECK(from_task_id <> to_task_id)` | 자기 참조(F-D04, AC-16) |
| 공정 `UNIQUE(project_id, id)`와 종속성의 `(project_id, from_task_id)`·`(project_id, to_task_id)` 복합 외래 키 | 다른 프로젝트 공정 참조(PRD §6.2 하단, OSS §5.2) |
| 종속성 외래 키 `ON DELETE CASCADE` | 삭제된 공정을 참조하는 연결(§7.2, F-P06) |

순환은 DB 제약으로 표현할 수 없다. 1.1의 잠금 안 검증이 유일한 방어선이다. SQLite는 외래 키 제약이 기본 비활성이며 연결마다 `PRAGMA foreign_keys = ON`으로 켜야 한다. [SQLite 외래 키][sqlite-fk]

**1.5 구조 리비전·버전에서 분리할 데이터**

- 노드 좌표와 Jira 조회 결과(상태 조회 정보, 반영 결과)는 별도 테이블에 두고 `graph_revision`과 `version`을 올리지 않는 방향을 제안한다.
- 노드를 옮기거나 Jira 상태를 새로고침한 것만으로 다른 사용자의 편집이 충돌로 처리되지 않게 하기 위해서다.
- 좌표 저장 여부와 범위는 후속 ADR 후보 '그래프 배치·좌표 저장'에서 정한다([README](./README.md)).

**1.6 접근 경로**

DB에는 서버만 접근한다. CLI와 웹은 서버 API만 쓴다(F-C08, OSS §8.2).

### 2. 저장소 — ADR-0002와 짝으로 선택

ADR-0002의 배포 형태 결과에 맞춰 고르는 것을 제안한다.

| ADR-0002 결과 | 제안 저장소 |
| --- | --- |
| 선택지 A(OCI·OpenShift) | 선택지 A: PostgreSQL |
| 선택지 B(tar.gz 단일 호스트) | 선택지 B: SQLite(WAL, 단일 인스턴스) |

두 DB를 동시에 지원하는 것은 목표로 두지 않을 것을 제안한다. 저장소 접근은 리포지토리 계층으로 감싸 교체 비용만 낮춘다.

저장소별 구현 시 주의점은 다음과 같다.

| 항목 | PostgreSQL | SQLite |
| --- | --- | --- |
| 구조 변경 잠금 | 기본 격리 수준(Read Committed)에서 첫 문장으로 프로젝트 행을 `FOR UPDATE`로 잠근다. 이후 `SELECT`는 문장 시작 시점의 스냅숏을 보므로, 앞선 트랜잭션이 커밋한 연결을 읽는다 [격리 수준][pg-iso], [명시적 잠금][pg-lock] | `BEGIN IMMEDIATE`로 처음부터 쓰기 트랜잭션을 연다. `BEGIN DEFERRED`로 읽은 뒤 쓰면 쓰기 전환에 실패해 `SQLITE_BUSY`가 날 수 있다. 대기 시간(busy timeout)을 설정한다 [SQLite 트랜잭션][sqlite-tx] |
| 대안 | Serializable 격리로 이상을 감지하고, 직렬화 실패 시 재시도한다. 문서는 이 수준을 쓰는 애플리케이션이 재시도에 대비해야 한다고 밝힌다 | 해당 없음(쓰기는 원래 하나씩) |
| 동시성 범위 | 서버 인스턴스 여러 개 가능 | 쓰기 트랜잭션은 한 번에 하나다. 읽기는 쓰기와 동시에 진행된다. 모든 프로세스가 같은 호스트에 있어야 하고 네트워크 파일 시스템은 쓸 수 없다 [SQLite WAL][sqlite-wal] |
| Node.js 드라이버 | 채택 전 확인 | 내장 `node:sqlite`(v22.5.0 추가, 현재 문서 기준 Stability 1.2 Release candidate) 또는 네이티브 애드온. 네이티브 애드온이면 플랫폼별 빌드물을 반입해야 한다 [node:sqlite][node-sqlite] |

### 3. 백업·복구 — 첫 운영 설치 전 완성

착수를 막지는 않지만, 첫 운영 설치 전에 절차 문서와 복구 시험을 마치는 것을 제안한다(N-04, AC-24).

| 저장소 | 백업 방식 |
| --- | --- |
| PostgreSQL | `pg_dump` 논리 백업과 복구 시험 [pg_dump][pg-dump] |
| SQLite | 온라인 백업 API 또는 `VACUUM INTO`로 운영 중인 DB의 사본을 만든다 [VACUUM INTO][sqlite-vacuum], [백업 API][sqlite-backup] |

공통으로 다음을 제안한다.

- 복구 후 프로젝트마다 저장된 그래프의 무결성을 다시 검사하고(`graph validate --project`, ADR-0006), 공정·관계·매핑 수를 백업 시점과 비교한다(AC-24).
- 백업 파일에는 토큰 해시, 세션, 4단계의 Jira 인증값이 들어갈 수 있다. 백업 파일의 접근을 통제한다(F-C09, §7.2).
- 업데이트 전에 백업한다([ADR-0002](./0002-deployment-packaging.md)).

## 검토한 선택지

### 선택지 A: PostgreSQL

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 중간. DB 서버 연결·마이그레이션·권한 설정이 필요하다 |
| 폐쇄망 반입·운영 부담 | 사내 운영 DB 서비스가 있으면 낮다. 없으면 DB 서버 반입·패치·백업 운영이 추가된다 |
| GUI·CLI 동등성(원칙 7) | 영향 없음. 서버만 접근한다 |
| 관련 요구사항 적합성 | 행 잠금으로 1.1을 구현하기 쉽다. 복합 외래 키·CHECK·CASCADE를 지원한다. 서버 인스턴스를 여러 개 둘 수 있다 |
| 팀 숙련도 | 확인 필요 |

장점: 사내 DB 운영 체계(백업·모니터링)를 활용할 수 있다. 가용성 요구가 커져도 대응 여지가 있다.

단점: 사내 DB 서비스가 없으면 운영 구성 요소가 하나 늘어난다.

### 선택지 B: SQLite (WAL, 단일 인스턴스)

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 낮음. DB가 파일 하나다 |
| 폐쇄망 반입·운영 부담 | 별도 DB 서버가 없다. 드라이버가 네이티브 애드온이면 플랫폼별 빌드물 반입이 필요하다 |
| GUI·CLI 동등성(원칙 7) | 영향 없음. 서버만 접근한다 |
| 관련 요구사항 적합성 | 쓰기가 하나씩 처리되므로 1.1 직렬화가 자연스럽다(`BEGIN IMMEDIATE` 필수). 외래 키를 연결마다 켜야 한다. 고가용성과 수평 확장은 없다 |
| 팀 숙련도 | 확인 필요 |

장점: 구성 요소가 가장 적다. 백업이 파일 사본으로 단순하다.

단점: 서버 프로세스 하나에 묶인다. 네트워크 파일 시스템 위에서 쓸 수 없다.

### 참고: 검토했으나 제안하지 않는 동시성 방식

| 방식 | 제안하지 않는 이유 |
| --- | --- |
| 행 단위 낙관적 잠금만 사용 | A → B와 B → A 동시 추가를 막지 못한다(배경의 첫 표) |
| 프로젝트 전체에 버전 하나만 두고 모든 변경을 감지 | 노드 이동, 상태 변경, Jira 새로고침까지 서로 충돌로 처리되어 불필요한 `CONFLICT`가 쏟아진다 |

## 트레이드오프

- 프로젝트 단위 직렬화로 같은 프로젝트의 구조 변경은 한 번에 하나씩 처리된다. 프로젝트당 동시 편집자가 적다면 문제가 없을 것으로 보지만, 예상 규모는 확인이 필요하다.
- 검증할 때마다 프로젝트 그래프 전체를 읽는다. 프로젝트당 공정 수가 작다는 가정에 기대며, 이것도 규모 확인 대상이다.
- 기대 버전 생략을 허용하면 스크립트가 쓰기 쉬운 대신 덮어쓰기 감지가 약해진다(1.3).
- 리포지토리 계층으로 감싸도 DB별 잠금 방식은 다르다. 저장소를 바꾸면 잠금 코드와 시험은 다시 작성해야 한다.

## 결과

쉬워지는 것:

- AC-17(같은 공정 동시 수정)과 AC-18(A → B·B → A 동시 추가)을 시험 가능한 규칙으로 구현할 수 있다.
- 오류 분류의 `CONFLICT`와 CLI 종료 코드 5의 의미가 정해진다(ADR-0006, ADR-0007).
- dry-run과 실제 실행을 `graph_revision`으로 묶을 수 있다(ADR-0006).

어려워지는 것:

- 모든 구조 변경 경로(단건 API, 변경 묶음, 이후 템플릿 적용)가 같은 잠금·검증 경로를 타도록 강제해야 한다(F-D06).
- 좌표와 Jira 조회 결과를 별도 테이블로 분리하는 설계가 필요하다.

다시 검토할 시점:

- 프로젝트당 공정 수나 동시 편집자가 예상보다 커져 잠금 대기가 체감될 때.
- 고가용성 요구가 생겨 SQLite 단일 인스턴스로 부족할 때.
- 프로젝트를 가로지르는 연결(PRD §6.2 하단, 이후 검토)을 도입할 때. 직렬화 범위를 프로젝트보다 넓혀야 한다.

## 채택 전 확인할 사항

| 항목 | 확인 대상 |
| --- | --- |
| 사내 운영 PostgreSQL 유무, 지원 버전, 백업 정책, 접속 방식 | 사내 DB 담당 |
| 예상 규모: 동시 사용자 수, 프로젝트 수, 프로젝트당 공정·연결 수 | 프로젝트 담당자 |
| 백업 보관 위치·주기·보존 기간과 복구 목표 시간에 대한 사내 기준 | 사내 인프라·보안 담당 |
| 기대 버전 생략 허용 여부(1.3) | 프로젝트 담당자, 에이전트 사용 담당 |
| 선택지 B일 때 영속 디스크가 로컬 디스크인지 | 사내 인프라 담당 |

## 후속 작업

- [ ] 스키마 초안을 만든다: 프로젝트(`graph_revision`), 공정(`version`), 종속성(1.4 제약).
- [ ] 구조 변경 트랜잭션을 공용 서비스 함수 하나로 구현하고 모든 경로가 이를 쓰게 한다.
- [ ] AC-17·AC-18 동시성 시험을 자동화한다(두 요청을 동시에 보내는 시험).
- [ ] 좌표·Jira 조회 결과 분리는 후속 ADR 후보로 넘긴다.
- [ ] 첫 운영 설치 전에 백업·복구 절차를 문서화하고 AC-24 복구 시험을 한다.
- [ ] 채택하면 PRD §13-2를 갱신한다.

## 출처

2026-10-07에 확인했다.

- [PostgreSQL 트랜잭션 격리 수준][pg-iso]
- [PostgreSQL 명시적 잠금 — FOR UPDATE][pg-lock]
- [PostgreSQL pg_dump][pg-dump]
- [SQLite Write-Ahead Logging][sqlite-wal]
- [SQLite BEGIN TRANSACTION][sqlite-tx]
- [SQLite 외래 키 지원][sqlite-fk]
- [SQLite VACUUM INTO][sqlite-vacuum]
- [SQLite 온라인 백업 API][sqlite-backup]
- [Node.js node:sqlite][node-sqlite]

[pg-iso]: https://www.postgresql.org/docs/current/transaction-iso.html
[pg-lock]: https://www.postgresql.org/docs/current/explicit-locking.html
[pg-dump]: https://www.postgresql.org/docs/current/app-pgdump.html
[sqlite-wal]: https://www.sqlite.org/wal.html
[sqlite-tx]: https://www.sqlite.org/lang_transaction.html
[sqlite-fk]: https://www.sqlite.org/foreignkeys.html
[sqlite-vacuum]: https://www.sqlite.org/lang_vacuum.html
[sqlite-backup]: https://www.sqlite.org/backup.html
[node-sqlite]: https://nodejs.org/api/sqlite.html

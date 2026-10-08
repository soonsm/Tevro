# ADR-0002: 폐쇄망 배포 형태와 반입 경로

- 상태: 채택 (Accepted)
- 작성일: 2026-10-07
- 개정: 2026-10-08 ADR-0001 채택(React) 반영
- 결정일: 2026-10-08
- 결정권자: 프로젝트 담당자(soonsm)
- 관련 문서:
  - PRD: [제품 요구사항](../product-requirements.md) §8 N-01·N-02·N-03·N-04·N-08과 마지막 문단, §10 AC-14·AC-24, §13-1
  - OSS: [오픈소스와 구현 경계](../open-source-components.md) §11.1, §11.2, §12 '폐쇄망' 행
  - 선행 ADR: [ADR-0001](./0001-tech-stack.md)
  - 짝을 이루는 ADR: [ADR-0003](./0003-storage-and-concurrency.md)(저장소)
  - 연계 ADR: [ADR-0004](./0004-authentication-authorization.md)(HTTPS와 세션 쿠키), [ADR-0007](./0007-cli-contract.md)(CLI 배포 형태)

## 배경

이 ADR 작성 당시(2026-10-07) N-03은 '배포 포맷과 내부 레지스트리 활용 방식은 미정'이라고 적었다. 현재 N-03은 이 ADR의 결정을 반영했다. PRD §8 마지막 문단은 컨테이너·OpenShift 사용 여부를 확정하지 않는다. §13-1은 배포·업데이트 방식과 폐쇄망 반입 경로를 구현 전 결정 사항으로 둔다.

가정을 두고 코딩을 시작할 수는 있다. 그래도 이 결정을 크리티컬 패스 앞단에 두는 이유는 세 가지다.

1. 저장소 선택([ADR-0003](./0003-storage-and-concurrency.md))이 배포 대상에 묶인다. 사내 PostgreSQL 운영 서비스가 있는지에 따라 달라진다. 또 컨테이너 플랫폼의 영속 볼륨이 네트워크 파일 시스템이면 SQLite WAL을 쓸 수 없다. SQLite 문서는 WAL이 네트워크 파일 시스템에서 동작하지 않는다고 밝힌다. [SQLite WAL][sqlite-wal]
2. 내부 npm·OCI 레지스트리가 있는지에 따라 개발을 망 안에서 할지 밖에서 할지, 의존성을 얼마나 줄일지가 정해진다.
3. 오픈소스 라이선스·반입 승인은 리드타임이 가장 긴 경로일 수 있다. 사내 승인 절차와 리드타임은 아직 확인하지 않았다('남은 확인 사항'). 승인 때 확인할 라이선스 범위는 OSS §11.1에 있다.

초기 핵심의 서버·웹을 검증하려면(N-01~N-03, AC-14) 첫 망 내 설치 전에 이 결정이 필요하다. 사내 정책상 승인 전에는 개발 단계에서도 오픈소스를 쓸 수 없다면 이 ADR의 우선순위를 더 높여야 한다.

## 결정

2026-10-08 결정권자가 선택지 B(Node.js 런타임 동봉 tar.gz + systemd 단일 프로세스)를 채택했다. 저장소는 같은 호스트 로컬 디스크의 SQLite와 짝을 이룬다(저장소 자체는 [ADR-0003](./0003-storage-and-concurrency.md)에서 정한다). 아래 공통 규칙도 함께 채택했다.

결정권자가 명시적으로 답한 범위는 배포 형태(B), '컨테이너 대비'의 네 규칙과 이전 조건, 공통 규칙이다. '업데이트·롤백'과 '라이선스·반입 승인 병행 착수'는 결정권자가 따로 답하지 않았다. 채택 범위에 드는지 확인할 때까지 제안 문구로 둔다.

결정 때 같은 호스트에 PostgreSQL을 직접 설치하는 안(B + PostgreSQL 직접 설치)도 제시됐으나 선택되지 않았다. 선택하지 않은 사유는 기록되지 않았다.

결정 시점에 결정권자가 답한 환경 상태는 다음과 같다.

| 환경 | 결정 시점 상태 | 영향 |
| --- | --- | --- |
| 사내 PostgreSQL(사내 DB 서비스 또는 플랫폼 안 운영) | 쓸 수 없음 | A + PostgreSQL 조합이 성립하지 않는다. 저장소는 SQLite 쪽으로 좁혀진다 |
| 개발 PC용 내부 npm 미러 | 있음 | 개발 PC는 미러로 의존성을 받을 수 있다. 개발 단계에도 반입 승인이 필요한지는 '남은 확인 사항'이다 |
| 컨테이너 플랫폼(OpenShift 등)과 내부 OCI 레지스트리 | 모름. 확인 대기 | B를 첫 배포 형태로 하고, 아래 '컨테이너 대비' 규칙으로 이전 여지를 남긴다 |

### 컨테이너 대비

컨테이너 플랫폼 사용이 사내 정책상 필수로 확인되면 실행 구조를 바꾸지 않고 이미지와 배포 정의를 더해 옮길 수 있도록, 앱을 처음부터 다음 형태로 만든다. 옮길 때는 내부 OCI 레지스트리와 아래 SQLite 유지 조건도 갖춰야 한다. 결정권자가 정한 규칙은 다음 네 가지다.

| 규칙 | 이유 |
| --- | --- |
| 서버·정적 자산·백그라운드 작업을 프로세스 하나로 실행한다 | systemd 서비스와 컨테이너 모두 같은 실행 단위가 된다 |
| 설정을 환경변수로 받는다. 설정 파일과 비밀값은 공통 규칙을 따른다 | OpenShift 이미지 지침은 실행 설정을 환경변수로 받으라고 권한다(4.1.2.5) [OpenShift 이미지 지침][ocp-images]. systemd 서비스는 `Environment=`·`EnvironmentFile=`로 환경변수를 넘긴다 [systemd.exec][systemd-exec] |
| 데이터 디렉터리(SQLite 파일, 백업 위치)를 설정으로 지정한다. 앱 설치 경로에 쓰지 않는다 | 영속 볼륨을 붙이는 위치를 분리한다 |
| 특정 UID·root 권한을 가정하지 않는다. 쓰기 위치는 데이터 디렉터리뿐이다 | OpenShift는 기본적으로 임의로 배정한 UID로 컨테이너를 실행한다. 이 사용자는 항상 root 그룹에 속하므로, 이미지의 쓰기 디렉터리는 root 그룹이 읽고 쓸 수 있어야 한다(4.1.2.2) [OpenShift 이미지 지침][ocp-images] |

다음 두 항목은 작성자가 더한 제안이다. 결정권자가 답하지 않았으므로 채택 범위가 아니며, 확인 전까지 제안으로 둔다.

| 제안 | 이유 |
| --- | --- |
| 로그는 표준 출력·표준 오류로 낸다 | OpenShift 이미지 지침은 로그를 모두 표준 출력으로 보내라고 권한다(4.1.2.8) [OpenShift 이미지 지침][ocp-images]. systemd 서비스의 표준 출력·표준 오류는 기본 설정에서 저널(journald)로 간다 [systemd.exec][systemd-exec] |
| 종료 신호(SIGTERM)를 받으면 진행 중인 쓰기를 마치고 종료한다 | systemd는 서비스를 멈출 때 기본으로 SIGTERM을 보내고, 보통 SIGKILL이 뒤따른다 [systemd.kill][systemd-kill]. Kubernetes도 파드를 종료할 때 각 컨테이너의 주 프로세스에 TERM 신호를 보내고, 유예 시간이 지나면 KILL 신호를 보낸다 [파드 종료][k8s-pod-termination]. SIGTERM을 처리하면 두 경우 모두 강제 종료 전에 SQLite 쓰기를 마무리할 수 있다 |

컨테이너로 옮길 때 SQLite를 유지하려면 두 조건이 필요하다. 영속 볼륨이 네트워크 파일 시스템이 아닌 블록 볼륨(단일 노드 쓰기)이어야 하고, 인스턴스는 하나여야 한다. SQLite WAL은 네트워크 파일 시스템에서 동작하지 않는다. [SQLite WAL][sqlite-wal]

### 제안 단계의 선택 기준(기록)

채택 전에는 환경 사실을 먼저 확인하고 그 결과로 A 또는 B를 고르는 것을 제안했다.

| 확인된 환경 | 제안 |
| --- | --- |
| OpenShift 또는 운영 중인 컨테이너 런타임과 내부 OCI 레지스트리가 있음 | 선택지 A. 저장소는 PostgreSQL과 짝([ADR-0003](./0003-storage-and-concurrency.md) 선택지 A) |
| 컨테이너 플랫폼이 없거나 반입·운영 지원을 받기 어려움 | 선택지 B. 저장소는 SQLite와 짝(ADR-0003 선택지 B) |

### 공통 규칙 — 채택

두 선택지에 공통으로 적용한다.

| 규칙 | 근거 |
| --- | --- |
| JavaScript·CSS·폰트·아이콘 등 실행 자산을 배포물에 포함한다. 외부 CDN·웹 폰트를 쓰지 않는다. 글꼴은 시스템 글꼴을 우선하고, 글꼴 파일을 번들하면 라이선스를 확인한다 | N-02, OSS §11.1, §11.2 |
| 콘텐츠 보안 정책(CSP)으로 외부 출처의 스크립트·스타일·글꼴 로드를 막아, N-02 위반이 브라우저 오류로 드러나게 한다 | N-02 |
| 의존성 버전과 잠금 파일을 고정해 재현 가능하게 빌드한다. 배포물에 버전, 소스 커밋, 의존성 목록을 함께 넣는다 | N-03, OSS §11.1 |
| 사내 CA는 신뢰 목록에 '추가'한다. 인증서 검증을 끄는 설정을 배포 문서나 설정 예시에 넣지 않는다 | N-08, OSS §11.2 |
| 일반 설정은 환경변수 또는 설정 파일로 받는다. DB 비밀번호·세션 서명 키 같은 비밀값은 별도 비밀 저장(OpenShift Secret 또는 권한 600 파일)으로 받는다 | F-C09, §7.2 |
| 상태 확인 엔드포인트(예: `/healthz`)를 제공한다 | 운영 |
| 외부 인터넷을 차단한 환경에서 설치·실행을 실제로 시험한다 | AC-14, OSS §11.2 |

### 사내 CA 주입

Tevro 서버가 사내 시스템(4단계의 Jira 등)을 호출할 때의 신뢰 설정이다. Node.js 서버(ADR-0001 선택지 A) 기준으로 확인한 사실은 다음과 같다. [Node.js CLI 문서][node-cli]

| 방법 | 동작 | 비고 |
| --- | --- | --- |
| `NODE_EXTRA_CA_CERTS=<PEM 파일>` | 기본 루트 CA 목록에 파일의 인증서를 추가한다 | 프로세스 시작 시에만 읽는다. TLS 클라이언트에 `ca` 옵션을 직접 지정하면 기본·추가 인증서가 모두 쓰이지 않으므로, 코드에서 `ca`를 덮어쓰지 않는다 |
| `--use-system-ca` 또는 `NODE_USE_SYSTEM_CA=1` | OS 신뢰 저장소의 인증서를 함께 쓴다 | 문서상 `--use-system-ca`는 v23.8.0, `NODE_USE_SYSTEM_CA=1`은 v24.6.0·v22.19.0에 추가되었다. 사내 CA가 서버 OS에 이미 설치되어 있다면 검토한다 |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | 인증서 검증을 끈다 | 문서도 사용을 강하게 말린다. N-08에 따라 쓰지 않는다 |

브라우저에서 Tevro로 들어오는 HTTPS의 서버 인증서는 별개의 문제다. 어디서 TLS를 종단할지(Tevro 자체, 리버스 프록시, OpenShift Route)는 확인 사항으로 둔다. 웹 세션 쿠키의 Secure 속성([ADR-0004](./0004-authentication-authorization.md))이 HTTPS를 전제로 한다.

### 업데이트·롤백 — 제안(결정권자 확인 전)

세부 절차(마이그레이션 자동 실행 여부, 롤백 시 DB 복구 순서)는 첫 운영 설치 전까지 이월할 수 있다고 제안한다. 원칙만 지금 정해 둔다.

- 업데이트 전에 백업한다([ADR-0003](./0003-storage-and-concurrency.md)).
- 스키마 마이그레이션은 앞으로만 진행한다.
- 롤백은 이전 배포물과 업데이트 전 백업의 복구로 한다.

### 라이선스·반입 승인 병행 착수 — 제안(결정권자 확인 전)

지금 승인 요청을 시작하는 것을 제안한다. 아래 라이선스는 2026-10-07 npm 메타데이터 기준이다(`@xyflow/react`·`react`·`react-dom`은 2026-10-08 기준). 반입할 릴리스의 LICENSE 파일과 전이 의존성으로 다시 확인한다(OSS §11.1).

| 패키지 | 확인한 버전 | 라이선스 | 용도 |
| --- | --- | --- | --- |
| `@xyflow/react` | 12.12.0 | MIT | 그래프 편집 |
| `react` | 19.3.0 | MIT | 웹 UI. `@xyflow/react`의 peer 의존성(`>=17`) |
| `react-dom` | 19.3.0 | MIT | 웹 UI. `@xyflow/react`의 peer 의존성(`>=17`). 자신은 `react` `^19.3.0`을 요구 |
| `@dagrejs/dagre` | 3.1.1 | MIT | 자동 배치 |
| `commander` | 15.0.0 | MIT | CLI 명령 해석 |
| `@dagrejs/graphlib`(필요 시) | 4.0.5 | MIT | 그래프 알고리즘 |

나중에 선택지 A로 옮기게 되면 컨테이너 기반 이미지의 사내 표준과 승인 여부도 함께 확인한다.

## 검토한 선택지

### 선택지 A: OCI 이미지 + 내부 레지스트리 + OpenShift/컨테이너 런타임 — 채택하지 않음(이전 경로로 유지)

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 중간. 이미지 빌드와 배포 정의(매니페스트)를 작성해야 한다 |
| 폐쇄망 반입·운영 부담 | 이미지 하나(서버 + 웹 정적 자산)를 내부 레지스트리에 반입한다. 기반 이미지의 패치 주기를 관리해야 한다. 플랫폼 운영은 사내 담당 조직에 기댈 수 있다 |
| GUI·CLI 동등성(원칙 7) | 영향 없음. CLI 배포는 ADR-0007에서 정한다 |
| 관련 요구사항 적합성 | N-01~N-03을 충족할 수 있다. N-04는 외부 DB 또는 영속 볼륨이 필요하므로 PostgreSQL과 짝을 이룬다. OpenShift는 기본적으로 임의로 배정한 UID로 컨테이너를 실행하므로, 쓰기 디렉터리를 root 그룹이 읽고 쓸 수 있게 이미지를 만들어야 한다 [OpenShift 이미지 지침][ocp-images] |
| 팀 숙련도 | 확인 필요 |

장점:

- 사내 표준 플랫폼이 있다면 배포·재시작·로그 수집을 플랫폼에 맡긴다.
- PostgreSQL과 함께라면 여러 인스턴스로 늘릴 여지가 있다.

단점:

- 플랫폼이 없으면 도입 비용이 크다.
- 영속 볼륨이 네트워크 파일 시스템이면 SQLite를 쓸 수 없다.

### 선택지 B: Node.js 런타임 동봉 tar.gz + systemd 단일 프로세스 — 채택

| 기준 | 평가 |
| --- | --- |
| 복잡도 | 낮음. 압축 파일 하나와 서비스 정의 파일 하나다 |
| 폐쇄망 반입·운영 부담 | 반입물이 가장 단순하다(Node.js 런타임 + 앱 + 정적 자산). 대신 Node.js 런타임과 OS 패치는 Tevro 운영 담당이 직접 챙긴다 |
| GUI·CLI 동등성(원칙 7) | 영향 없음 |
| 관련 요구사항 적합성 | N-01~N-03을 충족한다. 로컬 디스크의 SQLite와 짝을 이룬다(ADR-0003). 단일 호스트라 고가용성은 없다. 사내 PostgreSQL에 접근할 수 있으면 B + PostgreSQL 조합도 가능하다 |
| 팀 숙련도 | 확인 필요 |

장점:

- 컨테이너 플랫폼 없이도 가장 빨리 망 내에 설치할 수 있다.
- 구성 요소가 적다.

단점:

- 대상 서버의 OS·아키텍처를 Node.js 공식 바이너리가 지원하는지 확인해야 한다.
- 서버 장애 시 복구와 모니터링을 직접 마련해야 한다.

### 배포 형태와 저장소의 짝

| 조합 | 성립 조건 | 제안 | 결정 시점 판단(2026-10-08) |
| --- | --- | --- | --- |
| A + PostgreSQL | 사내 운영 DB 또는 플랫폼 안의 PostgreSQL | 기본 짝 | 사내 PostgreSQL을 쓸 수 없어 성립하지 않는다 |
| B + SQLite | 로컬 디스크, 서버 프로세스 하나 | 기본 짝 | 배포 형태 B를 채택했고, 이 조합이 B의 기본 짝이다. 저장소 확정은 [ADR-0003](./0003-storage-and-concurrency.md)에서 한다 |
| B + PostgreSQL | 사내 PostgreSQL 접근 가능 | 가능 | 사내 PostgreSQL을 쓸 수 없어 성립하지 않는다. 같은 호스트에 PostgreSQL을 직접 설치하는 안도 제시됐으나 선택되지 않았다. 선택하지 않은 사유는 기록되지 않았다 |
| A + SQLite | 인스턴스 1개, 네트워크 파일 시스템이 아닌 볼륨 | 조건 확인 부담이 커서 제안하지 않음 | 컨테이너 플랫폼 사용이 필수로 확인될 때의 이전 경로로 둔다. 조건은 블록 볼륨과 단일 인스턴스다 |

## 트레이드오프

- A는 플랫폼에 운영을 맡기는 대신 이미지·매니페스트 작성과 기반 이미지 관리가 늘어난다.
- B는 반입과 설치가 가장 단순한 대신 런타임 패치, 재시작, 모니터링을 Tevro 쪽에서 직접 맡는다.
- 업데이트·롤백 세부를 이월하면 착수가 빨라지는 대신, 첫 운영 설치 직전에 마이그레이션·백업 절차를 서둘러 정해야 할 위험이 있다.
- 공통 규칙(CSP, 자산 번들, 버전 고정)은 초기 개발 속도를 약간 늦추지만 AC-14 시험에서 뒤늦게 발견되는 문제를 줄인다.

## 결과

쉬워지는 것:

- ADR-0003의 저장소 선택이 환경 사실로 좁혀진다.
- 반입 승인 요청을 지금 시작할 수 있다.
- AC-14(인터넷 차단 환경) 시험 조건이 명확해진다.

어려워지는 것:

- 운영 문서와 시험 환경을 B 기준으로 준비해야 한다. 두 형태를 모두 지원하는 것은 목표로 하지 않는다.
- 나중에 A로 옮기게 되면 OpenShift 보안 정책(임의 UID 등)에 맞춘 이미지 작성이 필요하다.

다시 검토할 시점:

- 사내에 컨테이너 플랫폼이 새로 도입되거나 폐지될 때.
- 컨테이너 플랫폼 사용 가능 여부와 필수 여부가 확인될 때. 사내 정책상 필수라면 '컨테이너 대비' 규칙과 A + SQLite 조건(블록 볼륨, 단일 인스턴스)으로 이전한다. 이전할 때는 새 ADR을 써서 이 ADR을 대체한다([README §1](./README.md)).
- 사내 PostgreSQL을 쓸 수 있게 될 때.
- 사용자 수가 늘어 단일 호스트(B)로 가용성 요구를 맞추기 어려울 때.
- 첫 운영 설치 전: 업데이트·롤백 세부 절차를 확정한다.

## 남은 확인 사항

결정 시점에 답을 받은 항목(사내 PostgreSQL 쓸 수 없음, 개발 PC용 내부 npm 미러 있음)은 '결정' 절에 기록했다. 나머지는 첫 망 내 설치 전에 확인한다.

| 항목 | 확인 대상 |
| --- | --- |
| 내부 OCI 레지스트리 유무 | 사내 인프라 담당 |
| OpenShift·컨테이너 런타임 사용 가능 여부와 사용이 필수인지, 운영 담당 조직, 영속 볼륨 종류(블록 볼륨인지 네트워크 파일 시스템인지) | 사내 플랫폼 담당 |
| 사내 CA 번들의 위치·형식(PEM 여부)과 서버 OS 신뢰 저장소 설치 여부 | 사내 보안·인프라 담당 |
| 브라우저→Tevro HTTPS 종단 위치와 서버 인증서 발급 절차 | 사내 인프라 담당 |
| 대상 서버의 OS·아키텍처 | 사내 인프라 담당 |
| 오픈소스 반입 승인 절차와 리드타임, 개발 단계에도 승인이 필요한지 | 사내 보안·법무 담당 |
| 반입 매체와 절차(파일 반입 승인, 크기 제한) | 사내 보안 담당 |
| 선택지 A로 옮길 경우 기반 이미지 사내 표준 | 사내 플랫폼 담당 |

## 후속 작업

- [x] 선택지를 고른다(2026-10-08, B 채택).
- [ ] 컨테이너 플랫폼 사용 가능 여부와 필수 여부를 확인한다.
- [ ] 결정권자에게 작성자 추가 제안(로그 표준 출력, SIGTERM 처리)과 '업데이트·롤백'·'라이선스·반입 승인 병행 착수'가 채택 범위인지 확인한다.
- [ ] '컨테이너 대비' 규칙을 스파이크 서버 구조에 적용한다.
- [ ] 대상 서버 OS·아키텍처를 확인하고 동봉할 Node.js 26 공식 바이너리를 정한다.
- [ ] 오픈소스 라이선스·반입 승인 요청을 지금 시작한다(위 표의 패키지와 전이 의존성).
- [ ] 배포물에 넣을 의존성 목록(SBOM) 생성 방식을 정한다.
- [ ] 인터넷 차단 환경에서 설치·실행 시험 절차를 만든다(AC-14).
- [ ] CSP 헤더와 정적 자산 번들 규칙을 스파이크에 적용한다.
- [ ] 첫 운영 설치 전에 업데이트·롤백 절차를 확정한다.
- [x] PRD §13-1(배포 부분)과 N-03 비고를 갱신한다(2026-10-08).

## 출처

2026-10-07에 확인했다. `@xyflow/react`, `react`, `react-dom`의 npm 메타데이터, OpenShift 이미지 지침 4.1.2.5·4.1.2.8, systemd·Kubernetes 문서는 2026-10-08에 확인했다.

- [SQLite Write-Ahead Logging][sqlite-wal]
- [Node.js CLI 문서 — NODE_EXTRA_CA_CERTS, --use-system-ca, NODE_USE_SYSTEM_CA, NODE_TLS_REJECT_UNAUTHORIZED][node-cli]
- [OpenShift Container Platform 4.18 Images — 4.1.2.2 Support arbitrary user ids, 4.1.2.5 Use environment variables for configuration, 4.1.2.8 Logging][ocp-images]
- [systemd.exec — Environment=, EnvironmentFile=, StandardOutput=, StandardError=][systemd-exec]
- [systemd.kill — KillSignal=][systemd-kill]
- [Kubernetes Pod Lifecycle — Termination of Pods][k8s-pod-termination]
- npm 메타데이터: [@xyflow/react][npm-xyflow-react], [react][npm-react], [react-dom][npm-react-dom], [@dagrejs/dagre][npm-dagre], [commander][npm-commander], [@dagrejs/graphlib][npm-graphlib]

[sqlite-wal]: https://www.sqlite.org/wal.html
[node-cli]: https://nodejs.org/api/cli.html
[ocp-images]: https://docs.redhat.com/en/documentation/openshift_container_platform/4.18/html-single/images/index
[systemd-exec]: https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html
[systemd-kill]: https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html
[k8s-pod-termination]: https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination
[npm-xyflow-react]: https://registry.npmjs.org/@xyflow/react
[npm-react]: https://registry.npmjs.org/react
[npm-react-dom]: https://registry.npmjs.org/react-dom
[npm-dagre]: https://registry.npmjs.org/@dagrejs/dagre
[npm-commander]: https://registry.npmjs.org/commander
[npm-graphlib]: https://registry.npmjs.org/@dagrejs/graphlib
